import { stableRunRequestKey } from "./orchestration-policy.mjs";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ROUNDS = 12;

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    type: "function",
    name: "read_result",
    description: "Read the full result of one completed task that belongs to this project.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    type: "function",
    name: "submit_task",
    description: "Submit a newly unlocked independent task. Prefer useful parallelism. Do not create filler tasks or conflicting writers.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        context: { type: ["string", "null"] },
        route: { type: ["string", "null"], enum: ["local", "cloud", "auto", null] },
      },
      required: ["role", "prompt", "context", "route"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    type: "function",
    name: "continue_task",
    description: "Continue an existing task in its exact saved Native Session when additional work should remain in that task's context.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
        route: { type: ["string", "null"], enum: ["local", "cloud", "auto", null] },
      },
      required: ["task_id", "instruction", "route"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    type: "function",
    name: "retry_task",
    description: "Retry a failed task only when retrying the same task is better than creating a new debugging task.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
        instruction: { type: ["string", "null"] },
        route: { type: ["string", "null"], enum: ["local", "cloud", "auto", null] },
      },
      required: ["task_id", "instruction", "route"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    type: "function",
    name: "request_user_decision",
    description: "Stop autonomous scheduling and record that the project needs a user decision. Use only for product choices that cannot be safely inferred, accounts, payments, sensitive credentials, or irreversible destructive actions.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
      required: ["question", "reason"],
      additionalProperties: false,
    },
  }),
]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseJsonArguments(value) {
  if (typeof value !== "string") throw new Error("function call arguments must be a JSON string");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("function call arguments must decode to an object");
  }
  return parsed;
}

function functionCalls(response) {
  return Array.isArray(response?.output)
    ? response.output.filter((item) => item?.type === "function_call")
    : [];
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function normalizeToolResult(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ ok: false, error: "tool_result_not_serializable" });
  }
}

function taskIdFromResult(value) {
  if (!value || typeof value !== "object") return null;
  return typeof value.task_id === "string"
    ? value.task_id
    : typeof value.id === "string"
      ? value.id
      : null;
}

