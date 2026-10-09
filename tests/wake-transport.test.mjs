import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { BridgeWakeOutbox } from "../lib/bridge-outbox.mjs";
import { WakeCoordinator } from "../lib/wake-coordinator.mjs";
import { WakeTransport } from "../lib/wake-transport.mjs";

async function abandonLegacyAttempt(filePath) {
  const db = JSON.parse(await readFile(filePath, 'utf8'));
  for (const row of db.deliveries) delete row.send_owner_pid;
  await writeFile(filePath, JSON.stringify(db));
}

async function makeOutbox(t, label = "outbox", options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsw-wake-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new BridgeWakeOutbox({ filePath: join(directory, `${label}.json`), ...options });
}

test("transport routes Cloud and local wake records and marks visible sends delivered", async (t) => {
  const outbox = await makeOutbox(t);
  const local = await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-local", terminalState: "completed" });
  await outbox.adoptCloudDelivery({
    deliveryId: "delivery-1", messageKey: "message-cloud", projectId: "project-1", eventId: "event-1",
    taskId: "task-cloud", eventName: "task.failed", revision: 3,
  });
  const calls = [];
  const bridge = {
    async sendEnvelope(envelope) { calls.push(["cloud", envelope.message_key]); },
    async sendLocalWake(envelope) { calls.push(["local", envelope.message_key]); },
  };
  const transport = new WakeTransport({ outbox, bridge });
  assert.deepEqual(await transport.drainOnce(), { attempted: 2, delivered: 2 });
  assert.deepEqual(calls, [["local", local.message_key], ["cloud", "message-cloud"]]);
  assert.equal((await outbox.findByMessageKey(local.message_key)).delivery_state, "delivered");
  assert.equal((await outbox.findByMessageKey("message-cloud")).delivery_state, "delivered");
});

