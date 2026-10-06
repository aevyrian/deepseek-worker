import assert from "node:assert/strict";
import test from "node:test";

import {
  bridgeDeliveryId,
  bridgeMessageKey,
  buildBridgeDelivery,
  planFreeDualChannel,
} from "../cloud/free-dual-channel.mjs";

const PROJECT = "project-1";
const OWNER = "owner-1";

function store({ mode = "auto", pending = [], config = null } = {}) {
  const deliveries = [];
  return {
    deliveries,
    async getProject(projectId, owner) {
      return projectId === PROJECT && owner === OWNER ? { project_id: PROJECT } : null;
    },
    async getOrchestrationConfig() {
      return config ?? { mode, native_grace_ms: 30000 };
    },
    async listPendingEvents() {
      return pending;
    },
    async upsertBridgeDelivery(row) {
      deliveries.push(row);
    },
  };
}

const EVENT = {
  event_id: "evt-1",
  task_id: "task-1",
  name: "task.completed",
  project_revision: 3,
  occurred_at: "2026-10-06T12:00:00Z",
};

test("bridge IDs are deterministic per project event", () => {
  assert.equal(bridgeMessageKey(PROJECT, "evt-1"), bridgeMessageKey(PROJECT, "evt-1"));
  assert.equal(bridgeDeliveryId(PROJECT, "evt-1"), bridgeDeliveryId(PROJECT, "evt-1"));
});

test("bridge delivery contains only structured terminal-event identifiers", () => {
  const row = buildBridgeDelivery({ ...EVENT, summary: "not forwarded", result: "not forwarded" }, PROJECT);
  assert.equal(row.project_id, PROJECT);
  assert.equal(row.event_name, "task.completed");
  assert.ok(!Object.hasOwn(row, "summary"));
  assert.ok(!Object.hasOwn(row, "result"));
});

test("auto with no native subscription routes to Bridge when worker reports ready", async () => {
  const s = store({ pending: [EVENT] });
  const result = await planFreeDualChannel({
    projectId: PROJECT,
    owner: OWNER,
    store: s,
    nativeHealth: { activeSubscriptionCount: 0 },
    bridgeReady: true,
    now: new Date("2026-10-06T12:00:01Z"),
  });
  assert.equal(result.status, "bridge_ready");
  assert.equal(result.reason, "no_active_subscription");
  assert.equal(result.deliveries.length, 1);
  assert.equal(s.deliveries.length, 1);
});

test("healthy native subscription keeps a fresh event away from Bridge", async () => {
  const s = store({ pending: [EVENT] });
  const result = await planFreeDualChannel({
    projectId: PROJECT,
    owner: OWNER,
    store: s,
    nativeHealth: { activeSubscriptionCount: 1, callbackVerified: true },
    bridgeReady: true,
    now: new Date("2026-10-06T12:00:10Z"),
  });
  assert.equal(result.status, "native_wait");
  assert.equal(result.deliveries.length, 0);
});

test("native grace expiry routes the still-pending event to Bridge", async () => {
  const s = store({ pending: [EVENT] });
  const result = await planFreeDualChannel({
    projectId: PROJECT,
    owner: OWNER,
    store: s,
    nativeHealth: { activeSubscriptionCount: 1, callbackVerified: true },
    bridgeReady: true,
    now: new Date("2026-10-06T12:01:00Z"),
  });
  assert.equal(result.status, "bridge_ready");
  assert.equal(result.reason, "native_grace_expired_with_pending_event");
});

test("no free channel ready leaves the event pending rather than calling a paid API", async () => {
  const s = store({ pending: [EVENT] });
  const result = await planFreeDualChannel({
    projectId: PROJECT,
    owner: OWNER,
    store: s,
    nativeHealth: { activeSubscriptionCount: 0 },
    bridgeReady: false,
    now: new Date("2026-10-06T12:00:01Z"),
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "bridge_not_ready");
  assert.equal(result.deliveries.length, 0);
});
