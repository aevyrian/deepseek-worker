import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventCore } from "../cloud/event-core.mjs";
import {
  deriveCloudRunId,
  makeInternalToolExecutor,
  runDualModeOrchestration,
} from "../cloud/dual-mode-orchestrator.mjs";

const OWNER = "owner-1";
const PROJECT = "project-1";
const EVENT_TIME = new Date("2026-10-06T12:00:00Z");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function createStore({ mode = "auto", graceMs = 30_000 } = {}) {
  const core = new InMemoryEventCore();
  core.createProject({
    projectId: PROJECT,
    owner: OWNER,
    goal: "Build a novel site",
    acceptanceCriteria: ["tests pass"],
    now: new Date("2026-10-06T11:00:00Z"),
  });
  core.attachTask({
    projectId: PROJECT,
    taskId: "task-1",
    owner: OWNER,
    role: "analysis",
    now: new Date("2026-10-06T11:30:00Z"),
  });
  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-1",
    owner: OWNER,
    status: "completed",
    summary: "analysis complete",
    resultAvailable: true,
    occurredAt: EVENT_TIME,
  });

  core.getOrchestrationConfig = async () => ({
    mode,
    native_grace_ms: graceMs,
  });
  core.runRecords = [];
  core.recordOrchestratorRun = async (entry) => {
    core.runRecords.push(structuredClone(entry));
  };
  return core;
}

function successFetchWithSubmit(requests = []) {
  let count = 0;
  return async (_url, init) => {
    requests.push(JSON.parse(init.body));
    count += 1;
    if (count === 1) {
      return jsonResponse({
        id: "resp-1",
        output: [{
          type: "function_call",
          call_id: "call-submit",
          name: "submit_task",
          arguments: JSON.stringify({
            role: "frontend",
            prompt: "Implement isolated frontend.",
            context: null,
            route: "local",
          }),
        }],
      });
    }
    return jsonResponse({
      id: "resp-2",
      output_text: "Dispatched frontend.",
      output: [],
    });
  };
}

test("cloud run ID is deterministic for the same pending event set", () => {
  assert.equal(
    deriveCloudRunId(PROJECT, ["evt-b", "evt-a", "evt-b"]),
    deriveCloudRunId(PROJECT, ["evt-a", "evt-b"]),
  );
});

test("internal write tools receive project, lease holder, and stable request key", async () => {
  let observed;
  const execute = makeInternalToolExecutor({
    projectId: PROJECT,
    holder: "holder-1",
    handlers: {
      submit_task: async (args) => {
        observed = args;
        return { id: "task-new" };
      },
      read_result: async () => ({ result: "ok" }),
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
  });

  await execute("submit_task", {
    role: "backend",
    prompt: "Implement backend",
    context: null,
    route: "local",
  }, {
    requestKey: "stable-key",
  });

  assert.equal(observed.project_id, PROJECT);
  assert.equal(observed.lease_holder, "holder-1");
  assert.equal(observed.request_key, "stable-key");
});

test("auto mode with no native subscription immediately uses cloud fallback and acks after success", async () => {
  const store = createStore();
  const writeCalls = [];
  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    nativeHealth: {
      activeSubscriptionCount: 0,
    },
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {
      read_result: async () => ({ result: "analysis complete" }),
      submit_task: async (args) => {
        writeCalls.push(args);
        return { id: "task-new", status: "queued" };
      },
      continue_task: async () => { throw new Error("unexpected continue"); },
      retry_task: async () => { throw new Error("unexpected retry"); },
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: successFetchWithSubmit(),
    },
  });

  assert.equal(result.status, "cloud_completed");
  assert.equal(result.reason, "no_active_subscription");
  assert.deepEqual(result.created_task_ids, ["task-new"]);
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0].request_key, /^orchestrator:project-1:run_/u);
  assert.match(writeCalls[0].lease_holder, /^cloud-orchestrator:project-1:run_/u);
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 0);
  assert.equal(store.runRecords.at(-1).status, "completed");
});

test("healthy native subscription owns a fresh event during the grace period", async () => {
  const store = createStore({ graceMs: 30_000 });
  let fetchCalls = 0;
  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    nativeHealth: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
    },
    now: new Date("2026-10-06T12:00:10Z"),
    handlers: {},
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    },
  });

  assert.equal(result.status, "native_wait");
  assert.equal(result.reason, "native_grace_period");
  assert.equal(result.retry_after_ms, 20_000);
  assert.equal(fetchCalls, 0);
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
});