test("out-of-order A/B Cloud completions route only to each delivery's own conversation", async (t) => {
  const outbox = await makeOutbox(t);
  const coordinator = new WakeCoordinator({ outbox });
  const targetA = { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/c/conversation-A", source: "contract" };
  const targetB = { type: "chatgpt_conversation", conversation_id: "conversation-B", url: "https://chatgpt.com/c/conversation-B", source: "contract" };
  const sent = [];
  const transport = new WakeTransport({
    outbox,
    bridge: { async sendEnvelope(envelope) { sent.push([envelope.project_id, envelope.wake_target?.url]); } },
  });
  const delivery = (suffix, target) => ({
    delivery_id: `delivery-${suffix}`, message_key: `message-${suffix}`, project_id: `project-${suffix}`, event_id: `event-${suffix}`,
    task_id: `task-${suffix}`, event_name: "task.completed", project_revision: 2, wake_target: target,
  });
  await coordinator.acceptResponse({ bridge_delivery: delivery("B", targetB) });
  await coordinator.acceptResponse({ bridge_delivery: delivery("A", targetA) });
  assert.deepEqual(await transport.drainOnce(), { attempted: 2, delivered: 2 });
  assert.deepEqual(sent, [["project-B", targetB.url], ["project-A", targetA.url]]);
  assert.equal((await outbox.findByMessageKey("message-B")).wake_target.url, targetB.url);
  assert.equal((await outbox.findByMessageKey("message-A")).wake_target.url, targetA.url);
});

test("a delivery without wake_target reaches the configured binding only when the Site marked it legacy", async (t) => {
  const outbox = await makeOutbox(t);
  const coordinator = new WakeCoordinator({ outbox });
  const envelope = {
    delivery_id: "delivery-legacy", message_key: "message-legacy", project_id: "project-legacy", event_id: "event-legacy",
    task_id: "task-legacy", event_name: "task.completed", project_revision: 2,
  };
  await coordinator.acceptResponse({ bridge_delivery: envelope });
  const plain = await outbox.findByMessageKey("message-legacy");
  assert.equal(Object.hasOwn(plain, "wake_target"), false);
  assert.equal(plain.legacy_binding, false);
  const plainSent = [];
  await new WakeTransport({ outbox, bridge: { async sendEnvelope(row) { plainSent.push(row); } } }).drainOnce();
  assert.equal(Object.hasOwn(plainSent[0], "legacy_binding"), false);

  const legacyOutbox = await makeOutbox(t, "legacy");
  await new WakeCoordinator({ outbox: legacyOutbox }).acceptResponse({ bridge_delivery: { ...envelope, legacy_binding: true } });
  const marked = await legacyOutbox.findByMessageKey("message-legacy");
  assert.equal(Object.hasOwn(marked, "wake_target"), false);
  assert.equal(marked.legacy_binding, true);
  const legacySent = [];
  await new WakeTransport({ outbox: legacyOutbox, bridge: { async sendEnvelope(row) { legacySent.push(row); } } }).drainOnce();
  assert.equal(legacySent[0].legacy_binding, true);
  assert.equal(Object.hasOwn(legacySent[0], "wake_target"), false);
});

test("local Project terminal response flows through the durable outbox, transport, and cloud ack", async (t) => {
  const outbox = await makeOutbox(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const sent = [];
  const acknowledgements = [];
  const transport = new WakeTransport({
    outbox,
    bridge: { async sendEnvelope(envelope) { sent.push(envelope); } },
    acknowledgeDelivery: async (delivery) => { acknowledgements.push(delivery); },
  });
  const coordinator = new WakeCoordinator({ outbox, transport });
  const running = transport.run(controller.signal);
  const bridgeDelivery = {
    delivery_id: "delivery-project-task", message_key: "message-project-task", project_id: "project-1",
    event_id: "event-project-task", task_id: "task-local", event_name: "task.completed", project_revision: 9,
  };

  try {
    const accepted = await coordinator.acceptResponse({ project_id: "project-1", bridge_delivery: bridgeDelivery });
    assert.equal(accepted.accepted, 1);
    assert.equal(accepted.localWake, null);
    const pending = await outbox.findByMessageKey(bridgeDelivery.message_key);
    assert.equal(pending.delivery_state, "pending");
    assert.equal(pending.project_id, "project-1");
    assert.equal(pending.task_id, "task-local");
    assert.equal(pending.event_id, "event-project-task");

    // Generous budget: the transport loop is a real timer loop and the suite runs
    // test files in parallel, so a short poll window turns into a scheduling flake.
    for (let index = 0; index < 300 && (sent.length === 0 || acknowledgements.length === 0); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1, "transport kick should send the adopted delivery");
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0].delivery_id, bridgeDelivery.delivery_id);
    assert.equal((await outbox.findByMessageKey(bridgeDelivery.message_key)).delivery_state, "delivered");
  } finally {
    controller.abort();
    await running;
  }
});

test("permanent delivery rejection sends only the stable identity fields", async (t) => {
  const outbox = await makeOutbox(t);
  const rejected = [];
  const transport = new WakeTransport({
    outbox,
    bridge: {},
    rejectDelivery: async (identity, reason) => rejected.push({ identity, reason }),
  });
  const result = await transport.rejectCloudDelivery({
    delivery_id: "delivery-1", message_key: "message-1", project_id: "project-1", event_id: "event-1",
    task_id: "task-1", event_name: "task.completed", project_revision: 3,
    wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/private-target" },
  }, "bridge_wake_target_conflict");
  assert.equal(result, true);
  assert.deepEqual(rejected, [{ identity: {
    delivery_id: "delivery-1", message_key: "message-1", project_id: "project-1", event_id: "event-1",
    task_id: "task-1", event_name: "task.completed", project_revision: 3,
  }, reason: "bridge_wake_target_conflict" }]);
});

