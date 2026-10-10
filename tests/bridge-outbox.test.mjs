import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BridgeWakeOutbox, buildLocalWakeMessage, localWakeMessageKey } from "../lib/bridge-outbox.mjs";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function runConnectorBridgeIntegration({ filePath, config, response, terminal }) {
  const encodedFilePath = JSON.stringify(filePath);
  const encodedConfig = JSON.stringify(config);
  const encodedResponse = JSON.stringify(response);
  const encodedTerminal = JSON.stringify(terminal);
  const code = `
    const { deliverBridgePayloads } = await import('./index.js');
    const { BridgeWakeOutbox } = await import('./lib/bridge-outbox.mjs');
    const { WakeCoordinator } = await import('./lib/wake-coordinator.mjs');
    const outbox = new BridgeWakeOutbox({ filePath: ${encodedFilePath} });
    const kicks = [];
    const coordinator = new WakeCoordinator({ outbox, transport: { kick() { kicks.push(true); } } });
    await deliverBridgePayloads(${encodedConfig}, ${encodedResponse}, coordinator, ${encodedTerminal});
    process.stdout.write(JSON.stringify({ kicks: kicks.length, pending: await outbox.listPending() }));
  `;
  const child = spawnSync(process.execPath, ["--experimental-loader", "./tests/support/host-loader.mjs", "--input-type=module", "-e", code], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

async function abandonLegacyAttempt(filePath) {
  const db = JSON.parse(await readFile(filePath, 'utf8'));
  for (const row of db.deliveries) delete row.send_owner_pid;
  await writeFile(filePath, JSON.stringify(db));
}

async function temporaryOutbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsw-bridge-outbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filePath: join(directory, "outbox.json") };
}

test("local wake key is deterministic and message excludes result/log/path/credentials", () => {
  const message_key = localWakeMessageKey("project-a", "task-a", "completed");
  assert.equal(message_key, localWakeMessageKey("project-a", "task-a", "completed"));
  assert.notEqual(message_key, localWakeMessageKey("project-a", "task-b", "completed"));
  assert.notEqual(message_key, localWakeMessageKey("project-a", "task-a", "failed"));
  const text = buildLocalWakeMessage({ project_id: "project-a", task_id: "task-a", terminal_state: "completed", message_key, result: "private", log: "private", path: "private", token: "private", cookie: "private" });
  assert.match(text, /STATE: PROJECT_EVENT_PENDING/u);
  assert.match(text, /MESSAGE_KEY: dsw-wake-/u);
  assert.doesNotMatch(text, /private|token|cookie|path|result:/iu);
});

test("outbox persists the required record fields and quarantines an interrupted send after restart", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const firstProcess = new BridgeWakeOutbox({ filePath, now: () => "2026-10-06T00:00:00.000Z" });
  const queued = await firstProcess.enqueueLocal({ projectId: "project-a", taskId: "task-a", terminalState: "failed" });
  assert.equal(queued.delivery_state, "pending");
  assert.equal(queued.attempts, 0);
  const attempt = await firstProcess.beginAttempt(queued.message_key);
  assert.equal(attempt.delivery_state, "sending");

  await abandonLegacyAttempt(filePath);
  const restarted = new BridgeWakeOutbox({ filePath, now: () => "2026-10-06T00:01:00.000Z" });
  await restarted.initialize();
  assert.equal((await restarted.listPending()).length, 0);
  const [recovered] = await restarted.listUncertain();
  assert.equal(recovered.message_key, queued.message_key);
  assert.equal(recovered.delivery_state, "uncertain");
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.last_error, "process_restarted_during_send");
  assert.equal(recovered.delivered_at, null);
  const [retry] = await restarted.listUncertain();
  const safeDraft = await restarted.resolveUncertain(retry.message_key, "safe_draft");
  assert.equal(safeDraft.delivery_state, "pending");
  assert.equal(safeDraft.recovery_attempts, 1);
  assert.equal((await restarted.beginAttempt(retry.message_key)).attempts, 2);
  await restarted.markFailed(retry.message_key, Object.assign(new Error("submission result uncertain"), { code: "bridge_send_uncertain" }));
  const quarantined = await restarted.findByMessageKey(retry.message_key);
  assert.equal(quarantined.delivery_state, "uncertain");
  assert.equal(quarantined.send_state, "uncertain");
  assert.equal((await restarted.resolveUncertain(retry.message_key, "safe_draft")).delivery_state, "uncertain", "only one post-restart recovery send is allowed");
  await restarted.markDelivered(retry.message_key);
  const persisted = JSON.parse(await readFile(filePath, "utf8")).deliveries[0];
  for (const field of ["message_key", "project_id", "task_id", "terminal_state", "created_at", "delivery_state", "attempts", "last_error", "delivered_at"]) {
    assert.ok(Object.hasOwn(persisted, field), `missing ${field}`);
  }
  assert.equal(persisted.delivery_state, "delivered");
  assert.equal(persisted.last_error, null);
  assert.equal(typeof persisted.delivered_at, "string");
});

