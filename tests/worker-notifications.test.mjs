import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function runProbe() {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-loader", "./tests/support/host-loader.mjs",
    "./tests/support/worker-notifications-probe.mjs",
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `worker notification probe failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return JSON.parse(stdout);
}

const results = await runProbe();

test("both notification methods are exposed through the authorized Host Remote namespace", () => {  assert.deepEqual(results.discovered, [
    { method: "taskNotifications", serviceKey: "deepseekWorkerConnectorControl", isService: true },
    { method: "markTaskNotificationsRead", serviceKey: "deepseekWorkerConnectorControl", isService: true },
  ]);
  assert.equal(results.secondServiceAlive, "deepseekWorkerConnectorControl");
});

test("taskNotifications answers the agreed shape before any task has finished", () => {
  assert.deepEqual(results.initial, { items: [], unreadCount: 0, activeTaskCount: 0 });
});

test("a confirmed completion becomes a readable local notification with a sanitized preview", () => {
  const payload = results.afterCompleted;
  assert.equal(payload.unreadCount, 1);
  assert.equal(payload.activeTaskCount, 0);
  assert.equal(payload.items.length, 1);
  const [item] = payload.items;
  assert.deepEqual(Object.keys(item).sort(), ["at", "error", "key", "read", "summary", "taskId", "terminalState"]);
  assert.match(item.key, /^ntf-[0-9a-f]{32}$/u);
  assert.equal(item.taskId, "task-completed");
  assert.equal(item.terminalState, "completed");
  assert.equal(item.read, false);
  assert.equal(item.error, "");
  assert.match(item.summary, /Installed dependencies and ran the unit suite/u);
  assert.match(item.summary, /285 tests passed/u);
  assert.equal(item.summary.includes("C:\\Users\\Aevyr"), false, "the preview must not carry a local path");
  assert.equal(item.summary.includes("chatgpt.com"), false, "the preview must not carry a conversation URL");
  assert.equal(item.summary.includes("abcdef1234567890"), false, "the preview must not carry a token");
  assert.ok(item.summary.length <= 500);
});

test("a replayed terminal upload never duplicates a notification", () => {
  assert.deepEqual(results.afterReplay.items, results.afterCompleted.items);
  assert.equal(results.afterReplay.unreadCount, 1);
});

test("a failed task notifies with a redacted error and stays separate from completions", () => {
  const payload = results.afterFailure;
  assert.equal(payload.unreadCount, 2);
  const failed = payload.items.find((item) => item.taskId === "task-failed");
  assert.equal(failed.terminalState, "failed");
  assert.equal(failed.read, false);
  assert.equal(failed.summary, "");
  assert.match(failed.error, /Native Session failed/u);
  assert.equal(failed.error.includes("C:\\Users\\Aevyr"), false);
  assert.equal(failed.error.includes("abcdef0123456789"), false);
  assert.equal(payload.items.find((item) => item.taskId === "task-completed").terminalState, "completed");
});

test("an unconfirmed Cloud upload never masquerades as a local terminal", () => {
  assert.equal(results.cloudResultUploads, 3, "the successful and replayed uploads plus the rejected one were all attempted");
  assert.equal(results.resultRejected, 1, "the rejected result upload really reached Cloud and was refused");
  assert.equal(results.failureRejected, 1, "the rejected failure upload really reached Cloud and was refused");
  assert.equal(results.cloudFailureUploads, 2);
  assert.deepEqual(
    results.afterFailedUploads.items.map((item) => item.taskId).sort(),
    ["task-completed", "task-failed"],
    "tasks whose terminal upload failed must not appear locally",
  );
  assert.equal(results.afterFailedUploads.unreadCount, 2);
  assert.equal(results.cloudPollingRoutes.every((path) => path === "/api/worker/events"), true, "notifications never add Cloud polling");
});

test("markTaskNotificationsRead scopes by key, ignores unsafe keys, and defaults to all", () => {
  assert.deepEqual(results.markOne, { ok: true, unreadCount: 1 });
  assert.deepEqual(results.markInvalid, { ok: true, unreadCount: 1 });
  assert.deepEqual(results.markAll, { ok: true, unreadCount: 0 });
  assert.deepEqual(results.markAllAgain, { ok: true, unreadCount: 0 });
  assert.equal(results.afterMarkOne.items.find((item) => item.taskId === "task-completed").read, true);
  assert.equal(results.afterMarkOne.items.find((item) => item.taskId === "task-failed").read, false);
  assert.equal(results.afterMarkAll.items.every((item) => item.read === true), true);
  assert.deepEqual(results.afterRestartMark, { ok: true, unreadCount: 1 }, "an empty key list marks nothing read");
});

test("a restarted Connector reads the same durable notifications on its next light poll", () => {
  const payload = results.afterRestart;
  assert.equal(payload.items.length, 3);
  assert.equal(payload.unreadCount, 1);
  const preRestart = payload.items.find((item) => item.taskId === "task-before-restart");
  assert.equal(preRestart.terminalState, "completed");
  assert.equal(preRestart.read, false);
  assert.equal(preRestart.summary, "recorded before the Connector restarted");
  assert.equal(payload.items.find((item) => item.taskId === "task-completed").read, true, "read state survives the restart");
});

test("the persisted notification file carries no prompt, path, conversation, credential, or workspace identity", () => {
  assert.equal(results.fileContainsPrompt, false);
  assert.equal(results.fileContainsPath, false);
  assert.equal(results.fileContainsConversation, false);
  assert.equal(results.fileContainsSecret, false);
  assert.equal(results.fileContainsWorkspace, false);
  assert.ok(results.fileBytes < 4096, "the durable file stays small and bounded");
  assert.match(results.rawSummary, /\[path\]/u);
  assert.match(results.rawSummary, /\[url\]/u);
  assert.match(results.rawSummary, /\[redacted\]/u);
});