test("transport keeps failed sends pending with sanitized errors and retries", async (t) => {
  let now = "2026-10-08T00:00:00.000Z";
  const outbox = await makeOutbox(t, "outbox", { now: () => now, retryBaseMs: 1000, retryMaxMs: 8000 });
  const row = await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-1", terminalState: "failed" });
  let attempts = 0;
  const transport = new WakeTransport({
    outbox,
    bridge: { async sendLocalWake() { attempts += 1; if (attempts === 1) throw new Error("token=secret C:\\Users\\Alice\\private"); } },
    logger: { warn() {} },
  });
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 0 });
  const failed = await outbox.findByMessageKey(row.message_key);
  assert.equal(failed.delivery_state, "pending");
  assert.doesNotMatch(failed.last_error, /secret|Alice/iu);
  assert.equal(failed.next_attempt_at, "2026-10-08T00:00:01.000Z");
  assert.equal(failed.last_failure, failed.last_error);
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 }, "delivery is not retried before its persisted backoff expires");
  now = "2026-10-08T00:00:01.000Z";
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 1 });
  const delivered = await outbox.findByMessageKey(row.message_key);
  assert.equal(delivered.delivery_state, "delivered");
  assert.equal(delivered.last_error, null);
  assert.equal(delivered.last_failure, failed.last_failure, "successful retry keeps the sanitized failure evidence");
});

test("interrupted send is reconciled as delivered and Cloud ACK is durably recorded", async (t) => {
  const { filePath } = await makeOutbox(t);
  const firstProcess = new BridgeWakeOutbox({ filePath });
  const queued = (await firstProcess.adoptCloudDelivery({
    deliveryId: "delivery-visible", messageKey: "message-visible", projectId: "project-1", taskId: "task-visible",
    eventId: "event-visible", eventName: "task.completed", revision: 1,
  })).row;
  await firstProcess.beginAttempt(queued.message_key);

  await abandonLegacyAttempt(filePath);
  const restartedOutbox = new BridgeWakeOutbox({ filePath });
  let reconcileCalls = 0;
  let bridgeCalls = 0;
  const acknowledgements = [];
  const transport = new WakeTransport({
    outbox: restartedOutbox,
    acknowledgeDelivery: async (delivery) => acknowledgements.push(delivery),
    bridge: { async reconcileDelivery(delivery) {
      reconcileCalls += 1;
      bridgeCalls += 1;
      assert.equal(delivery.message_key, queued.message_key);
      return { state: "delivered" };
    } },
  });
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 1 });
  assert.equal(reconcileCalls, 1);
  assert.equal(bridgeCalls, 1);
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0].delivery_id, "delivery-visible");
  assert.equal((await restartedOutbox.findByMessageKey(queued.message_key)).delivery_state, "delivered");
  assert.equal((await restartedOutbox.findByMessageKey(queued.message_key)).cloud_ack_state, "acked");
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 });
  assert.equal(reconcileCalls, 1, "uncertain delivery is checked at most once per process");
});

test("a confirmed safe draft receives one bounded recovery attempt", async (t) => {
  const { filePath } = await makeOutbox(t);
  const first = new BridgeWakeOutbox({ filePath });
  const queued = await first.enqueueLocal({ projectId: "project-1", taskId: "task-draft", terminalState: "completed" });
  await first.beginAttempt(queued.message_key);
  await abandonLegacyAttempt(filePath);
  const restarted = new BridgeWakeOutbox({ filePath });
  let reconcileCalls = 0;
  let sendCalls = 0;
  const transport = new WakeTransport({
    outbox: restarted,
    bridge: {
      async reconcileDelivery() { reconcileCalls += 1; return { state: "safe_draft" }; },
      async sendLocalWake() { sendCalls += 1; },
    },
  });
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 1 });
  assert.equal(reconcileCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal((await restarted.findByMessageKey(queued.message_key)).recovery_attempts, 1);
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 });
  assert.equal(sendCalls, 1);
});