test("ambiguous send errors stay out of pending and survive another Outbox instance", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const first = new BridgeWakeOutbox({ filePath });
  const queued = await first.enqueueLocal({ projectId: "project-a", taskId: "task-ambiguous", terminalState: "completed" });
  await first.beginAttempt(queued.message_key);
  await first.markFailed(queued.message_key, Object.assign(new Error("do not retry"), { code: "bridge_send_uncertain" }));
  const restarted = new BridgeWakeOutbox({ filePath });
  assert.equal((await restarted.listPending()).length, 0);
  const [uncertain] = await restarted.listUncertain();
  assert.equal(uncertain.message_key, queued.message_key);
  assert.equal(uncertain.delivery_state, "uncertain");
});

test("transient send failures use durable exponential backoff and retain sanitized failure evidence", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-08T00:00:00.000Z";
  const outbox = new BridgeWakeOutbox({ filePath, now: () => now, retryBaseMs: 1000, retryMaxMs: 4000 });
  const queued = await outbox.enqueueLocal({ projectId: "project-a", taskId: "task-backoff", terminalState: "completed" });

  await outbox.beginAttempt(queued.message_key);
  const first = await outbox.markFailed(queued.message_key, new Error("transient connection failure"));
  assert.equal(first.next_attempt_at, "2026-10-08T00:00:01.000Z");
  assert.equal(first.last_failure, "transient connection failure");
  assert.equal(await outbox.beginAttempt(queued.message_key), null);

  now = "2026-10-08T00:00:01.000Z";
  await outbox.beginAttempt(queued.message_key);
  const second = await outbox.markFailed(queued.message_key, new Error("transient connection failure"));
  assert.equal(second.next_attempt_at, "2026-10-08T00:00:03.000Z");

  const restarted = new BridgeWakeOutbox({ filePath, now: () => now, retryBaseMs: 1000, retryMaxMs: 4000 });
  assert.equal((await restarted.listPending()).length, 0, "restart preserves the scheduled delay");
  now = "2026-10-08T00:00:03.000Z";
  assert.equal((await restarted.beginAttempt(queued.message_key)).attempts, 3);
  const persisted = JSON.parse(await readFile(filePath, "utf8")).deliveries[0];
  assert.equal(persisted.last_failure, "transient connection failure");
});

test("wake_target survives local queue restart and preserves legacy rows without a target", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const target = { type: "chatgpt_conversation", conversation_id: "conv-a", url: "https://chatgpt.com/c/conv-a", source: "contract", captured_at: "2026-10-08T00:00:00.000Z" };
  const outbox = new BridgeWakeOutbox({ filePath });
  const queued = await outbox.enqueueLocal({ projectId: "project-a", taskId: "task-a", terminalState: "completed", wakeTarget: target });
  await outbox.enqueueLocal({ projectId: "project-b", taskId: "task-b", terminalState: "completed" });
  const restarted = new BridgeWakeOutbox({ filePath });
  const pending = await restarted.listPending();
  assert.deepEqual(pending.find((row) => row.message_key === queued.message_key).wake_target, {
    type: "chatgpt_conversation", conversation_id: "conv-a", url: "https://chatgpt.com/c/conv-a", source: "contract", captured_at: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(Object.hasOwn(pending.find((row) => row.task_id === "task-b"), "wake_target"), false);
});

test("Windows outbox recovery restores backup only when canonical file is absent", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const seed = new BridgeWakeOutbox({ filePath, platform: "win32" });
  await seed.enqueueLocal({ projectId: "project-a", taskId: "task-a", terminalState: "completed" });
  const canonical = JSON.parse(await readFile(filePath, "utf8"));
  const backup = `${filePath}.bak`;
  await (await import("node:fs/promises")).rename(filePath, backup);

  const recovered = new BridgeWakeOutbox({ filePath, platform: "win32" });
  const pending = await recovered.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].task_id, "task-a");
  const restoredCanonical = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(restoredCanonical.deliveries[0].message_key, canonical.deliveries[0].message_key);
  assert.equal(restoredCanonical.deliveries[0].task_id, canonical.deliveries[0].task_id);

  const newer = new BridgeWakeOutbox({ filePath, platform: "win32" });
  await newer.enqueueLocal({ projectId: "project-a", taskId: "task-b", terminalState: "failed" });
  await (await import("node:fs/promises")).writeFile(backup, JSON.stringify({ version: 1, deliveries: [] }));
  const preferredCanonical = new BridgeWakeOutbox({ filePath, platform: "win32" });
  assert.equal((await preferredCanonical.listPending()).length, 2);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).deliveries.length, 2, "canonical records remain preferred after schema normalization");
});

