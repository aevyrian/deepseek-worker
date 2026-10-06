import { createHash } from "node:crypto";

import {
  buildOrchestratorHolder,
  decideOrchestrationPath,
  normalizeGraceMs,
  normalizeOrchestrationMode,
  subscriptionHealth,
} from "./orchestration-policy.mjs";
import { runCloudOrchestrator } from "./openai-orchestrator.mjs";

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function deriveCloudRunId(projectId, eventIds) {
  const project = requiredString(projectId, "projectId");
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new Error("eventIds must be a non-empty array");
  }
  const normalized = [...new Set(eventIds.map((value) => requiredString(value, "eventId")))].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({ project_id: project, event_ids: normalized }))
    .digest("base64url")
    .slice(0, 24);
  return `run_${digest}`;
}

export function normalizeProjectOrchestrationConfig(config = {}) {
  return {
    mode: normalizeOrchestrationMode(config.mode ?? "auto"),
    native_grace_ms: normalizeGraceMs(config.native_grace_ms ?? 30_000),
  };
}

export function makeInternalToolExecutor({
  projectId,
  holder,
  handlers,
}) {
  requiredString(projectId, "projectId");
  requiredString(holder, "holder");
  if (!handlers || typeof handlers !== "object") throw new Error("handlers are required");

  const readOnly = new Set(["read_result"]);
  const writes = new Set(["submit_task", "continue_task", "retry_task"]);

  return async (name, args, meta) => {
    if (readOnly.has(name)) {
      if (typeof handlers[name] !== "function") throw new Error(`Missing handler for ${name}`);
      return handlers[name]({
        ...args,
        project_id: projectId,
      });
    }

    if (writes.has(name)) {
      if (typeof handlers[name] !== "function") throw new Error(`Missing handler for ${name}`);
      return handlers[name]({
        ...args,
        project_id: projectId,
        request_key: meta.requestKey,
        lease_holder: holder,
      });
    }

    throw new Error(`Unsupported orchestrator tool "${name}"`);
  };
}