test("an uncertain delivery is repeatedly reconciled with durable backoff and never blindly resent", async (t) => {
  const { filePath } = await makeOutbox(t);
  let now = "2026-10-08T00:00:00.000Z";
  const first = new BridgeWakeOutbox({ filePath, now: () => now, reconcileBaseMs: 1000, reconcileMaxMs: 4000 });
  const queued = await first.enqueueLocal({ projectId: "project-1", taskId: "task-unknown", terminalState: "completed" });
  await first.beginAttempt(queued.message_key);
  await abandonLegacyAttempt(filePath);
  const restarted = new BridgeWakeOutbox({ filePath, now: () => now, reconcileBaseMs: 1000, reconcileMaxMs: 4000 });
  let reconcileCalls = 0;
  let sendCalls = 0;
  const transport = new WakeTransport({
    outbox: restarted,
    bridge: {
      async reconcileDelivery() { reconcileCalls += 1; return { state: "uncertain", reason: "stale_stop_control" }; },
      async sendLocalWake() { sendCalls += 1; },
    },
    logger: { warn() {} },
  });
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 });
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 });
  assert.equal(reconcileCalls, 1);
  assert.equal(sendCalls, 0);
  let uncertain = await restarted.findByMessageKey(queued.message_key);
  assert.equal(uncertain.delivery_state, "uncertain");
  assert.equal(uncertain.reconcile_attempts, 1);
  assert.equal(uncertain.next_reconcile_at, "2026-10-08T00:00:01.000Z");
  assert.equal(uncertain.reconcile_diagnostic.reason, "stale_stop_control");
  now = uncertain.next_reconcile_at;
  await transport.drainOnce();
  assert.equal(reconcileCalls, 2, "the same process retries once the persisted schedule is due");
  assert.equal(sendCalls, 0);
  uncertain = await restarted.findByMessageKey(queued.message_key);
  assert.equal(uncertain.reconcile_attempts, 2);
  const afterRestart = new BridgeWakeOutbox({ filePath, now: () => now, reconcileBaseMs: 1000, reconcileMaxMs: 4000 });
  assert.equal((await afterRestart.listUncertain()).length, 0, "a new process honors the persisted next_reconcile_at");
});

test("a delivered Cloud message retries only its failed ACK after restart", async (t) => {
  const { filePath } = await makeOutbox(t);
  let now = "2026-10-08T00:00:00.000Z";
  const outbox = new BridgeWakeOutbox({ filePath, now: () => now, retryBaseMs: 1000, retryMaxMs: 4000 });
  const adopted = await outbox.adoptCloudDelivery({
    deliveryId: "delivery-ack-retry", messageKey: "message-ack-retry", projectId: "project-1", taskId: "task-ack-retry",
    eventId: "event-ack-retry", eventName: "task.completed", revision: 1,
  });
  await outbox.beginAttempt(adopted.row.message_key);
  await outbox.markFailed(adopted.row.message_key, Object.assign(new Error("unknown submit"), { code: "bridge_send_uncertain" }));
  const recovered = new BridgeWakeOutbox({ filePath, now: () => now, retryBaseMs: 1000, retryMaxMs: 4000 });
  let reconcileCalls = 0;
  let ackCalls = 0;
  let sends = 0;
  const transport = new WakeTransport({
    outbox: recovered,
    bridge: {
      async reconcileDelivery() { reconcileCalls += 1; return { state: "delivered", stage: "page_confirmation" }; },
      async sendEnvelope() { sends += 1; },
    },
    acknowledgeDelivery: async () => { ackCalls += 1; if (ackCalls === 1) throw new Error("token=hidden C:\\private\\auth.json"); },
    logger: { warn() {} },
  });
  await transport.drainOnce();
  let row = await recovered.findByMessageKey("message-ack-retry");
  assert.equal(row.delivery_state, "delivered");
  assert.equal(row.cloud_ack_state, "pending");
  assert.equal(row.cloud_ack_attempts, 1);
  assert.doesNotMatch(row.cloud_ack_last_error, /hidden|private|auth\.json/iu);
  now = row.cloud_ack_next_attempt_at;
  await transport.drainOnce();
  row = await recovered.findByMessageKey("message-ack-retry");
  assert.equal(row.cloud_ack_state, "acked");
  assert.equal(row.cloud_ack_attempts, 2);
  assert.equal(reconcileCalls, 1, "ACK recovery does not revisit the send path");
  assert.equal(sends, 0, "a delivered message is never resent while ACK retries");
});

