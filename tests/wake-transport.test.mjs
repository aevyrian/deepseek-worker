import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeWakeOutbox } from "../lib/bridge-outbox.mjs";
import { WakeTransport } from "../lib/wake-transport.mjs";

async function makeOutbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsw-wake-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new BridgeWakeOutbox({ filePath: join(directory, "outbox.json") });
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

test("transport keeps failed sends pending with sanitized errors and retries", async (t) => {
  const outbox = await makeOutbox(t);
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
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 1 });
  assert.equal((await outbox.findByMessageKey(row.message_key)).delivery_state, "delivered");
});

test("recovered pending wake settles delivered when ChatGPT already shows its message key", async (t) => {
  const { filePath } = await makeOutbox(t);
  const firstProcess = new BridgeWakeOutbox({ filePath });
  const queued = await firstProcess.enqueueLocal({ projectId: "project-1", taskId: "task-visible", terminalState: "completed" });
  await firstProcess.beginAttempt(queued.message_key);

  const restartedOutbox = new BridgeWakeOutbox({ filePath });
  let bridgeCalls = 0;
  const transport = new WakeTransport({
    outbox: restartedOutbox,
    bridge: { async sendLocalWake(delivery) {
      bridgeCalls += 1;
      assert.equal(delivery.message_key, queued.message_key);
      return { ok: true, deduplicated: true };
    } },
  });
  assert.deepEqual(await transport.drainOnce(), { attempted: 1, delivered: 1 });
  assert.equal(bridgeCalls, 1);
  assert.equal((await restartedOutbox.findByMessageKey(queued.message_key)).delivery_state, "delivered");
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
  for (let index = 0; index < 30 && sends === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 1, "startup scan should resume a pending wake");
  await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-kick", terminalState: "failed" });
  transport.kick();
  for (let index = 0; index < 30 && sends < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 2, "kick should prompt a pending wake");
  controller.abort();
  await running;
});