test("formal Cloud delivery supersedes an unsent local wake for the same terminal task", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const outbox = new BridgeWakeOutbox({ filePath });
  const local = await outbox.enqueueLocal({ projectId: "project-a", taskId: "task-a", terminalState: "completed" });
  await outbox.supersedeLocal({ projectId: "project-a", taskId: "task-a", terminalState: "completed" });
  const adopted = await outbox.adoptCloudDelivery({
    messageKey: "cloud-message-a", projectId: "project-a", taskId: "task-a", eventName: "task.completed",
    deliveryId: "delivery-a", eventId: "event-a", revision: 8,
  });
  assert.equal(adopted.row.source, "cloud");
  assert.equal(adopted.row.delivery_state, "pending");
  assert.equal(await outbox.findByMessageKey(local.message_key).then((row) => row.delivery_state), "superseded");
  assert.deepEqual((await outbox.listPending()).map((row) => row.message_key), ["cloud-message-a"]);
});

test("terminal response is durably queued before transport is kicked", async (t) => {
  const { directory } = await temporaryOutbox(t);
  const response = { project_id: "project-a" };
  const config = { chatBridgeEnabled: true };
  const terminal = { taskId: "task-a", terminalState: "completed" };
  const local = await runConnectorBridgeIntegration({ filePath: join(directory, "integration.json"), config, response, terminal });
  assert.equal(local.kicks, 1);
  assert.equal(local.pending.length, 1);
  assert.equal(local.pending[0].source, "local");
  assert.equal(local.pending[0].message_key, localWakeMessageKey("project-a", "task-a", "completed"));

  const envelope = {
    delivery_id: "delivery-a", message_key: "cloud-message", project_id: "project-a", event_id: "event-a",
    task_id: "task-a", event_name: "task.completed", project_revision: 2,
  };
  const cloud = await runConnectorBridgeIntegration({ filePath: join(directory, "cloud.json"), config, response: { ...response, bridge_delivery: envelope }, terminal });
  assert.equal(cloud.kicks, 1);
  assert.equal(cloud.pending.length, 1);
  assert.equal(cloud.pending[0].source, "cloud");
  assert.equal(cloud.pending[0].message_key, "cloud-message");

  const disabled = await runConnectorBridgeIntegration({ filePath: join(directory, "disabled.json"), config: { chatBridgeEnabled: false }, response, terminal });
  assert.equal(disabled.kicks, 0);
  assert.equal(disabled.pending.length, 0);
});

test("Cloud delivery recovery preserves its own wake_target and target conflicts are rejected", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const target = { type: "chatgpt_conversation", conversation_id: "conv-cloud", url: "https://chatgpt.com/c/conv-cloud", source: "site-contract" };
  const envelope = { messageKey: "cloud-targeted", projectId: "project-cloud", taskId: "task-cloud", eventName: "task.completed", deliveryId: "delivery-cloud", eventId: "event-cloud", revision: 4, wakeTarget: target };
  const first = new BridgeWakeOutbox({ filePath });
  await first.adoptCloudDelivery(envelope);
  const recovered = new BridgeWakeOutbox({ filePath });
  assert.equal((await recovered.findByMessageKey("cloud-targeted")).wake_target.url, target.url);
  await assert.rejects(recovered.adoptCloudDelivery({ ...envelope, wakeTarget: { ...target, url: "https://chatgpt.com/c/other" } }), /bridge_wake_target_conflict/u);
});

