import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_CATALOG,
  InMemoryEventCore,
  MCP_PROTOCOL_VERSION,
  canonicalJson,
  computeRetryDelayMs,
  deliveryDisposition,
  deriveSubscriptionId,
  validateCallbackUrl,
  validateWebhookSecret,
} from "../cloud/event-core.mjs";

const OWNER = "owner-1";
const PROJECT = "project-1";
const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");

function coreWithProject() {
  const core = new InMemoryEventCore();
  core.createProject({ projectId: PROJECT, owner: OWNER, goal: "Build a novel site" });
  return core;
}

test("event catalog advertises completed and failed for MCP 2.0", () => {
  assert.equal(MCP_PROTOCOL_VERSION, "2026-07-28");
  assert.deepEqual(EVENT_CATALOG.map((event) => event.name), ["task.completed", "task.failed"]);
  assert.ok(EVENT_CATALOG.every((event) => event.delivery.includes("webhook")));
});

test("canonical JSON ignores object key insertion order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("subscription IDs are stable across argument key order and refreshes", () => {
  const a = deriveSubscriptionId({
    principal: OWNER,
    callbackUrl: "https://callback.example.test/hook",
    name: "task.completed",
    arguments: { project_id: PROJECT },
  });
  const b = deriveSubscriptionId({
    principal: OWNER,
    callbackUrl: "https://callback.example.test/hook",
    name: "task.completed",
    arguments: { project_id: PROJECT },
  });
  assert.equal(a, b);
  assert.match(a, /^sub_[A-Za-z0-9_-]{32}$/u);
});

test("callback validation rejects insecure and local destinations", () => {
  assert.throws(() => validateCallbackUrl("http://example.com/hook"), /HTTPS/);
  assert.throws(() => validateCallbackUrl("https://localhost/hook"), /local or private/);
  assert.throws(() => validateCallbackUrl("https://127.0.0.1/hook"), /local or private/);
  assert.throws(() => validateCallbackUrl("https://192.168.1.2/hook"), /local or private/);
  assert.equal(validateCallbackUrl("https://events.example.com/hook"), "https://events.example.com/hook");
});

test("webhook secret validation follows whsec and decoded length contract", () => {
  assert.equal(validateWebhookSecret(SECRET), SECRET);
  assert.throws(() => validateWebhookSecret("not-secret"), /whsec_/);
  assert.throws(
    () => validateWebhookSecret("whsec_" + Buffer.alloc(8).toString("base64")),
    /24-64 bytes/,
  );
});

test("terminal task event is durable, lightweight, and deduplicated", () => {
  const core = coreWithProject();
  core.attachTask({ projectId: PROJECT, taskId: "task-a", owner: OWNER, role: "database" });

  const first = core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
    summary: "Schema completed. Full details live in read_result.",
    resultAvailable: true,
  });
  const again = core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
    summary: "duplicate callback",
    resultAvailable: true,
  });

  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(first.event.eventId, again.event.eventId);
  assert.equal(first.event.name, "task.completed");
  assert.equal(first.event.data.result_available, true);
  assert.ok(!Object.hasOwn(first.event.data, "result"));
  assert.equal(core.listPendingEvents({ projectId: PROJECT, owner: OWNER }).length, 1);
});

test("project revision advances as tasks and terminal events change project state", () => {
  const core = coreWithProject();
  assert.equal(core.getProject(PROJECT, OWNER).revision, 1);
  core.attachTask({ projectId: PROJECT, taskId: "task-a", owner: OWNER });
  assert.equal(core.getProject(PROJECT, OWNER).revision, 2);
  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
  });
  assert.equal(core.getProject(PROJECT, OWNER).revision, 3);
});

test("subscription is owner-scoped, idempotent, and refreshable", () => {
  const core = coreWithProject();
  const first = core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: 60_000,
    now: new Date("2026-10-06T10:00:00Z"),
  });
  const refreshed = core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: 120_000,
    now: new Date("2026-10-06T10:00:30Z"),
  });

  assert.equal(first.id, refreshed.id);
  assert.notEqual(first.refreshBefore, refreshed.refreshBefore);
  assert.throws(() => core.subscribe({
    principal: "other-owner",
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
  }), /Project not found/);
});

