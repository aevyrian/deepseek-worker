import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_DEFINITIONS,
  buildRootOrchestratorInstructions,
  resolveOrchestratorConfig,
  runCloudOrchestrator,
} from "../cloud/openai-orchestrator.mjs";

const PROJECT = {
  project_id: "project-1",
  goal: "Build a small novel site",
  acceptance_criteria: ["API tested", "UI tested"],
  revision: 4,
};

const EVENTS = [{
  event_id: "evt-1",
  task_id: "task-1",
  name: "task.completed",
  summary: "Task completed",
  project_revision: 4,
}];

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("orchestrator config uses env overrides without hard-coding the deployment model", () => {
  const config = resolveOrchestratorConfig({
    OPENAI_API_KEY: "sk-test",
    ORCHESTRATOR_MODEL: "custom-model",
    ORCHESTRATOR_TIMEOUT_MS: "45000",
    ORCHESTRATOR_MAX_ROUNDS: "9",
  });
  assert.deepEqual(config, {
    apiKey: "sk-test",
    model: "custom-model",
    timeoutMs: 45_000,
    maxRounds: 9,
  });
});

test("root prompt explicitly forbids polling and filler parallelism", () => {
  const prompt = buildRootOrchestratorInstructions();
  assert.match(prompt, /Do not wait or poll/u);
  assert.match(prompt, /never task count for its own sake/u);
  assert.match(prompt, /Avoid concurrent writers/u);
});

test("all Responses function tools use strict JSON schemas", () => {
  assert.ok(TOOL_DEFINITIONS.length >= 5);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, "function");
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test("Responses tool loop reads a result and dispatches independent work", async () => {
  const requests = [];
  const responses = [
    {
      id: "resp-1",
      output: [
        {
          type: "function_call",
          call_id: "call-read",
          name: "read_result",
          arguments: JSON.stringify({ task_id: "task-1" }),
        },
        {
          type: "function_call",
          call_id: "call-submit",
          name: "submit_task",
          arguments: JSON.stringify({
            role: "frontend",
            prompt: "Implement the isolated frontend shell.",
            context: null,
            route: "local",
          }),
        },
      ],
    },
    {
      id: "resp-2",
      output_text: "Read the finished analysis and dispatched the newly unlocked frontend task.",
      output: [],
    },
  ];

  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return jsonResponse(responses.shift());
  };

  const toolCalls = [];
  const result = await runCloudOrchestrator({
    project: PROJECT,
    pendingEvents: EVENTS,
    projectTasks: [{ task_id: "task-1", role: "analysis", status: "completed" }],
    triggerReason: "no_active_subscription",
    runId: "run-1",
    config: {
      apiKey: "sk-test",
      model: "model-test",
      timeoutMs: 20_000,
      maxRounds: 6,
    },
    fetchImpl,
    executeTool: async (name, args, meta) => {
      toolCalls.push({ name, args, meta });
      if (name === "read_result") return { task_id: "task-1", result: "analysis ok" };
      if (name === "submit_task") return { id: "task-new", status: "queued" };
      throw new Error("unexpected tool");
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.created_task_ids, ["task-new"]);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].meta.requestKey, "orchestrator:project-1:run-1:0:read_result");
  assert.equal(toolCalls[1].meta.requestKey, "orchestrator:project-1:run-1:1:submit_task");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "model-test");
  assert.equal(requests[0].parallel_tool_calls, true);
  assert.equal(requests[1].previous_response_id, "resp-1");
  assert.deepEqual(
    requests[1].input.map((item) => item.call_id),
    ["call-read", "call-submit"],
  );
});

test("request_user_decision stops autonomous scheduling without calling application tools", async () => {
  const responses = [
    {
      id: "resp-1",
      output: [{
        type: "function_call",
        call_id: "call-user",
        name: "request_user_decision",
        arguments: JSON.stringify({
          question: "Which paid provider should be purchased?",
          reason: "This creates a new paid account.",
        }),
      }],
    },
    {
      id: "resp-2",
      output_text: "Waiting for the user decision.",
      output: [],
    },
  ];

  let appToolCalls = 0;
  const result = await runCloudOrchestrator({
    project: PROJECT,
    pendingEvents: EVENTS,
    projectTasks: [],
    triggerReason: "no_active_subscription",
    runId: "run-user",
    config: {
      apiKey: "sk-test",
      model: "model-test",
      timeoutMs: 20_000,
      maxRounds: 6,
    },
    fetchImpl: async () => jsonResponse(responses.shift()),
    executeTool: async () => {
      appToolCalls += 1;
      throw new Error("should not run");
    },
  });

  assert.equal(appToolCalls, 0);
  assert.equal(result.status, "needs_user");
  assert.deepEqual(result.user_decision, {
    question: "Which paid provider should be purchased?",
    reason: "This creates a new paid account.",
  });
});

test("a Responses API failure after a successful submit preserves created task IDs for idempotent recovery", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return jsonResponse({
        id: "resp-1",
        output: [{
          type: "function_call",
          call_id: "call-submit",
          name: "submit_task",
          arguments: JSON.stringify({
            role: "backend",
            prompt: "Implement backend endpoint.",
            context: null,
            route: "local",
          }),
        }],
      });
    }
    return jsonResponse({ error: { message: "temporary outage" } }, 503);
  };

  await assert.rejects(
    () => runCloudOrchestrator({
      project: PROJECT,
      pendingEvents: EVENTS,
      projectTasks: [],
      triggerReason: "no_active_subscription",
      runId: "run-recovery",
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl,
      executeTool: async (name, _args, meta) => {
        assert.equal(name, "submit_task");
        assert.equal(meta.requestKey, "orchestrator:project-1:run-recovery:0:submit_task");
        return { id: "task-partial", status: "queued" };
      },
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.deepEqual(error.created_task_ids, ["task-partial"]);
      return true;
    },
  );
});