test("legacy uncertain Cloud rows acquire durable reconciliation fields without changing identity", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-08T00:00:00.000Z";
  const legacy = {
    version: 1,
    deliveries: [{
      message_key: "legacy-message-key", project_id: "legacy-project", task_id: "legacy-task", terminal_state: "completed",
      created_at: "2026-10-07T00:00:00.000Z", delivery_state: "uncertain", attempts: 2, recovery_attempts: 0,
      send_state: "uncertain", last_error: "process_restarted_during_send", source: "cloud", delivery_id: "legacy-delivery",
      event_id: "legacy-event", event_name: "task.completed", project_revision: 3, wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/original" },
    }],
  };
  await writeFile(filePath, JSON.stringify(legacy), "utf8");
  const outbox = new BridgeWakeOutbox({ filePath, now: () => now, reconcileBaseMs: 1000, reconcileMaxMs: 4000, manualReviewThreshold: 1 });
  const [row] = await outbox.listUncertain();
  assert.equal(row.message_key, "legacy-message-key");
  assert.equal(row.wake_target.url, "https://chatgpt.com/c/original");
  assert.equal(row.reconcile_attempts, 0);
  assert.equal(row.next_reconcile_at, null);
  assert.equal(row.cloud_ack_state, "pending");
  const updated = await outbox.recordReconciliation(row.message_key, { stage: "page_confirmation", reason: "token=secret https://chatgpt.com/c/private-id C:\\Users\\Alice\\state.json" });
  assert.equal(updated.reconcile_attempts, 1);
  assert.equal(updated.reconcile_manual_intervention, true);
  assert.doesNotMatch(updated.last_reconcile_error, /secret|Alice|state\.json|private-id/iu);
  assert.equal(updated.next_reconcile_at, "2026-10-08T00:00:01.000Z");
  const persisted = JSON.parse(await readFile(filePath, "utf8")).deliveries[0];
  assert.equal(persisted.message_key, "legacy-message-key");
  assert.equal(persisted.delivery_id, "legacy-delivery");
  assert.equal(persisted.event_id, "legacy-event");
  assert.equal(persisted.wake_target.url, "https://chatgpt.com/c/original");

  now = persisted.next_reconcile_at;
  const restarted = new BridgeWakeOutbox({ filePath, now: () => now });
  assert.equal((await restarted.listUncertain()).length, 0, "manual intervention boundary suppresses automatic checks");
  assert.equal((await restarted.findByMessageKey(row.message_key)).delivery_state, "uncertain", "the legacy record remains durable");
});

test("reconciliation lock survives restart until its bounded lease expires", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-08T00:00:00.000Z";
  const first = new BridgeWakeOutbox({ filePath, now: () => now, reconcileLockMs: 1000 });
  const queued = await first.enqueueLocal({ projectId: "project-lock", taskId: "task-lock", terminalState: "completed" });
  await first.beginAttempt(queued.message_key);
  await first.markFailed(queued.message_key, Object.assign(new Error("uncertain"), { code: "bridge_send_uncertain" }));
  const [uncertain] = await first.listUncertain();
  assert.ok(await first.beginReconciliation(uncertain.message_key));
  const restarted = new BridgeWakeOutbox({ filePath, now: () => now, reconcileLockMs: 1000 });
  assert.equal((await restarted.listUncertain()).length, 0, "restart does not immediately duplicate an in-flight check");
  now = "2026-10-08T00:00:01.000Z";
  assert.equal((await restarted.listUncertain()).length, 1, "an interrupted check becomes eligible after its lock lease");
});