test("matching terminal event creates exactly one delivery per active subscription", () => {
  const core = coreWithProject();
  const subscription = core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: null,
  });
  core.attachTask({ projectId: PROJECT, taskId: "task-a", owner: OWNER });
  const created = core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
    resultAvailable: true,
  });
  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
    resultAvailable: true,
  });

  const due = core.dueDeliveries();
  assert.equal(due.length, 1);
  assert.equal(due[0].event_id, created.event.eventId);
  assert.equal(due[0].subscription_id, subscription.id);
});

test("failed event does not deliver to completed-only subscription", () => {
  const core = coreWithProject();
  core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: null,
  });
  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-f",
    owner: OWNER,
    status: "failed",
    summary: "build failed",
  });
  assert.equal(core.dueDeliveries().length, 0);
});

test("project lease excludes a concurrent orchestrator until expiry", () => {
  const core = coreWithProject();
  const first = core.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "run-a",
    ttlMs: 60_000,
    now: new Date("2026-10-06T10:00:00Z"),
  });
  const blocked = core.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "run-b",
    ttlMs: 60_000,
    now: new Date("2026-10-06T10:00:30Z"),
  });
  const afterExpiry = core.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "run-b",
    ttlMs: 60_000,
    now: new Date("2026-10-06T10:01:01Z"),
  });

  assert.equal(first.acquired, true);
  assert.equal(blocked.acquired, false);
  assert.equal(afterExpiry.acquired, true);
});

test("same lease holder can renew and only its holder can release", () => {
  const core = coreWithProject();
  core.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "run-a",
    ttlMs: 60_000,
  });
  const renewed = core.acquireProjectLease({
    projectId: PROJECT,
    owner: OWNER,
    holder: "run-a",
    ttlMs: 90_000,
  });
  assert.equal(renewed.acquired, true);
  assert.equal(core.releaseProjectLease({ projectId: PROJECT, owner: OWNER, holder: "run-b" }), false);
  assert.equal(core.releaseProjectLease({ projectId: PROJECT, owner: OWNER, holder: "run-a" }), true);
});

test("delivery retry policy preserves pending state with exponential backoff", () => {
  const core = coreWithProject();
  const subscription = core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: null,
  });
  const terminal = core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
  });

  const retry = core.recordDeliveryResult({
    eventId: terminal.event.eventId,
    subscriptionId: subscription.id,
    httpStatus: 503,
    now: new Date("2026-10-06T10:00:00Z"),
  });
  assert.equal(retry.state, "pending");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.next_attempt_at_ms, new Date("2026-10-06T10:00:01Z").getTime());

  const success = core.recordDeliveryResult({
    eventId: terminal.event.eventId,
    subscriptionId: subscription.id,
    httpStatus: 204,
    now: new Date("2026-10-06T10:00:02Z"),
  });
  assert.equal(success.state, "delivered");
});

test("410 and 413 are terminal and are not retried", () => {
  assert.equal(deliveryDisposition(410), "terminal");
  assert.equal(deliveryDisposition(413), "terminal");
  assert.equal(deliveryDisposition(429), "retry");
  assert.equal(deliveryDisposition(503), "retry");
  assert.equal(deliveryDisposition(200), "ack");
});

test("retry delays are exponential and bounded", () => {
  assert.equal(computeRetryDelayMs(1), 1_000);
  assert.equal(computeRetryDelayMs(2), 2_000);
  assert.equal(computeRetryDelayMs(10), 300_000);
});

test("unsubscribe is idempotent and prevents future delivery", () => {
  const core = coreWithProject();
  core.subscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
    ttlMs: null,
  });

  assert.deepEqual(core.unsubscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: { mode: "webhook", url: "https://events.example.com/callback" },
  }), {});

  assert.deepEqual(core.unsubscribe({
    principal: OWNER,
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: { mode: "webhook", url: "https://events.example.com/callback" },
  }), {});

  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
  });
  assert.equal(core.dueDeliveries().length, 0);
});
