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

test("single Cloud terminal delivery is adopted durably before transport kick", async (t) => {
  const outbox = await makeOutbox(t);
  let pendingAtKick;
  const coordinator = new WakeCoordinator({
    outbox,
    transport: { kick() { pendingAtKick = outbox.listPending(); } },
  });
  await coordinator.acceptResponse({ bridge_delivery: {
    delivery_id: "delivery-1", message_key: "message-1", project_id: "project-1", event_id: "event-1",
    task_id: "task-1", event_name: "task.completed", project_revision: 2,
  } });
  assert.equal((await pendingAtKick).length, 1);
  assert.equal((await pendingAtKick)[0].source, "cloud");
});

test("local fallback is deterministic and only created for an uploaded terminal", async (t) => {
  const outbox = await makeOutbox(t);
  const kicks = [];
  const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks.push(true); } } });
  const response = { project_id: "project-1" };
  const terminal = { taskId: "task-1", task: { project_id: "project-task" }, terminalState: "failed" };
  const first = await coordinator.acceptResponse(response, terminal);
  const second = await coordinator.acceptResponse(response, terminal);
  assert.equal(first.localWake.message_key, second.localWake.message_key);
  assert.equal(first.localWake.project_id, "project-1", "response.project_id takes precedence over task identity");
  assert.equal((await outbox.listPending()).length, 1);
  assert.equal(kicks.length, 2);
  await coordinator.acceptResponse(null, terminal);
  assert.equal((await outbox.listPending()).length, 1);
});

test("local fallback accepts project identity from terminal task context", async (t) => {
  const outbox = await makeOutbox(t);
  let kicks = 0;
  const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks += 1; } } });
  const result = await coordinator.acceptResponse({}, {
    taskId: "task-context",
    task: { project_id: "project-from-claim" },
    terminalState: "completed",
  });

  assert.equal(result.localWake.project_id, "project-from-claim");
  assert.equal(result.localWake.task_id, "task-context");
  assert.equal(result.diagnostic, null);
  assert.equal(kicks, 1);
  assert.equal((await outbox.listPending()).length, 1);
});

test("local fallback resolves project.project_id before claimed task identity", async (t) => {
  const outbox = await makeOutbox(t);
  const coordinator = new WakeCoordinator({ outbox });
  const result = await coordinator.acceptResponse({ project: { id: "project-from-response" } }, {
    taskId: "task-nested-project",
    task: { project_id: "project-from-claim" },
    terminalState: "completed",
  });
  assert.equal(result.localWake.project_id, "project-from-response");
});

test("local fallback persists each task wake_target independently", async (t) => {
  const outbox = await makeOutbox(t);
  const coordinator = new WakeCoordinator({ outbox });
  const targetA = { type: "chatgpt_conversation", conversation_id: "conv-a", url: "https://chatgpt.com/c/conv-a", source: "test" };
  const targetB = { type: "chatgpt_conversation", conversation_id: "conv-b", url: "https://chatgpt.com/c/conv-b", source: "test" };
  const b = await coordinator.acceptResponse({ project_id: "project-b" }, { taskId: "task-b", terminalState: "completed", wakeTarget: targetB });
  const a = await coordinator.acceptResponse({ project_id: "project-a" }, { taskId: "task-a", terminalState: "completed", wakeTarget: targetA });
  assert.equal((await outbox.findByMessageKey(b.localWake.message_key)).wake_target.url, targetB.url);
  assert.equal((await outbox.findByMessageKey(a.localWake.message_key)).wake_target.url, targetA.url);
});

test("invalid Cloud wake target is rejected with an explicit diagnostic", async (t) => {
  const outbox = await makeOutbox(t);
  const warnings = [];
  const coordinator = new WakeCoordinator({ outbox, logger: { warn(...args) { warnings.push(args); } } });
  await assert.rejects(coordinator.acceptResponse({ bridge_delivery: {
    delivery_id: "delivery-bad-target", message_key: "message-bad-target", project_id: "project-1", event_id: "event-1",
    task_id: "task-1", event_name: "task.completed", project_revision: 1,
    wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/" },
  } }), /bridge_wake_target_invalid/u);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /rejected delivery target/u);
  assert.equal((await outbox.listPending()).length, 0);
});

test("permanent Cloud wake target conflicts are reported to Site and stop retrying", async (t) => {
  const outbox = await makeOutbox(t);
  const outboxTarget = { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conversation-A" };
  await outbox.enqueueLocal({ projectId: "project-1", taskId: "task-1", terminalState: "completed", wakeTarget: outboxTarget });
  const rejected = [];
  const coordinator = new WakeCoordinator({
    outbox,
    transport: { async rejectCloudDelivery(row, reason) { rejected.push({ row, reason }); return true; } },
  });
  const conflicting = {
    delivery_id: "delivery-conflict", message_key: (await outbox.listPending())[0].message_key,
    project_id: "project-1", event_id: "event-1", task_id: "task-1", event_name: "task.completed", project_revision: 1,
    wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conversation-B" },
  };
  const first = await coordinator.acceptResponse({ bridge_delivery: conflicting });
  const second = await coordinator.acceptResponse({ bridge_delivery: conflicting });
  assert.equal(first.diagnostic.code, "bridge_wake_target_conflict");
  assert.equal(second.diagnostic.code, "bridge_wake_target_conflict");
  assert.equal(rejected.length, 2, "rejection is retried only until the Site confirms its durable terminal record");
  assert.equal(rejected[0].reason, "bridge_wake_target_conflict");
  assert.equal((await outbox.listPending()).length, 1, "the existing delivery is preserved without rebinding");
});

test("invalid local wake target returns a diagnostic and is not queued", async (t) => {
  const outbox = await makeOutbox(t);
  const warnings = [];
  const coordinator = new WakeCoordinator({ outbox, logger: { warn(...args) { warnings.push(args); } } });
  const result = await coordinator.acceptResponse({ project_id: "project-1" }, {
    taskId: "task-invalid-target", terminalState: "completed", wakeTarget: { type: "chatgpt_conversation", url: "https://chatgpt.com/" },
  });
  assert.equal(result.diagnostic.code, "bridge_wake_target_invalid");
  assert.equal((await outbox.listPending()).length, 0);
  assert.equal(warnings.length, 1);
});

test("missing project identity returns an explicit diagnostic and does not silently no-op", async (t) => {
  const outbox = await makeOutbox(t);
  const warnings = [];
  let kicks = 0;
  const coordinator = new WakeCoordinator({
    outbox,
    transport: { kick() { kicks += 1; } },
    logger: { warn(...args) { warnings.push(args); } },
  });
  const result = await coordinator.acceptResponse({}, { taskId: "task-no-project", terminalState: "failed" });

  assert.deepEqual(result, {
    accepted: 0,
    localWake: null,
    diagnostic: {
      code: "terminal_project_identity_missing",
      taskId: "task-no-project",
      terminalState: "failed",
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal((await outbox.listPending()).length, 0);
  assert.equal(kicks, 0);
});

test("disabled coordinator neither persists nor wakes", async (t) => {
  const outbox = await makeOutbox(t);
  let kicks = 0;
  const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks += 1; } }, enabled: false });
  assert.deepEqual(await coordinator.acceptResponse({ project_id: "project-1" }, { taskId: "task-1", task: { project_id: "project-1" }, terminalState: "completed" }), { accepted: 0, localWake: null });
  assert.equal((await outbox.listPending()).length, 0);
  assert.equal(kicks, 0);
});