test("Cloud recovery enriches the same targetless failed Outbox row without resetting identity or diagnostics", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const target = { type: "chatgpt_conversation", url: "https://chatgpt.com/c/original-project-chat", source: "site_project_binding" };
  const envelope = { messageKey: "bridge-original-message", projectId: "project-original", taskId: "task-original", eventName: "task.completed", deliveryId: "delivery-original", eventId: "event-original", revision: 19 };
  const first = new BridgeWakeOutbox({ filePath });
  await first.adoptCloudDelivery(envelope);
  await first.beginAttempt(envelope.messageKey);
  await first.markFailed(envelope.messageKey, new Error("Chat Bridge has no wake target for this delivery"));

  const restarted = new BridgeWakeOutbox({ filePath });
  const before = await restarted.findByMessageKey(envelope.messageKey);
  const enriched = await restarted.adoptCloudDelivery({ ...envelope, wakeTarget: target });
  assert.equal(enriched.row.message_key, envelope.messageKey);
  assert.equal(enriched.row.delivery_id, envelope.deliveryId);
  assert.equal(enriched.row.event_id, envelope.eventId);
  assert.equal(enriched.row.project_revision, envelope.revision);
  assert.equal(enriched.row.wake_target.url, target.url);
  assert.equal(enriched.row.attempts, before.attempts);
  assert.equal(enriched.row.last_error, before.last_error);
  assert.equal(enriched.row.last_failure, before.last_failure);
  assert.equal(enriched.row.next_attempt_at, before.next_attempt_at);
  assert.equal(enriched.row.delivery_state, before.delivery_state);
});

test("independent outbox instances serialize enqueue and never quarantine a live sender", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const a = new BridgeWakeOutbox({ filePath });
  const b = new BridgeWakeOutbox({ filePath });
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).enqueueLocal({ projectId: "parallel", taskId: `task-${i}`, terminalState: "completed" })));
  assert.equal((await a.listPending()).length, 20);
  const row = (await a.listPending())[0];
  await a.beginAttempt(row.message_key);
  const freshInstance = new BridgeWakeOutbox({ filePath });
  assert.equal((await freshInstance.findByMessageKey(row.message_key)).delivery_state, "sending");
  assert.equal((await freshInstance.listUncertain()).length, 0);
  assert.equal(await freshInstance.beginAttempt(row.message_key), null);
});

test("a genuinely exited send process recovers as uncertain without resending", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const code = `const { BridgeWakeOutbox } = await import('./lib/bridge-outbox.mjs'); const box = new BridgeWakeOutbox({filePath:${JSON.stringify(filePath)}}); const row = await box.enqueueLocal({projectId:'exit-project',taskId:'exit-task',terminalState:'completed'}); await box.beginAttempt(row.message_key);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const box = new BridgeWakeOutbox({ filePath });
  const [row] = await box.listUncertain();
  assert.equal(row.last_error, "process_restarted_during_send");
  assert.equal(row.attempts, 1);
  assert.equal((await box.listPending()).length, 0);
});

test("separate processes preserve concurrent durable enqueues", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  await Promise.all(Array.from({ length: 3 }, (_, worker) => new Promise((done, reject) => {
    const code = `const { BridgeWakeOutbox } = await import('./lib/bridge-outbox.mjs'); const box = new BridgeWakeOutbox({filePath:${JSON.stringify(filePath)}}); for(let i=0;i<8;i++) await box.enqueueLocal({projectId:'multi-process',taskId:'worker-${worker}-'+i,terminalState:'completed'});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? done() : reject(new Error(errors)));
  })));
  const box = new BridgeWakeOutbox({ filePath });
  assert.equal((await box.listPending()).length, 24);
});

test("more than 2000 settled receipts retain old dedup keys and pending Cloud ACKs", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const box = new BridgeWakeOutbox({ filePath });
  const old = await box.enqueueLocal({ projectId: "receipts", taskId: "old", terminalState: "completed" });
  await box.markDelivered(old.message_key);
  const receipt = await box.findByMessageKey(old.message_key);
  const rows = [receipt, ...Array.from({ length: 2000 }, (_, i) => ({ ...receipt, message_key: `receipt-${i}`, task_id: `task-${i}` }))];
  rows[1] = { ...rows[1], source: "cloud", cloud_ack_state: "pending", delivery_id: "unacked", event_id: "event", cloud_ack_attempts: 0 };
  await writeFile(filePath, JSON.stringify({ version: 1, deliveries: rows }));
  const replay = await box.enqueueLocal({ projectId: "receipts", taskId: "old", terminalState: "completed" });
  assert.equal(replay.delivery_state, "delivered");
  assert.equal((await box.listPending()).length, 0);
  assert.equal((await box.listPendingCloudAcks()).length, 1);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).deliveries.length, 2001);
});

