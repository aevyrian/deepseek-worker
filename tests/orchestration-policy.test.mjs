import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrchestratorHolder,
  decideOrchestrationPath,
  stableRunRequestKey,
  subscriptionHealth,
} from "../cloud/orchestration-policy.mjs";

const NOW = new Date("2026-10-06T12:00:00Z");

test("auto mode falls back to cloud immediately without an active subscription", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:59Z",
    nativeGraceMs: 30_000,
    health: { activeSubscriptionCount: 0 },
    now: NOW,
  });
  assert.deepEqual(decision, {
    path: "cloud",
    reason: "no_active_subscription",
    retryAfterMs: 0,
  });
});

test("auto mode gives a healthy native subscription its grace window", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:50Z",
    nativeGraceMs: 30_000,
    health: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
    },
    now: NOW,
  });
  assert.equal(decision.path, "native");
  assert.equal(decision.reason, "native_grace_period");
  assert.equal(decision.retryAfterMs, 20_000);
});

test("auto mode takes over a still-pending event after the native grace expires", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:00Z",
    nativeGraceMs: 30_000,
    health: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
      latestDeliveryState: "delivered",
      latestDeliveryHttpStatus: 202,
    },
    now: NOW,
  });
  assert.deepEqual(decision, {
    path: "cloud",
    reason: "native_grace_expired_with_pending_event",
    retryAfterMs: 0,
  });
});

test("broken callback delivery bypasses native grace", () => {
  const health = subscriptionHealth({
    activeSubscriptionCount: 1,
    callbackVerified: true,
    latestDeliveryState: "pending",
    latestDeliveryHttpStatus: 503,
    consecutiveDeliveryFailures: 3,
    now: NOW,
  });
  assert.equal(health.healthy, false);
  assert.equal(health.reason, "delivery_repeated_failure");

  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:59Z",
    nativeGraceMs: 30_000,
    health: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
      latestDeliveryState: "pending",
      latestDeliveryHttpStatus: 503,
      consecutiveDeliveryFailures: 3,
    },
    now: NOW,
  });
  assert.equal(decision.path, "cloud");
  assert.equal(decision.reason, "delivery_repeated_failure");
});

test("forced modes override subscription health", () => {
  assert.equal(decideOrchestrationPath({
    mode: "cloud",
    pendingEventOccurredAt: "2026-10-06T12:00:00Z",
    health: { activeSubscriptionCount: 1, callbackVerified: true },
    now: NOW,
  }).path, "cloud");

  assert.equal(decideOrchestrationPath({
    mode: "native",
    pendingEventOccurredAt: "2026-10-06T11:00:00Z",
    health: { activeSubscriptionCount: 0 },
    now: NOW,
  }).path, "native");
});

test("expired subscriptions are unhealthy", () => {
  const health = subscriptionHealth({
    activeSubscriptionCount: 1,
    callbackVerified: true,
    subscriptionRefreshBefore: "2026-10-06T11:59:59Z",
    now: NOW,
  });
  assert.deepEqual(health, {
    healthy: false,
    reason: "subscription_expired",
    active: false,
  });
});

test("orchestrator holder and action request keys are deterministic", () => {
  assert.equal(
    buildOrchestratorHolder({ projectId: "p1", runId: "r1" }),
    "cloud-orchestrator:p1:r1",
  );
  assert.equal(
    stableRunRequestKey({
      projectId: "p1",
      runId: "r1",
      actionIndex: 2,
      actionName: "submit_task",
    }),
    "orchestrator:p1:r1:2:submit_task",
  );
});