test("concurrent transport instances share the durable reconciliation lock", async (t) => {
  const { filePath } = await makeOutbox(t);
  const first = new BridgeWakeOutbox({ filePath });
  const queued = await first.enqueueLocal({ projectId: "project-1", taskId: "task-concurrent-reconcile", terminalState: "completed" });
  await first.beginAttempt(queued.message_key);
  await abandonLegacyAttempt(filePath);
  const outbox = new BridgeWakeOutbox({ filePath });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    outbox,
    bridge: { async reconcileDelivery() { calls += 1; await gate; return { state: "uncertain", reason: "page_unavailable" }; } },
    logger: { warn() {} },
  };
  const transportA = new WakeTransport(options);
  const transportB = new WakeTransport(options);
  const firstDrain = transportA.drainOnce();
  const secondDrain = transportB.drainOnce();
  release();
  await Promise.all([firstDrain, secondDrain]);
  assert.equal(calls, 1);
  assert.equal((await outbox.findByMessageKey(queued.message_key)).delivery_state, "uncertain");
});

test("transport run resumes pending work, responds to kicks and stops on abort", async (t) => {
  const outbox = await makeOutbox(t);
  const controller = new AbortController();
  let sends = 0;
  const transport = new WakeTransport({
    outbox,
    bridge: { async sendLocalWake() { sends += 1; } },
    retryIntervalMs: 1000,
  });
  await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-startup", terminalState: "completed" });
  const running = transport.run(controller.signal);
  for (let index = 0; index < 300 && sends === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 1, "startup scan should resume a pending wake");
  await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-kick", terminalState: "failed" });
  transport.kick();
  for (let index = 0; index < 300 && sends < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 2, "kick should prompt a pending wake");
  controller.abort();
  await running;
});

test("safe draft with missing target can recover once while an ambiguous send never retries", async (t) => {
  const outbox = await makeOutbox(t);
  const safe = await outbox.enqueueLocal({ projectId: "draft", taskId: "safe", terminalState: "completed" });
  const unknown = await outbox.enqueueLocal({ projectId: "draft", taskId: "unknown", terminalState: "completed" });
  await outbox.markFailed(safe.message_key, Object.assign(new Error("not submitted"), { code: "bridge_send_not_submitted" }));
  await outbox.markFailed(unknown.message_key, Object.assign(new Error("maybe submitted"), { code: "bridge_send_uncertain" }));
  const sends = [];
  const transport = new WakeTransport({ outbox, bridge: {
    async reconcileDelivery() { return { state: "uncertain", reason: "target_missing", stage: "target_location" }; },
    async sendLocalWake(row) { sends.push(row.message_key); },
  }, logger: { warn() {} } });
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 1 });
  assert.deepEqual(sends, [safe.message_key]);
  assert.equal((await outbox.findByMessageKey(unknown.message_key)).delivery_state, "uncertain");
});

test("Cloud adoption of an ambiguous local wake reconciles the original key and ACKs only the formal key", async (t) => {
  const outbox = await makeOutbox(t);
  const local = await outbox.enqueueLocal({ projectId: "adopt", taskId: "task", terminalState: "completed" });
  await outbox.beginAttempt(local.message_key);
  await outbox.markFailed(local.message_key, Object.assign(new Error("maybe submitted"), { code: "bridge_send_uncertain" }));
  const envelope = { deliveryId: "formal-id", messageKey: "formal-key", projectId: "adopt", taskId: "task", eventId: "event", eventName: "task.completed", revision: 2 };
  const adopted = await outbox.adoptCloudDelivery(envelope);
  assert.equal(adopted.row.message_key, local.message_key);
  assert.equal(adopted.row.delivery_state, "uncertain");
  await outbox.adoptCloudDelivery(envelope);
  const acknowledgements = [];
  const transport = new WakeTransport({ outbox, bridge: {
    async reconcileDelivery(row) { assert.equal(row.message_key, local.message_key); return { state: "delivered" }; },
    async sendEnvelope() { assert.fail("ambiguous local wake must never become a fresh Cloud send"); },
  }, acknowledgeDelivery: async (row) => acknowledgements.push(row) });
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 1 });
  assert.equal(acknowledgements[0].message_key, "formal-key");
  const receipt = await outbox.findByMessageKey(local.message_key);
  assert.equal(receipt.message_visible, true);
  assert.equal(receipt.transport_acked, true);
  assert.equal(receipt.orchestrator_handled, null);
  assert.deepEqual(await transport.drainOnce(), { attempted: 0, delivered: 0 });
});