test("reconciliation stops at both count and elapsed-time boundaries and retains identity", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-09T00:00:00.000Z";
  const box = new BridgeWakeOutbox({ filePath, now: () => now, manualReviewThreshold: 2, reconcileBaseMs: 0, recoveryWindowMs: 1000 });
  const row = await box.enqueueLocal({ projectId: "bound", taskId: "count", terminalState: "completed" });
  await box.markFailed(row.message_key, Object.assign(new Error("uncertain"), { code: "bridge_send_uncertain" }));
  for (let i = 0; i < 2; i++) { assert.ok(await box.beginReconciliation(row.message_key)); await box.recordReconciliation(row.message_key, { reason: "target_missing" }); }
  assert.equal(await box.beginReconciliation(row.message_key), null);
  const elapsed = await box.enqueueLocal({ projectId: "bound", taskId: "time", terminalState: "completed" });
  await box.markFailed(elapsed.message_key, Object.assign(new Error("uncertain"), { code: "bridge_send_uncertain" }));
  now = "2026-10-09T00:00:01.000Z";
  assert.equal(await box.beginReconciliation(elapsed.message_key), null);
  assert.equal((await box.findByMessageKey(elapsed.message_key)).reconcile_manual_intervention, true);
  assert.equal((await box.listUncertain()).length, 0);
  assert.equal((await box.findByMessageKey(row.message_key)).delivery_state, "uncertain");
});

test("pending retries and ACK-only retries stop at count and time boundaries without pretending success", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-09T00:00:00.000Z";
  const box = new BridgeWakeOutbox({ filePath, now: () => now, manualReviewThreshold: 2, retryBaseMs: 0, recoveryWindowMs: 1000 });
  const pending = await box.enqueueLocal({ projectId: "bounded", taskId: "pending-count", terminalState: "completed" });
  for (let i = 0; i < 2; i++) { assert.ok(await box.beginAttempt(pending.message_key)); await box.markFailed(pending.message_key, new Error("login required")); }
  assert.equal(await box.beginAttempt(pending.message_key), null);
  assert.equal((await box.findByMessageKey(pending.message_key)).delivery_manual_intervention, true);
  const time = await box.enqueueLocal({ projectId: "bounded", taskId: "pending-time", terminalState: "completed" });
  await box.beginAttempt(time.message_key); await box.markFailed(time.message_key, new Error("offline"));
  const cloud = (await box.adoptCloudDelivery({ deliveryId: "ack-bounded", messageKey: "ack-bounded", projectId: "bounded", taskId: "ack-count", eventId: "event", eventName: "task.completed", revision: 1 })).row;
  await box.markDelivered(cloud.message_key);
  for (let i = 0; i < 2; i++) { assert.ok(await box.beginCloudAck(cloud.message_key)); await box.failCloudAck(cloud.message_key, new Error("offline")); }
  assert.equal(await box.beginCloudAck(cloud.message_key), null);
  assert.equal((await box.findByMessageKey(cloud.message_key)).cloud_ack_manual_intervention, true);
  const ackTime = (await box.adoptCloudDelivery({ deliveryId: "ack-time", messageKey: "ack-time", projectId: "bounded", taskId: "ack-time", eventId: "time-event", eventName: "task.completed", revision: 1 })).row;
  await box.markDelivered(ackTime.message_key); await box.beginCloudAck(ackTime.message_key); await box.failCloudAck(ackTime.message_key, new Error("offline"));
  now = "2026-10-09T00:00:01.000Z";
  assert.equal(await box.beginAttempt(time.message_key), null);
  assert.equal(await box.beginCloudAck(ackTime.message_key), null);
  assert.equal((await box.listPending()).length, 0);
  assert.equal((await box.listPendingCloudAcks()).length, 0);
  assert.equal((await box.findByMessageKey(cloud.message_key)).cloud_ack_state, "pending");
  assert.equal((await box.findByMessageKey(cloud.message_key)).orchestrator_handled, null);
});

test("same-key local adoption becomes Cloud ACK work without resetting its delivery", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const box = new BridgeWakeOutbox({ filePath });
  const local = await box.enqueueLocal({ projectId: "same-key", taskId: "task", terminalState: "completed" });
  await box.markDelivered(local.message_key);
  const adopted = await box.adoptCloudDelivery({ deliveryId: "formal", messageKey: local.message_key, projectId: "same-key", taskId: "task", eventId: "event", eventName: "task.completed", revision: 1 });
  assert.equal(adopted.alreadyDelivered, true);
  assert.equal(adopted.row.source, "cloud");
  assert.equal((await box.listPendingCloudAcks())[0].message_key, local.message_key);
});

