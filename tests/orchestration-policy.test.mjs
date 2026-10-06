import assert from "node:assert/strict";
import test from "node:test";

import {
  decideOrchestrationPath,
  subscriptionHealth,
} from "../cloud/orchestration-policy.mjs";

const NOW = new Date("2026-10-06T12:00:00Z");

test("auto mode falls back to Chat Bridge immediately without an active native subscription", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:59Z",
    nativeGraceMs: 30_000,
    health: { activeSubscriptionCount: 0 },
    bridgeReady: true,
    now: NOW,
  });
  assert.deepEqual(decision, {
    path: "bridge",
    reason: "no_active_subscription",
    retryAfterMs: 0,
  });
});

test("auto mode leaves the event pending when both free channels are unavailable", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:59Z",
    health: { activeSubscriptionCount: 0 },
    bridgeReady: false,
    now: NOW,
  });
  assert.deepEqual(decision, {
    path: "none",
    reason: "bridge_not_ready",
    retryAfterMs: null,
  });
});

test("healthy native subscription owns a fresh event during grace", () => {
  const decision = decideOrchestrationPath({
    mode: "auto",
    pendingEventOccurredAt: "2026-10-06T11:59:50Z",
    nativeGraceMs: 30_000,
    health: { activeSubscriptionCount: 1, callbackVerified: true },
    bridgeReady: true,
    now: NOW,
  });
  assert.equal(decision.path, "native");
  assert.equal(decision.reason, "native_grace_period");
  assert.equal(decision.retryAfterMs, 20_000);
});

test("Chat Bridge takes over after native grace when the event is still pending", () => {
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
    bridgeReady: true,
    now: NOW,
  });
  assert.deepEqual(decision, {
    path: "bridge",
    reason: "native_grace_expired_with_pending_event",
    retryAfterMs: 0,
  });
});

test("broken native callback bypasses native grace", () => {
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
    health: {
      activeSubscriptionCount: 1,
      callbackVerified: true,
      latestDeliveryState: "pending",
      latestDeliveryHttpStatus: 503,
      consecutiveDeliveryFailures: 3,
    },
    bridgeReady: true,
    now: NOW,
  });
  assert.equal(decision.path, "bridge");
  assert.equal(decision.reason, "delivery_repeated_failure");
});

test("forced free modes are native or bridge only", () => {
  assert.equal(decideOrchestrationPath({
    mode: "bridge",
    pendingEventOccurredAt: "2026-10-06T12:00:00Z",
    bridgeReady: true,
    now: NOW,
  }).path, "bridge");

  assert.equal(decideOrchestrationPath({
    mode: "native",
    pendingEventOccurredAt: "2026-10-06T11:00:00Z",
    health: { activeSubscriptionCount: 0 },
    bridgeReady: true,
    now: NOW,
  }).path, "native");

  assert.throws(
    () => decideOrchestrationPath({ mode: "cloud", now: NOW }),
    /auto.*native.*bridge/u,
  );
});