test("concurrent ACKs remain exclusive even after the retry delay elapses", async (t) => {
  let now = "2026-10-09T00:00:00.000Z";
  const outbox = await makeOutbox(t, "acks", { now: () => now, retryBaseMs: 1000 });
  const adopted = await outbox.adoptCloudDelivery({ deliveryId: "ack-id", messageKey: "ack-key", projectId: "ack-project", taskId: "task", eventId: "event", eventName: "task.completed", revision: 1 });
  await outbox.markDelivered(adopted.row.message_key);
  let release, started;
  const gate = new Promise((done) => { release = done; });
  const entered = new Promise((done) => { started = done; });
  let calls = 0;
  const options = { outbox, bridge: {}, acknowledgeDelivery: async () => { calls++; started(); await gate; } };
  const a = new WakeTransport(options), b = new WakeTransport(options);
  const active = a.acknowledgeCloudDelivery(adopted.row);
  await entered;
  now = "2026-10-09T00:01:00.000Z";
  assert.equal(await b.acknowledgeCloudDelivery(adopted.row), false);
  release();
  await active;
  assert.equal(calls, 1);
  await outbox.failCloudAck(adopted.row.message_key, new Error("late stale callback"));
  await outbox.markFailed(adopted.row.message_key, new Error("late stale send callback"));
  const row = await outbox.findByMessageKey(adopted.row.message_key);
  assert.equal(row.delivery_state, "delivered");
  assert.equal(row.cloud_ack_state, "acked");
});

test("transport durably records draft and submit intent before allowing the simulated click", async (t) => {
  const outbox = await makeOutbox(t);
  const queued = await outbox.enqueueLocal({ projectId: "progress", taskId: "task", terminalState: "completed" });
  assert.equal(queued.delivery_stage, "queued");
  const transport = new WakeTransport({ outbox, bridge: { async sendLocalWake(row, { onProgress }) {
    await onProgress("draft_verified", { composerHasMessageKey: true, draftRetained: true, url: "private", cookie: "secret" });
    let persisted = JSON.parse(await readFile(outbox.filePath, "utf8")).deliveries[0];
    assert.equal(persisted.delivery_stage, "draft_verified");
    assert.equal(persisted.submit_attempted, false);
    await onProgress("submit_attempted");
    persisted = JSON.parse(await readFile(outbox.filePath, "utf8")).deliveries[0];
    assert.equal(persisted.delivery_stage, "submit_attempted");
    assert.equal(persisted.submit_attempted, true);
    assert.doesNotMatch(JSON.stringify(persisted.submit_diagnostic), /private|secret/u);
  } } });
  await transport.drainOnce();
  assert.equal((await outbox.findByMessageKey(queued.message_key)).delivery_stage, "message_visible");
});

test("a failed progress write prevents the simulated click and preserves retry evidence", async (t) => {
  const outbox = await makeOutbox(t);
  const queued = await outbox.enqueueLocal({ projectId: "progress-failure", taskId: "task", terminalState: "completed" });
  let clicks = 0;
  outbox.recordSendProgress = async () => { throw new Error("disk write failed"); };
  const transport = new WakeTransport({ outbox, bridge: { async sendLocalWake(row, { onProgress }) {
    await onProgress("draft_verified");
    clicks++;
  } }, logger: { warn() {} } });
  await transport.drainOnce();
  assert.equal(clicks, 0);
  assert.equal((await outbox.findByMessageKey(queued.message_key)).delivery_state, "pending");
  assert.equal((await outbox.findByMessageKey(queued.message_key)).last_failure, "disk write failed");
});