test("Windows backup-only recovery survives a second process crash before committing the canonical file", async (t) => {
  const { filePath, directory } = await temporaryOutbox(t);
  const box = new BridgeWakeOutbox({ filePath, platform: "win32" });
  const receipt = await box.enqueueLocal({ projectId: "second-crash", taskId: "task", terminalState: "completed" });
  await box.markDelivered(receipt.message_key);
  await (await import("node:fs/promises")).rename(filePath, `${filePath}.bak`);
  const loaderPath = join(directory, "crash-loader.mjs");
  await writeFile(loaderPath, `export async function load(url, context, next) { const result = await next(url, context); if (url.endsWith('/lib/bridge-outbox.mjs')) { result.source = String(result.source).replace('await rename(temporary, this.filePath);', 'process.exit(73);'); } return result; }`);
  const code = `const { BridgeWakeOutbox } = await import('./lib/bridge-outbox.mjs'); await new BridgeWakeOutbox({filePath:${JSON.stringify(filePath)},platform:'win32'}).initialize();`;
  const child = spawnSync(process.execPath, ["--loader", pathToFileURL(loaderPath).href, "--input-type=module", "-e", code], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(JSON.parse(await readFile(`${filePath}.bak`, "utf8")).deliveries[0].message_key, receipt.message_key);
  const afterSecondCrash = new BridgeWakeOutbox({ filePath, platform: "win32" });
  assert.equal((await afterSecondCrash.enqueueLocal({ projectId: "second-crash", taskId: "task", terminalState: "completed" })).delivery_state, "delivered");
  assert.equal((await afterSecondCrash.listPending()).length, 0);
});

test("legacy missing stages remain unknown and a live reused-owner claim reaches manual review", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  let now = "2026-10-09T00:00:00.000Z";
  const box = new BridgeWakeOutbox({ filePath, now: () => now, recoveryWindowMs: 1000 });
  const row = await box.enqueueLocal({ projectId: "owner", taskId: "task", terminalState: "completed" });
  await box.beginAttempt(row.message_key);
  const db = JSON.parse(await readFile(filePath, "utf8"));
  for (const field of ["delivery_stage", "message_visible", "transport_acked", "draft_verified", "submit_attempted"]) delete db.deliveries[0][field];
  await writeFile(filePath, JSON.stringify(db));
  assert.equal((await box.findByMessageKey(row.message_key)).delivery_stage, null);
  assert.equal((await box.findByMessageKey(row.message_key)).message_visible, null);
  now = "2026-10-09T00:00:01.000Z";
  assert.equal((await box.listUncertain()).length, 0);
  const retained = await box.findByMessageKey(row.message_key);
  assert.equal(retained.delivery_state, "sending");
  assert.equal(retained.delivery_manual_intervention, true);
});

test("durable submit intent makes an unclassified failure uncertain and survives a real process exit", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const box = new BridgeWakeOutbox({ filePath });
  const row = await box.enqueueLocal({ projectId: "intent", taskId: "generic-error", terminalState: "completed" });
  await box.beginAttempt(row.message_key);
  await box.recordSendProgress(row.message_key, "draft_verified");
  await box.recordSendProgress(row.message_key, "submit_attempted");
  await box.markFailed(row.message_key, new Error("unexpected adapter failure"));
  assert.equal((await box.findByMessageKey(row.message_key)).send_state, "uncertain");
  assert.equal((await box.listPending()).length, 0);

  const code = `const { BridgeWakeOutbox } = await import('./lib/bridge-outbox.mjs'); const box = new BridgeWakeOutbox({filePath:${JSON.stringify(filePath)}}); const row = await box.enqueueLocal({projectId:'intent',taskId:'real-exit',terminalState:'completed'}); await box.beginAttempt(row.message_key); await box.recordSendProgress(row.message_key,'draft_verified'); await box.recordSendProgress(row.message_key,'submit_attempted');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const recovered = (await box.listUncertain()).find((item) => item.task_id === "real-exit");
  assert.equal(recovered.delivery_stage, "submit_attempted");
  assert.equal(recovered.send_state, "uncertain");
});
