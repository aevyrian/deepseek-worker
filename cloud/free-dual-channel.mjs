import { createHash } from "node:crypto";

import {
  decideOrchestrationPath,
  normalizeGraceMs,
  normalizeOrchestrationMode,
  subscriptionHealth,
} from "./orchestration-policy.mjs";

const TERMINAL_EVENTS = new Set(["task.completed", "task.failed"]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function hashId(prefix, payload) {
  return `${prefix}_${createHash("sha256").update(payload).digest("base64url").slice(0, 28)}`;
}

export function bridgeMessageKey(projectId, eventId) {
  const project = requiredString(projectId, "projectId");
  const event = requiredString(eventId, "eventId");
  return hashId("bridge_msg", JSON.stringify({ project_id: project, event_id: event }));
}

export function bridgeDeliveryId(projectId, eventId) {
  const project = requiredString(projectId, "projectId");
  const event = requiredString(eventId, "eventId");
  return hashId("bridge_del", JSON.stringify({ project_id: project, event_id: event }));
}

export function normalizeTerminalProjectEvent(event, projectId) {
  if (!event || typeof event !== "object") throw new Error("project event is required");
  const name = requiredString(event.name ?? event.event_name, "event name");
  if (!TERMINAL_EVENTS.has(name)) throw new Error("only terminal task events may enter Chat Bridge");
  const eventId = requiredString(event.event_id ?? event.eventId, "event id");
  const taskId = requiredString(event.task_id ?? event.taskId, "task id");
  const revision = Number(event.project_revision ?? event.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("project revision must be positive");
  return {
    project_id: requiredString(projectId ?? event.project_id, "project id"),
    event_id: eventId,
    task_id: taskId,
    event_name: name,
    project_revision: revision,
    occurred_at: event.occurred_at ?? event.timestamp ?? null,
  };
}

export function buildBridgeDelivery(event, projectId) {
  const normalized = normalizeTerminalProjectEvent(event, projectId);
  return Object.freeze({
    delivery_id: bridgeDeliveryId(normalized.project_id, normalized.event_id),
    message_key: bridgeMessageKey(normalized.project_id, normalized.event_id),
    project_id: normalized.project_id,
    event_id: normalized.event_id,
    task_id: normalized.task_id,
    event_name: normalized.event_name,
    project_revision: normalized.project_revision,
  });
}

export function normalizeProjectOrchestrationConfig(config = {}) {
  return {
    mode: normalizeOrchestrationMode(config.mode ?? "auto"),
    native_grace_ms: normalizeGraceMs(config.native_grace_ms ?? 30_000),
  };
}

export async function planFreeDualChannel({
  projectId,
  owner,
  store,
  nativeHealth = null,
  bridgeReady = false,
  now = new Date(),
}) {
  const project = requiredString(projectId, "projectId");
  const principal = requiredString(owner, "owner");
  if (!store || typeof store !== "object") throw new Error("store is required");
  if (typeof store.getProject !== "function" || typeof store.listPendingEvents !== "function") {
    throw new Error("store project/event access is required");
  }

  const projectState = await store.getProject(project, principal);
  if (!projectState) return { status: "not_found", deliveries: [] };

  const rawConfig = typeof store.getOrchestrationConfig === "function"
    ? await store.getOrchestrationConfig(project, principal)
    : null;
  const config = normalizeProjectOrchestrationConfig(rawConfig ?? {});
  const pending = await store.listPendingEvents({ projectId: project, owner: principal });
  if (pending.length === 0) {
    return { status: "idle", mode: config.mode, reason: "no_pending_events", deliveries: [] };
  }

  const oldest = [...pending].sort((a, b) => (
    String(a.occurred_at ?? a.timestamp ?? "").localeCompare(String(b.occurred_at ?? b.timestamp ?? ""))
  ))[0];
  const healthInput = typeof nativeHealth === "function"
    ? await nativeHealth({ projectId: project, owner: principal, now })
    : nativeHealth ?? {};
  const native = subscriptionHealth({ ...healthInput, now });
  const decision = decideOrchestrationPath({
    mode: config.mode,
    pendingEventOccurredAt: oldest.occurred_at ?? oldest.timestamp,
    pendingEventAcknowledged: Boolean(oldest.acknowledged),
    nativeGraceMs: config.native_grace_ms,
    health: healthInput,
    bridgeReady,
    now,
  });

  if (decision.path !== "bridge") {
    return {
      status: decision.path === "native" ? "native_wait" : "waiting",
      mode: config.mode,
      reason: decision.reason,
      retry_after_ms: decision.retryAfterMs,
      native_health: native,
      bridge_ready: Boolean(bridgeReady),
      deliveries: [],
    };
  }

  const deliveries = pending
    .filter((event) => TERMINAL_EVENTS.has(event.name ?? event.event_name))
    .map((event) => buildBridgeDelivery(event, project));

  if (typeof store.upsertBridgeDelivery === "function") {
    for (const delivery of deliveries) {
      await store.upsertBridgeDelivery({
        projectId: project,
        owner: principal,
        delivery,
        fallbackReason: decision.reason,
        now,
      });
    }
  }

  return {
    status: deliveries.length > 0 ? "bridge_ready" : "waiting",
    mode: config.mode,
    reason: deliveries.length > 0 ? decision.reason : "no_terminal_pending_events",
    retry_after_ms: 0,
    native_health: native,
    bridge_ready: Boolean(bridgeReady),
    deliveries,
  };
}

export async function recordBridgeDeliveryAttempt({
  store,
  projectId,
  owner,
  deliveryId,
  messageKey,
  success,
  error = null,
  now = new Date(),
}) {
  if (typeof store?.recordBridgeDeliveryAttempt !== "function") {
    return {
      delivery_id: requiredString(deliveryId, "deliveryId"),
      message_key: requiredString(messageKey, "messageKey"),
      state: success ? "sent" : "failed",
    };
  }
  return store.recordBridgeDeliveryAttempt({
    projectId: requiredString(projectId, "projectId"),
    owner: requiredString(owner, "owner"),
    deliveryId: requiredString(deliveryId, "deliveryId"),
    messageKey: requiredString(messageKey, "messageKey"),
    success: success === true,
    error: success ? null : String(error ?? "").slice(0, 1000),
    now,
  });
}
