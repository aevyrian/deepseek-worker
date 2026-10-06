const MODES = new Set(["auto", "native", "cloud"]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asDateMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeOrchestrationMode(mode) {
  const value = mode ?? "auto";
  if (!MODES.has(value)) {
    throw new Error('orchestration mode must be one of "auto", "native", or "cloud"');
  }
  return value;
}

export function normalizeGraceMs(value, fallback = 30_000) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > 15 * 60_000) {
    throw new Error("native grace must be an integer between 0 and 900000 ms");
  }
  return result;
}

export function subscriptionHealth({
  activeSubscriptionCount = 0,
  callbackVerified = false,
  latestDeliveryState = null,
  latestDeliveryAt = null,
  latestDeliveryHttpStatus = null,
  consecutiveDeliveryFailures = 0,
  subscriptionRefreshBefore = null,
  now = new Date(),
} = {}) {
  const nowMs = new Date(now).getTime();
  const refreshBeforeMs = asDateMs(subscriptionRefreshBefore);

  if (!Number.isInteger(activeSubscriptionCount) || activeSubscriptionCount < 0) {
    throw new Error("activeSubscriptionCount must be a non-negative integer");
  }

  if (activeSubscriptionCount === 0) {
    return {
      healthy: false,
      reason: "no_active_subscription",
      active: false,
    };
  }

  if (refreshBeforeMs !== null && refreshBeforeMs <= nowMs) {
    return {
      healthy: false,
      reason: "subscription_expired",
      active: false,
    };
  }

  if (!callbackVerified) {
    return {
      healthy: false,
      reason: "callback_unverified",
      active: true,
    };
  }

  if (latestDeliveryState === "dead") {
    return {
      healthy: false,
      reason: "delivery_dead",
      active: true,
    };
  }

  if (Number.isInteger(consecutiveDeliveryFailures) && consecutiveDeliveryFailures >= 3) {
    return {
      healthy: false,
      reason: "delivery_repeated_failure",
      active: true,
    };
  }

  if (
    typeof latestDeliveryHttpStatus === "number"
    && latestDeliveryHttpStatus >= 400
    && latestDeliveryState !== "delivered"
  ) {
    return {
      healthy: false,
      reason: "delivery_http_error",
      active: true,
    };
  }

  return {
    healthy: true,
    reason: latestDeliveryAt ? "healthy_recent_delivery" : "healthy_ready",
    active: true,
  };
}

export function decideOrchestrationPath({
  mode = "auto",
  pendingEventOccurredAt,
  pendingEventAcknowledged = false,
  nativeGraceMs = 30_000,
  health = {},
  now = new Date(),
} = {}) {
  const normalizedMode = normalizeOrchestrationMode(mode);
  const graceMs = normalizeGraceMs(nativeGraceMs);
  const nowMs = new Date(now).getTime();
  const occurredAtMs = asDateMs(pendingEventOccurredAt);

  if (pendingEventAcknowledged) {
    return {
      path: "none",
      reason: "event_already_acknowledged",
      retryAfterMs: null,
    };
  }

  if (normalizedMode === "cloud") {
    return {
      path: "cloud",
      reason: "forced_cloud_mode",
      retryAfterMs: 0,
    };
  }

  if (normalizedMode === "native") {
    return {
      path: "native",
      reason: "forced_native_mode",
      retryAfterMs: null,
    };
  }

  const nativeHealth = subscriptionHealth({ ...health, now });
  if (!nativeHealth.healthy) {
    return {
      path: "cloud",
      reason: nativeHealth.reason,
      retryAfterMs: 0,
    };
  }

  if (occurredAtMs === null) {
    return {
      path: "native",
      reason: "native_healthy_event_age_unknown",
      retryAfterMs: graceMs,
    };
  }

  const ageMs = Math.max(0, nowMs - occurredAtMs);
  if (ageMs < graceMs) {
    return {
      path: "native",
      reason: "native_grace_period",
      retryAfterMs: graceMs - ageMs,
    };
  }

  return {
    path: "cloud",
    reason: "native_grace_expired_with_pending_event",
    retryAfterMs: 0,
  };
}

export function buildOrchestratorHolder({
  projectId,
  runId,
  prefix = "cloud-orchestrator",
}) {
  const project = requiredString(projectId, "projectId");
  const run = requiredString(runId, "runId");
  return `${prefix}:${project}:${run}`;
}

export function stableRunRequestKey({
  projectId,
  runId,
  actionIndex,
  actionName,
}) {
  const project = requiredString(projectId, "projectId");
  const run = requiredString(runId, "runId");
  const name = requiredString(actionName, "actionName");
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    throw new Error("actionIndex must be a non-negative integer");
  }
  return `orchestrator:${project}:${run}:${actionIndex}:${name}`;
}

export function summarizeOrchestrationDecision({
  mode,
  decision,
  health,
}) {
  return {
    mode: normalizeOrchestrationMode(mode),
    selected_path: decision.path,
    reason: decision.reason,
    retry_after_ms: decision.retryAfterMs,
    native_subscription: {
      healthy: Boolean(health?.healthy),
      reason: health?.reason ?? null,
      active: Boolean(health?.active),
    },
  };
}