test("already visible local adoption immediately ACKs the formal key and keeps original bubble identity", async (t) => {
  const outbox = await makeOutbox(t);
  const local = await outbox.enqueueLocal({ projectId: "visible-adopt", taskId: "task", terminalState: "completed" });
  await outbox.markDelivered(local.message_key);
  const acknowledgements = [];
  const transport = new WakeTransport({ outbox, bridge: {}, acknowledgeDelivery: async (row) => acknowledgements.push(row) });
  const coordinator = new WakeCoordinator({ outbox, transport });
  const envelope = { delivery_id: "formal-visible", message_key: "formal-visible-key", project_id: "visible-adopt", task_id: "task", event_id: "event", event_name: "task.completed", project_revision: 1 };
  await coordinator.acceptResponse({ bridge_delivery: envelope });
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0].message_key, envelope.message_key);
  const receipt = await outbox.findByMessageKey(local.message_key);
  assert.equal(receipt.message_key, local.message_key);
  assert.equal(receipt.cloud_ack_state, "acked");
  assert.equal(receipt.delivery_stage, "transport_acked");
  assert.equal(receipt.orchestrator_handled, null);
});

test("two processes serialize distinct messages through one UI submission transaction", async (t) => {
  const outbox = await makeOutbox(t);
  const rows = await Promise.all(["a", "b"].map((taskId) => outbox.enqueueLocal({ projectId: "serialized", taskId, terminalState: "completed" })));
  const counterPath = `${outbox.filePath}.counter`;
  await writeFile(counterPath, JSON.stringify({ active: 0, maximum: 0 }));
  await Promise.all(rows.map((row) => new Promise((done, reject) => {
    const code = `
      import { readFile,writeFile } from 'node:fs/promises';
      import { BridgeWakeOutbox } from './lib/bridge-outbox.mjs';
      import { WakeTransport } from './lib/wake-transport.mjs';
      const box = new BridgeWakeOutbox({filePath:${JSON.stringify(outbox.filePath)}});
      const list = box.listPending.bind(box);
      box.listPending = async () => (await list()).filter(row => row.message_key === ${JSON.stringify(row.message_key)});
      await new WakeTransport({outbox:box,bridge:{async sendLocalWake(row,{onProgress}){
        await onProgress('draft_verified'); await onProgress('submit_attempted');
        const path=${JSON.stringify(counterPath)};
        let state=JSON.parse(await readFile(path,'utf8')); state.active++; state.maximum=Math.max(state.maximum,state.active); await writeFile(path,JSON.stringify(state));
        await new Promise(done=>setTimeout(done,50));
        state=JSON.parse(await readFile(path,'utf8')); state.active--; await writeFile(path,JSON.stringify(state));
      }}}).drainOnce();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; }); child.on("error", reject);
    child.on("exit", (status) => status === 0 ? done() : reject(new Error(errors)));
  })));
  assert.deepEqual(JSON.parse(await readFile(counterPath, "utf8")), { active: 0, maximum: 1 });
  for (const row of rows) assert.equal((await outbox.findByMessageKey(row.message_key)).delivery_state, "delivered");
});

test("disabling while waiting for the submission lock does not claim or send a new delivery", async (t) => {
  const outbox = await makeOutbox(t);
  const row = await outbox.enqueueLocal({ projectId: "disable", taskId: "task", terminalState: "completed" });
  let release, entered, waiting;
  const gate = new Promise((done) => { release = done; });
  const acquired = new Promise((done) => { entered = done; });
  const queued = new Promise((done) => { waiting = done; });
  const blocker = outbox.withSubmissionLock(async () => { entered(); await gate; });
  await acquired;
  const originalLock = outbox.withSubmissionLock.bind(outbox);
  outbox.withSubmissionLock = (operation) => { waiting(); return originalLock(operation); };
  let enabled = true, sends = 0;
  const transport = new WakeTransport({ outbox, enabled: () => enabled, bridge: { async sendLocalWake() { sends++; } } });
  const drain = transport.drainOnce();
  await queued;
  enabled = false;
  release();
  await blocker;
  await drain;
  assert.equal(sends, 0);
  assert.equal((await outbox.findByMessageKey(row.message_key)).attempts, 0);
  assert.equal((await outbox.findByMessageKey(row.message_key)).delivery_state, "pending");
});
