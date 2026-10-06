import {
  normalizeGraceMs,
  normalizeOrchestrationMode,
  subscriptionHealth,
} from "./orchestration-policy.mjs";

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export async function getProjectOrchestrationMode({
  store,
  projectId,
  owner,
}) {
  const project = requiredString(projectId, "projectId");
  const principal = requiredString(owner, "owner");
  const visible = await store.getProject(project, principal);
  if (!visible) throw new Error("Project not found");

  const raw = typeof store.getOrchestrationConfig === "function"
    ? await store.getOrchestrationConfig(project, principal)
    : null;
  return {
    project_id: project,
    mode: normalizeOrchestrationMode(raw?.mode ?? "auto"),
    native_grace_ms: normalizeGraceMs(raw?.native_grace_ms ?? 30_000),
  };
}

export async function setProjectOrchestrationMode({
  store,
  projectId,
  owner,
  mode,
  nativeGraceMs = 30_000,
  now = new Date(),
}) {
  const project = requiredString(projectId, "projectId");
  const principal = requiredString(owner, "owner");
  const visible = await store.getProject(project, principal);
  if (!visible) throw new Error("Project not found");
  if (typeof store.setOrchestrationConfig !== "function") {
    throw new Error("Orchestration configuration storage is unavailable");
  }

  const normalized = {
    project_id: project,
    mode: normalizeOrchestrationMode(mode),
    native_grace_ms: normalizeGraceMs(nativeGraceMs),
    updated_at: new Date(now).toISOString(),
  };
  await store.setOrchestrationConfig(project, principal, normalized);
  return normalized;
}

export async function getOrchestrationDiagnostics({
  store,
  projectId,
  owner,
  nativeHealth = {},
}) {
  const config = await getProjectOrchestrationMode({
    store,
    projectId,
    owner,
  });
  const pendingEvents = await store.listPendingEvents({
    projectId,
    owner,
  });
  const latestRun = typeof store.getLatestOrchestratorRun === "function"
    ? await store.getLatestOrchestratorRun(projectId, owner)
    : null;

  return {
    ...config,
    pending_event_count: pendingEvents.length,
    native_subscription: subscriptionHealth(nativeHealth),
    latest_cloud_run: latestRun
      ? {
          run_id: latestRun.run_id,
          status: latestRun.status,
          selected_path: latestRun.selected_path,
          fallback_reason: latestRun.fallback_reason ?? null,
          model: latestRun.model ?? null,
          response_id: latestRun.response_id ?? null,
          input_event_ids: latestRun.input_event_ids ?? [],
          created_task_ids: latestRun.created_task_ids ?? [],
          error_summary: latestRun.error_summary ?? null,
          started_at: latestRun.started_at ?? null,
          finished_at: latestRun.finished_at ?? null,
        }
      : null,
  };
}