test("auto mode takes over when a healthy native path leaves the event pending beyond grace", async () => {
  const store = createStore({ graceMs: 30_000 });
  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    nativeHealth: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
      latestDeliveryState: "delivered",
      latestDeliveryHttpStatus: 202,
    },
    now: new Date("2026-10-06T12:01:00Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: async () => ({ id: "task-new" }),
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: successFetchWithSubmit(),
    },
  });

  assert.equal(result.status, "cloud_completed");
  assert.equal(result.reason, "native_grace_expired_with_pending_event");
});

test("cloud does not double-schedule when another orchestrator already holds the project lease", async () => {
  const store = createStore({ mode: "cloud" });
  store.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "native-handler",
    ttlMs: 60_000,
    now: new Date("2026-10-06T12:00:00Z"),
  });

  let fetchCalls = 0;
  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {},
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    },
  });

  assert.equal(result.status, "lease_busy");
  assert.equal(fetchCalls, 0);
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
});

test("OpenAI failure leaves the event pending for a later idempotent retry", async () => {
  const store = createStore({ mode: "cloud" });
  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: async () => ({ id: "unused" }),
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => jsonResponse({ error: { message: "temporary outage" } }, 503),
    },
  });

  assert.equal(result.status, "cloud_failed");
  assert.equal(result.retryable, true);
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
  assert.equal(store.runRecords.at(-1).status, "failed");
});

test("partial submit retries reuse the same run ID and idempotency key", async () => {
  const store = createStore({ mode: "cloud" });
  const observedKeys = [];
  const dedup = new Map();

  const handler = async (args) => {
    observedKeys.push(args.request_key);
    if (!dedup.has(args.request_key)) dedup.set(args.request_key, { id: "task-partial" });
    return dedup.get(args.request_key);
  };

  let firstRequest = true;
  const first = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: handler,
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => {
        if (firstRequest) {
          firstRequest = false;
          return jsonResponse({
            id: "resp-1",
            output: [{
              type: "function_call",
              call_id: "call-submit",
              name: "submit_task",
              arguments: JSON.stringify({
                role: "backend",
                prompt: "Implement backend",
                context: null,
                route: "local",
              }),
            }],
          });
        }
        return jsonResponse({ error: { message: "temporary outage" } }, 503);
      },
    },
  });

  assert.equal(first.status, "cloud_failed");
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);

  const second = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:02Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: handler,
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: successFetchWithSubmit(),
    },
  });

  assert.equal(second.status, "cloud_completed");
  assert.equal(observedKeys.length, 2);
  assert.equal(observedKeys[0], observedKeys[1]);
  assert.equal(dedup.size, 1);
});

test("user decision is persisted before the triggering event is acknowledged", async () => {
  const store = createStore({ mode: "cloud" });
  const decisions = [];
  let callCount = 0;

  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: async () => ({}),
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    recordUserDecision: async (decision) => {
      assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
      decisions.push(decision);
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return jsonResponse({
            id: "resp-user-1",
            output: [{
              type: "function_call",
              call_id: "call-user",
              name: "request_user_decision",
              arguments: JSON.stringify({
                question: "Choose a paid provider?",
                reason: "Payment is required.",
              }),
            }],
          });
        }
        return jsonResponse({
          id: "resp-user-2",
          output_text: "Waiting for user.",
          output: [],
        });
      },
    },
  });

  assert.equal(result.status, "needs_user");
  assert.equal(decisions.length, 1);
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 0);
});

test("user decision without a durable recorder is not acknowledged", async () => {
  const store = createStore({ mode: "cloud" });
  let callCount = 0;

  const result = await runDualModeOrchestration({
    projectId: PROJECT,
    owner: OWNER,
    store,
    now: new Date("2026-10-06T12:00:01Z"),
    handlers: {
      read_result: async () => ({ result: "ok" }),
      submit_task: async () => ({}),
      continue_task: async () => ({}),
      retry_task: async () => ({}),
    },
    openai: {
      config: {
        apiKey: "sk-test",
        model: "model-test",
        timeoutMs: 20_000,
        maxRounds: 6,
      },
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return jsonResponse({
            id: "resp-user-1",
            output: [{
              type: "function_call",
              call_id: "call-user",
              name: "request_user_decision",
              arguments: JSON.stringify({
                question: "Delete production data?",
                reason: "This is irreversible.",
              }),
            }],
          });
        }
        return jsonResponse({
          id: "resp-user-2",
          output_text: "Waiting.",
          output: [],
        });
      },
    },
  });

  assert.equal(result.status, "cloud_failed");
  assert.equal(result.reason, "user_decision_not_persisted");
  assert.equal(store.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
});
