import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("outbox persists the required record fields and retries after process restart", async (t) => {
  const { filePath } = await temporaryOutbox(t);
  const firstProcess = new BridgeWakeOutbox({ filePath, now: () => "2026-10-06T00:00:00.000Z" });
  const queued = await firstProcess.enqueueLocal({ projectId: "project-a", taskId: "task-a", terminalState: "failed" });
  assert.equal(queued.delivery_state, "pending");
  assert.equal(queued.attempts, 0);
  const attempt = await firstProcess.beginAttempt(queued.message_key);
  assert.equal(attempt.delivery_state, "sending");

  const restarted = new BridgeWakeOutbox({ filePath, now: () => "2026-10-06T00:01:00.000Z" });
  await restarted.initialize();
  const [recovered] = await restarted.listPending();
  assert.equal(recovered.message_key, queued.message_key);
  assert.equal(recovered.delivery_state, "pending");
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.last_error, null);
  assert.equal(recovered.delivered_at, null);
  await restarted.markFailed(recovered.message_key, "browser unavailable");
  const [retry] = await restarted.listPending();
  assert.equal(retry.last_error, "browser unavailable");
  assert.equal((await restarted.beginAttempt(retry.message_key)).attempts, 2);
  await restarted.markDelivered(retry.message_key);
  const persisted = JSON.parse(await readFile(filePath, "utf8")).deliveries[0];
  for (const field of ["message_key", "project_id", "task_id", "terminal_state", "created_at", "delivery_state", "attempts", "last_error", "delivered_at"]) {
    assert.ok(Object.hasOwn(persisted, field), `missing ${field}`);
  }
  assert.equal(persisted.delivery_state, "delivered");
  assert.equal(persisted.last_error, null);
  assert.equal(typeof persisted.delivered_at, "string");
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
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), canonical);

  const newer = new BridgeWakeOutbox({ filePath, platform: "win32" });
  await newer.enqueueLocal({ projectId: "project-a", taskId: "task-b", terminalState: "failed" });
  await (await import("node:fs/promises")).writeFile(backup, JSON.stringify({ version: 1, deliveries: [] }));
  const preferredCanonical = new BridgeWakeOutbox({ filePath, platform: "win32" });
  assert.equal((await preferredCanonical.listPending()).length, 2);
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