export async function runDualModeOrchestration({
  projectId,
  owner,
  store,
  handlers,
  nativeHealth = null,
  now = new Date(),
  openai = {},
  recordUserDecision = null,
}) {
  const project = requiredString(projectId, "projectId");
  const principal = requiredString(owner, "owner");

  if (!store || typeof store !== "object") throw new Error("store is required");
  for (const method of [
    "getProject",
    "listProjectTasks",
    "listPendingEvents",
    "acquireProjectLease",
    "releaseProjectLease",
    "acknowledgeEvent",
  ]) {
    if (typeof store[method] !== "function") throw new Error(`store.${method} is required`);
  }

  const projectState = await store.getProject(project, principal);
  if (!projectState) return { status: "not_found" };

  const rawConfig = typeof store.getOrchestrationConfig === "function"
    ? await store.getOrchestrationConfig(project, principal)
    : null;
  const config = normalizeProjectOrchestrationConfig(rawConfig ?? {});

  let pendingEvents = await store.listPendingEvents({ projectId: project, owner: principal });
  if (pendingEvents.length === 0) {
    return {
      status: "idle",
      mode: config.mode,
      reason: "no_pending_events",
    };
  }

  const oldest = [...pendingEvents].sort((a, b) => String(a.timestamp ?? a.occurred_at).localeCompare(String(b.timestamp ?? b.occurred_at)))[0];
  const healthInput = typeof nativeHealth === "function"
    ? await nativeHealth({ projectId: project, owner: principal, now })
    : nativeHealth ?? {};
  const health = subscriptionHealth({ ...healthInput, now });
  const decision = decideOrchestrationPath({
    mode: config.mode,
    pendingEventOccurredAt: oldest.timestamp ?? oldest.occurred_at,
    pendingEventAcknowledged: Boolean(oldest.acknowledged),
    nativeGraceMs: config.native_grace_ms,
    health: healthInput,
    now,
  });

  if (decision.path === "none") {
    return {
      status: "idle",
      mode: config.mode,
      reason: decision.reason,
    };
  }

  if (decision.path === "native") {
    return {
      status: "native_wait",
      mode: config.mode,
      reason: decision.reason,
      retry_after_ms: decision.retryAfterMs,
      native_health: health,
    };
  }

  const eventIds = pendingEvents.map((event) => event.eventId ?? event.event_id);
  const runId = deriveCloudRunId(project, eventIds);
  const holder = buildOrchestratorHolder({ projectId: project, runId });
  const lease = await store.acquireProjectLease({
    projectId: project,
    owner: principal,
    holder,
    ttlMs: 120_000,
    now,
  });

  if (!lease?.acquired) {
    return {
      status: "lease_busy",
      mode: config.mode,
      reason: "project_lease_busy",
      run_id: runId,
      holder: lease?.holder ?? null,
      expires_at: lease?.expiresAt ?? null,
    };
  }

  let runRecorded = false;
  const recordRun = async (patch) => {
    if (typeof store.recordOrchestratorRun !== "function") return;
    await store.recordOrchestratorRun({
      projectId: project,
      owner: principal,
      runId,
      ...patch,
    });
    runRecorded = true;
  };

  try {
    // Re-read after acquiring the project lease so native and cloud cannot both
    // schedule from a stale event snapshot.
    pendingEvents = await store.listPendingEvents({ projectId: project, owner: principal });
    if (pendingEvents.length === 0) {
      await recordRun({
        status: "superseded",
        mode: config.mode,
        selected_path: "cloud",
        fallback_reason: decision.reason,
        input_event_ids: eventIds,
        created_task_ids: [],
        model: null,
        error_summary: null,
      });
      return {
        status: "superseded",
        mode: config.mode,
        reason: "events_already_handled",
        run_id: runId,
      };
    }

    const currentEventIds = pendingEvents.map((event) => event.eventId ?? event.event_id);
    const currentProject = await store.getProject(project, principal);
    const projectTasks = await store.listProjectTasks({ projectId: project, owner: principal });

    await recordRun({
      status: "running",
      mode: config.mode,
      selected_path: "cloud",
      fallback_reason: decision.reason,
      input_event_ids: currentEventIds,
      created_task_ids: [],
      model: openai?.config?.model ?? null,
      error_summary: null,
    });

    const executeTool = makeInternalToolExecutor({
      projectId: project,
      holder,
      handlers,
    });

    let result;
    try {
      result = await runCloudOrchestrator({
        project: currentProject,
        pendingEvents,
        projectTasks,
        triggerReason: decision.reason,
        runId,
        executeTool,
        ...openai,
      });
    } catch (error) {
      await recordRun({
        status: "failed",
        mode: config.mode,
        selected_path: "cloud",
        fallback_reason: decision.reason,
        input_event_ids: currentEventIds,
        created_task_ids: error?.created_task_ids ?? [],
        model: openai?.config?.model ?? null,
        error_summary: String(error?.message ?? error).slice(0, 1000),
      });
      return {
        status: "cloud_failed",
        mode: config.mode,
        reason: decision.reason,
        run_id: runId,
        error: String(error?.message ?? error),
        retryable: true,
      };
    }

    if (result.status === "needs_user") {
      if (typeof recordUserDecision !== "function") {
        await recordRun({
          status: "failed",
          mode: config.mode,
          selected_path: "cloud",
          fallback_reason: decision.reason,
          input_event_ids: currentEventIds,
          created_task_ids: result.created_task_ids,
          model: result.model,
          error_summary: "user decision requested but no durable recorder is configured",
        });
        return {
          status: "cloud_failed",
          mode: config.mode,
          reason: "user_decision_not_persisted",
          run_id: runId,
          retryable: true,
        };
      }

      await recordUserDecision({
        projectId: project,
        owner: principal,
        runId,
        question: result.user_decision.question,
        reason: result.user_decision.reason,
      });
    }

    // Ack only after every scheduling action and any required user-decision
    // record has been durably persisted.
    for (const event of pendingEvents) {
      await store.acknowledgeEvent({
        projectId: project,
        eventId: event.eventId ?? event.event_id,
        owner: principal,
        holder,
      });
    }

    await recordRun({
      status: result.status,
      mode: config.mode,
      selected_path: "cloud",
      fallback_reason: decision.reason,
      input_event_ids: currentEventIds,
      created_task_ids: result.created_task_ids,
      model: result.model,
      response_id: result.response_id,
      error_summary: null,
    });

    return {
      status: result.status === "needs_user" ? "needs_user" : "cloud_completed",
      mode: config.mode,
      reason: decision.reason,
      run_id: runId,
      response_id: result.response_id,
      model: result.model,
      created_task_ids: result.created_task_ids,
      user_decision: result.user_decision,
      run_recorded: runRecorded,
    };
  } finally {
    await store.releaseProjectLease({
      projectId: project,
      owner: principal,
      holder,
    });
  }
}
