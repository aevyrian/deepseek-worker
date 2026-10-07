import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeWakeOutbox } from "../lib/bridge-outbox.mjs";
import { WakeCoordinator } from "../lib/wake-coordinator.mjs";

async function makeOutbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsw-wake-coordinator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new BridgeWakeOutbox({ filePath: join(directory, "outbox.json") });
}

test("Cloud terminal delivery is adopted durably before transport kick", async (t) => {
  const outbox = await makeOutbox(t);
  let pendingAtKick;
  const coordinator = new WakeCoordinator({
    outbox,
    transport: { kick() { pendingAtKick = outbox.listPending(); } },
  });
  await coordinator.acceptResponse({ bridge_deliveries: [{
    delivery_id: "delivery-1", message_key: "message-1", project_id: "project-1", event_id: "event-1",
    task_id: "task-1", event_name: "task.completed", project_revision: 2,
  }] });
  assert.equal((await pendingAtKick).length, 1);
  assert.equal((await pendingAtKick)[0].source, "cloud");
});

test("local fallback is deterministic and only created for an uploaded terminal", async (t) => {
  const outbox = await makeOutbox(t);
  const kicks = [];
  const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks.push(true); } } });
  const response = { project_id: "project-1" };
  const terminal = { taskId: "task-1", terminalState: "failed" };
  const first = await coordinator.acceptResponse(response, terminal);
  const second = await coordinator.acceptResponse(response, terminal);
  assert.equal(first.localWake.message_key, second.localWake.message_key);
  assert.equal((await outbox.listPending()).length, 1);
  assert.equal(kicks.length, 2);
  await coordinator.acceptResponse(null, terminal);
  assert.equal((await outbox.listPending()).length, 1);
});

test("disabled coordinator neither persists nor wakes", async (t) => {
  const outbox = await makeOutbox(t);
  let kicks = 0;
  const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks += 1; } }, enabled: false });
  assert.deepEqual(await coordinator.acceptResponse({ project_id: "project-1" }, { taskId: "task-1", terminalState: "completed" }), { accepted: 0, localWake: null });
  assert.equal((await outbox.listPending()).length, 0);
  assert.equal(kicks, 0);
});