export function resolveOrchestratorConfig(env = process.env) {
  const apiKey = requiredString(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = typeof env.ORCHESTRATOR_MODEL === "string" && env.ORCHESTRATOR_MODEL.trim()
    ? env.ORCHESTRATOR_MODEL.trim()
    : DEFAULT_MODEL;
  const timeoutMs = Number.parseInt(env.ORCHESTRATOR_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const maxRounds = Number.parseInt(env.ORCHESTRATOR_MAX_ROUNDS ?? String(DEFAULT_MAX_ROUNDS), 10);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 10 * 60_000) {
    throw new Error("ORCHESTRATOR_TIMEOUT_MS must be between 5000 and 600000");
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
    throw new Error("ORCHESTRATOR_MAX_ROUNDS must be between 1 and 50");
  }

  return {
    apiKey,
    model,
    timeoutMs,
    maxRounds,
  };
}

export function buildRootOrchestratorInstructions() {
  return [
    "You are the root project orchestrator for DeepSeek Worker.",
    "You manage project-level scheduling; you are not one long-running worker session.",
    "Use the project goal, acceptance criteria, current task graph, and triggering pending events as the source of truth.",
    "Maximize useful parallelism, never task count for its own sake.",
    "Avoid concurrent writers touching the same files/modules unless the project has explicit isolation or ownership boundaries.",
    "Prefer a flow of parallel investigation/design, then isolated implementation, then independent tests/review, then integration.",
    "Use continue_task when follow-up belongs in the exact same task/session context; use submit_task for genuinely independent work; use retry_task only for a real retry.",
    "Do not wait or poll for running DeepSeek tasks. Dispatch useful work and finish this orchestration run.",
    "Routine engineering decisions are yours. Call request_user_decision only for material product choices that cannot be inferred, accounts/payments, sensitive credentials, or irreversible/destructive actions.",
    "Do not claim completion unless the acceptance criteria are actually satisfied by durable task results.",
    "When no additional task is useful yet, simply finish the orchestration run; the next project event will trigger another run.",
  ].join("\n");
}

export function buildRootOrchestratorInput({
  project,
  pendingEvents,
  projectTasks,
  triggerReason,
}) {
  return JSON.stringify({
    trigger: triggerReason,
    project: {
      project_id: project.project_id,
      goal: project.goal,
      acceptance_criteria: project.acceptance_criteria ?? project.acceptanceCriteria ?? [],
      revision: project.revision,
    },
    pending_events: pendingEvents,
    task_graph: projectTasks,
    instruction: "Process the triggering events. Read full results only when useful, then dispatch newly unlocked work or request a user decision. Do not poll.",
  });
}

export async function callResponsesApi({
  fetchImpl = fetch,
  apiKey,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OpenAI Responses request timed out")), timeoutMs);
  try {
    const response = await fetchImpl(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(`OpenAI Responses API returned HTTP ${response.status}`);
      error.status = response.status;
      error.details = body?.error?.message ?? null;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function runCloudOrchestrator({
  project,
  pendingEvents,
  projectTasks,
  triggerReason,
  runId,
  executeTool,
  fetchImpl = fetch,
  env = process.env,
  config = null,
}) {
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  const resolved = config ?? resolveOrchestratorConfig(env);
  const instructions = buildRootOrchestratorInstructions();
  const input = buildRootOrchestratorInput({
    project,
    pendingEvents,
    projectTasks,
    triggerReason,
  });

  let response = await callResponsesApi({
    fetchImpl,
    apiKey: resolved.apiKey,
    timeoutMs: resolved.timeoutMs,
    payload: {
      model: resolved.model,
      instructions,
      input,
      tools: TOOL_DEFINITIONS,
      parallel_tool_calls: true,
    },
  });

  const createdTaskIds = [];
  const toolAudit = [];
  let requestedUserDecision = null;
  let actionIndex = 0;

  for (let round = 0; round < resolved.maxRounds; round += 1) {
    const calls = functionCalls(response);
    if (calls.length === 0) {
      return {
        status: requestedUserDecision ? "needs_user" : "completed",
        response_id: response?.id ?? null,
        model: resolved.model,
        summary: responseText(response),
        created_task_ids: createdTaskIds,
        tool_audit: toolAudit,
        user_decision: requestedUserDecision,
        rounds: round + 1,
      };
    }

    const outputs = [];
    for (const call of calls) {
      const requestKey = stableRunRequestKey({
        projectId: project.project_id,
        runId,
        actionIndex,
        actionName: call.name,
      });
      actionIndex += 1;

      let args;
      try {
        args = parseJsonArguments(call.arguments);
      } catch (error) {
        const failure = { ok: false, error: "invalid_tool_arguments", message: error.message };
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(failure),
        });
        toolAudit.push({ name: call.name, request_key: requestKey, ok: false, error: failure.error });
        continue;
      }

      if (call.name === "request_user_decision") {
        requestedUserDecision = {
          question: args.question,
          reason: args.reason,
        };
        const result = { ok: true, recorded: true };
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
        toolAudit.push({ name: call.name, request_key: requestKey, ok: true });
        continue;
      }

      try {
        const result = await executeTool(call.name, args, {
          requestKey,
          runId,
          projectId: project.project_id,
        });
        const taskId = taskIdFromResult(result);
        if (taskId && ["submit_task", "continue_task", "retry_task"].includes(call.name)) {
          if (!createdTaskIds.includes(taskId)) createdTaskIds.push(taskId);
        }
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: normalizeToolResult(result),
        });
        toolAudit.push({ name: call.name, request_key: requestKey, ok: true, task_id: taskId });
      } catch (error) {
        const failure = {
          ok: false,
          error: "tool_execution_failed",
          message: String(error?.message ?? error),
        };
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(failure),
        });
        toolAudit.push({ name: call.name, request_key: requestKey, ok: false, error: failure.message });
      }
    }

    try {
      response = await callResponsesApi({
        fetchImpl,
        apiKey: resolved.apiKey,
        timeoutMs: resolved.timeoutMs,
        payload: {
          model: resolved.model,
          instructions,
          previous_response_id: response.id,
          input: outputs,
          tools: TOOL_DEFINITIONS,
          parallel_tool_calls: true,
        },
      });
    } catch (error) {
      error.created_task_ids = [...createdTaskIds];
      error.tool_audit = [...toolAudit];
      throw error;
    }
  }

  const error = new Error("Cloud orchestrator exceeded ORCHESTRATOR_MAX_ROUNDS");
  error.code = "ORCHESTRATOR_MAX_ROUNDS";
  error.created_task_ids = createdTaskIds;
  error.tool_audit = toolAudit;
  throw error;
}

export { TOOL_DEFINITIONS };
