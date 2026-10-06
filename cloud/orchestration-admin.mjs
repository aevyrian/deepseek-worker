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

function sanitizeBridgeDelivery(row) {
  if (!row) return null;
  return {
    delivery_id: row.delivery_id ?? null,
    event_id: row.event_id ?? null,
    task_id: row.task_id ?? null,
    state: row.state ?? null,
    attempts: Number.isInteger(row.attempts) ? row.attempts : 0,
    fallback_reason: row.fallback_reason ?? null,
    last_error: row.last_error ? String(row.last_error).slice(0, 500) : null,
    created_at: row.created_at ?? null,
    sent_at: row.sent_at ?? null,
    acknowledged_at: row.acknowledged_at ?? null,
  };
}

export async function getOrchestrationDiagnostics({
  store,
  projectId,
  owner,
  nativeHealth = {},
  bridge = {},
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
  const latestBridge = typeof store.getLatestBridgeDelivery === "function"
    ? await store.getLatestBridgeDelivery(projectId, owner)
    : null;

  return {
    ...config,
    pending_event_count: pendingEvents.length,
    native_subscription: subscriptionHealth(nativeHealth),
    chat_bridge: {
      ready: bridge.ready === true,
      worker_online: bridge.worker_online === true,
      bound: bridge.bound === true,
      state: bridge.state ?? null,
      last_event_id: bridge.last_event_id ?? null,
      last_sent_at: bridge.last_sent_at ?? null,
      last_error: bridge.last_error ? String(bridge.last_error).slice(0, 500) : null,
    },
    latest_bridge_delivery: sanitizeBridgeDelivery(latestBridge),
    paid_cloud_orchestrator_enabled: false,
  };
}
