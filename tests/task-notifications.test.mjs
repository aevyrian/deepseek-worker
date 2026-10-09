import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_RECORDS,
  TaskNotificationStore,
  isValidNotificationKey,
  sanitizePreview,
  summarizeError,
  summarizeResult,
  taskNotificationKey,
  taskNotificationsPath,
} from "../lib/task-notifications.mjs";

async function temporaryStore(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsw-task-notifications-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "task-notifications.json");
  const store = new TaskNotificationStore({ filePath, ...options });
  await store.initialize();
  return { directory, filePath, store };
}

async function readRaw(filePath) {
  return readFile(filePath, "utf8");
}

test("notification key is deterministic per task and terminal state", () => {
  const completed = taskNotificationKey("task-a", "completed");
  assert.equal(completed, taskNotificationKey("task-a", "completed"));
  assert.notEqual(completed, taskNotificationKey("task-b", "completed"));
  assert.notEqual(completed, taskNotificationKey("task-a", "failed"));
  assert.match(completed, /^ntf-[0-9a-f]{32}$/u);
  assert.equal(completed.includes("task-a"), false, "the key must not embed the raw task id");
  assert.ok(isValidNotificationKey(completed));
  assert.equal(isValidNotificationKey("../../etc/passwd"), false);
  assert.equal(isValidNotificationKey(""), false);
  assert.equal(isValidNotificationKey(42), false);
  assert.equal(isValidNotificationKey("ntf-" + "a".repeat(64)), false);
  assert.throws(() => taskNotificationKey("task-a", "cancelled"), /completed or failed/u);
  assert.throws(() => taskNotificationKey("", "completed"), /task id/u);
});

test("terminal states, timestamps, and read flags survive a restart", async (t) => {
  const { filePath, store } = await temporaryStore(t, { now: () => "2026-10-09T01:00:00.000Z" });
  const created = await store.recordTerminal({ taskId: "task-1", terminalState: "completed", summary: "Installed dependency graph and ran unit tests.", at: "2026-10-09T01:00:00.000Z" });
  assert.equal(created.created, true);
  assert.deepEqual(created.row, {
    key: taskNotificationKey("task-1", "completed"),
    taskId: "task-1",
    terminalState: "completed",
    at: "2026-10-09T01:00:00.000Z",
    read: false,
    summary: "Installed dependency graph and ran unit tests.",
    error: "",
  });

  await store.recordTerminal({ taskId: "task-2", terminalState: "failed", error: "Harness Session finished without an assistant result", at: "2026-10-09T01:00:05.000Z" });
  await store.markRead({ keys: [created.row.key] });

  const restarted = new TaskNotificationStore({ filePath, now: () => "2026-10-09T02:00:00.000Z" });
  await restarted.initialize();
  const items = await restarted.list();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.taskId), ["task-2", "task-1"], "newest first");
  assert.equal(items.find((item) => item.taskId === "task-1").read, true);
  assert.equal(items.find((item) => item.taskId === "task-2").read, false);
  assert.equal(items.find((item) => item.taskId === "task-2").error, "Harness Session finished without an assistant result");
  const counts = await restarted.counts();
  assert.deepEqual(counts, { total: 2, unreadCount: 1 });
});

test("replayed terminal uploads dedupe by task and state without resurrecting reads", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.recordTerminal({ taskId: "task-replay", terminalState: "completed", summary: "first summary" });
  await store.markRead({ keys: [first.row.key] });
  const replay = await store.recordTerminal({ taskId: "task-replay", terminalState: "completed", summary: "second summary" });
  assert.equal(replay.created, false);
  assert.equal(replay.row.at, first.row.at);
  assert.equal(replay.row.read, true);
  assert.equal(replay.row.summary, "first summary");
  const failed = await store.recordTerminal({ taskId: "task-replay", terminalState: "failed", error: "later failure" });
  assert.equal(failed.created, true, "a distinct terminal state is a distinct notification");
  const items = await store.list();
  assert.equal(items.length, 2);
  assert.deepEqual((await store.counts()).unreadCount, 1);
});

test("parallel tasks finishing out of order stay individually visible and ordered", async (t) => {
  const { store } = await temporaryStore(t);
  const clock = ["2026-10-09T03:00:00.000Z", "2026-10-09T03:00:01.000Z", "2026-10-09T03:00:02.000Z", "2026-10-09T03:00:03.000Z"];
  let index = 0;
  const sequenced = new TaskNotificationStore({ filePath: store.filePath, now: () => clock[Math.min(index++, clock.length - 1)] });
  await sequenced.initialize();
  const tasks = [
    { taskId: "task-c", terminalState: "completed", summary: "third" },
    { taskId: "task-a", terminalState: "completed", summary: "first" },
    { taskId: "task-d", terminalState: "failed", error: "fourth" },
    { taskId: "task-b", terminalState: "completed", summary: "second" },
  ];
  const recorded = await Promise.all(tasks.map((task) => sequenced.recordTerminal(task)));
  assert.deepEqual(recorded.map((entry) => entry.created), [true, true, true, true]);
  assert.deepEqual(recorded.map((entry) => entry.row.at), clock);
  const items = await sequenced.list();
  assert.deepEqual(items.map((item) => item.taskId), ["task-b", "task-d", "task-a", "task-c"]);
  assert.deepEqual(items.map((item) => item.terminalState), ["completed", "failed", "completed", "completed"]);
  assert.deepEqual(await sequenced.counts(), { total: 4, unreadCount: 4 });
});

test("concurrent record and mark-read calls settle deterministically", async (t) => {
  const { store } = await temporaryStore(t);
  const keys = Array.from({ length: 12 }, (_, index) => `task-race-${index}`);
  await Promise.all(keys.map((taskId) => store.recordTerminal({ taskId, terminalState: "completed", summary: `result ${taskId}` })));
  const before = await store.counts();
  assert.equal(before.total, 12);
  const markAll = store.markRead({});
  const lateArrivals = Promise.all([
    store.recordTerminal({ taskId: "task-race-12", terminalState: "completed", summary: "late arrival" }),
    store.recordTerminal({ taskId: "task-race-13", terminalState: "failed", error: "late failure" }),
  ]);
  const [marked] = await Promise.all([markAll, lateArrivals]);
  assert.deepEqual(marked, { changed: 12, unreadCount: 0 });
  const items = await store.list();
  assert.equal(items.length, 14);
  assert.equal(items.filter((item) => item.read === true).length, 12, "a concurrent mark-all covers exactly the rows it observed");
  assert.deepEqual(
    items.filter((item) => item.read !== true).map((item) => item.taskId).sort(),
    ["task-race-12", "task-race-13"],
    "rows recorded after mark-all stay unread",
  );
  assert.deepEqual((await store.counts()).unreadCount, 2);
  const persisted = JSON.parse(await readRaw(store.filePath));
  assert.equal(persisted.items.length, 14);
  assert.equal(persisted.version, 1);
});

test("history is bounded to the newest records and never grows without limit", async (t) => {
  const { store } = await temporaryStore(t, { maxRecords: 100 });
  let tick = 0;
  const bounded = new TaskNotificationStore({
    filePath: store.filePath,
    maxRecords: 100,
    now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, tick++)).toISOString(),
  });
  await bounded.initialize();
  for (let index = 0; index < 140; index += 1) {
    await bounded.recordTerminal({ taskId: `task-${String(index).padStart(3, "0")}`, terminalState: "completed", summary: `result ${index}` });
  }
  const items = await bounded.list({ limit: 200 });
  assert.equal(items.length, 100);
  assert.equal(items[0].taskId, "task-139");
  assert.equal(items.at(-1).taskId, "task-040");
  const persisted = JSON.parse(await readRaw(bounded.filePath));
  assert.equal(persisted.items.length, 100);
  assert.ok(bounded.maxRecords >= 100 && bounded.maxRecords <= 200);
  assert.equal(new TaskNotificationStore({ filePath: bounded.filePath, maxRecords: 5 }).maxRecords, 100, "the configured bound stays inside 100-200");
  assert.equal(new TaskNotificationStore({ filePath: bounded.filePath, maxRecords: 5000 }).maxRecords, 200);
  assert.equal(DEFAULT_MAX_RECORDS, 200);
});

test("persisted file excludes prompts, workspace paths, conversation urls, and credentials", async (t) => {
  const { store, filePath } = await temporaryStore(t);
  await store.recordTerminal({
    taskId: "task-secret",
    terminalState: "completed",
    summary: "Done. Wrote C:\\Users\\Aevyr\\AppData\\Local\\DeepSeekWorker\\out.json and posted to https://chatgpt.com/c/6a1b2c3d-4e5f with Authorization: Bearer abcdef1234567890 and api_key=sk-live-9f8e7d6c5b4a39281706",
  });
  await store.recordTerminal({
    taskId: "task-secret-failure",
    terminalState: "failed",
    error: "fetch failed for https://deepseek-worker.sxfdgan.chatgpt.site/api/worker/result token=0123456789abcdef0123456789abcdef cookie: session%3Dabc",
  });
  const raw = await readRaw(filePath);
  for (const secret of [
    "C:\\Users\\Aevyr",
    "chatgpt.com/c/6a1b2c3d",
    "abcdef1234567890",
    "sk-live-9f8e7d6c5b4a39281706",
    "0123456789abcdef0123456789abcdef",
    "session%3Dabc",
    "sxfdgan",
  ]) {
    assert.equal(raw.includes(secret), false, `persisted file must not contain ${secret}`);
  }
  assert.match(raw, /\[path\]/u);
  assert.match(raw, /\[url\]/u);
  assert.match(raw, /\[redacted\]/u);
  const items = await store.list();
  assert.equal(items.length, 2);
});

test("preview summaries are sanitized, single-line, and hard-capped", async () => {
  assert.equal(sanitizePreview("plain result"), "plain result");
  assert.equal(sanitizePreview("line one\n\nline two"), "line one line two");
  assert.equal(sanitizePreview("token: super-secret-value"), "token: [redacted]");
  assert.equal(sanitizePreview("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz"), "Bearer [redacted]");
  assert.equal(sanitizePreview("read /home/user/project/src/index.js"), "read [path]");
  assert.equal(sanitizePreview("see https://example.test/a/b?c=d"), "see [url]");
  const long = sanitizePreview("lorem ipsum ".repeat(80));
  assert.equal(long.length, 500);
  assert.equal(long.endsWith("…"), true);
  assert.equal(sanitizePreview("lorem ipsum ".repeat(80), 120).length, 120);
  assert.equal(summarizeResult(""), "");
  assert.equal(summarizeResult(null), "");
  assert.equal(summarizeResult({ ok: true, detail: "structured result" }), '{"ok":true,"detail":"structured result"}');
  assert.equal(summarizeResult("Token=abcdef0123456789\nreal answer here").includes("abcdef0123456789"), false);
  assert.equal(summarizeError(new Error("boom at C:\\Users\\Aevyr\\secret.txt")).includes("C:\\Users"), false);
  assert.ok(summarizeError("error ".repeat(200)).length <= 500);
});

test("store keeps task results readable while never requiring a Cloud or bridge target", async (t) => {
  const { store } = await temporaryStore(t);
  const summary = summarizeResult("Built the plugin, ran 285 tests, all passing.");
  await store.recordTerminal({ taskId: "task-visible", terminalState: "completed", summary });
  const items = await store.list();
  assert.equal(items[0].summary, "Built the plugin, ran 285 tests, all passing.");
});

test("a multi-line result keeps one safe readable line and redacts wrapped secrets", () => {
  const summary = summarizeResult("STATUS: ok\n\nFiles changed: lib/task-notifications.mjs\nToken=abcdef0123456789\nmore detail");
  assert.equal(summary, "STATUS: ok");
  const wrapped = summarizeResult("Authorization: Bearer\nabcdef0123456789\nfinal answer");
  assert.equal(wrapped.includes("abcdef0123456789"), false);
  assert.equal(wrapped, "Authorization: [redacted]", "the credential value is dropped even when it is wrapped onto the next line");
  assert.equal(summarizeResult("ok\ndone").length > 0, true);
  assert.equal(summarizeResult("\n\n\n"), "");
  assert.equal(summarizeError("first line\nsecond line with token=abcdef0123456789"), "first line");
});

test("a failing write degrades, warns, keeps the task alive, and recovers bounded on the next write", async (t) => {
  const { store } = await temporaryStore(t);
  const warnings = [];
  const failing = new TaskNotificationStore({ filePath: store.filePath, logger: { warn: (...args) => warnings.push(args) } });
  const realWrite = failing.writeDatabaseFile.bind(failing);
  let failWrites = true;
  failing.writeDatabaseFile = async (contents) => {
    if (failWrites) throw Object.assign(new Error("EPERM: operation not permitted, open 'task-notifications.json.tmp'"), { code: "EPERM" });
    return realWrite(contents);
  };
  await failing.initialize();

  const first = await failing.recordTerminal({ taskId: "task-degraded-1", terminalState: "completed", summary: "first" });
  assert.equal(first.created, true, "a degraded store still answers the caller");
  assert.equal(failing.degraded, true);
  assert.equal(failing.degradedReason, "task_notification_store_write_failed");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /could not persist/u);

  const second = await failing.recordTerminal({ taskId: "task-degraded-2", terminalState: "failed", error: "second" });
  assert.equal(second.created, true);
  assert.equal(failing.pendingRecoveryCount, 2, "both terminals stay queued in memory while the disk write keeps failing");

  failWrites = false;
  await failing.recordTerminal({ taskId: "task-degraded-3", terminalState: "completed", summary: "third" });
  assert.equal(failing.degraded, false, "the next successful write clears the degraded state");
  assert.equal(failing.pendingRecoveryCount, 0);
  const items = await failing.list();
  assert.deepEqual(items.map((item) => item.taskId).sort(), ["task-degraded-1", "task-degraded-2", "task-degraded-3"]);
  assert.equal((await store.list()).length, 3, "the recovered rows are durable on disk");
});

test("an unreadable file is quarantined and the store keeps working", async (t) => {
  const { filePath } = await temporaryStore(t);
  const warnings = [];
  await writeFile(filePath, "{ this is not json", "utf8");
  const store = new TaskNotificationStore({ filePath, logger: { warn: (...args) => warnings.push(args) } });
  await store.initialize();
  assert.deepEqual(await store.list(), []);
  assert.equal(store.quarantined, true);
  assert.equal(store.degradedReason, "task_notification_store_quarantined");
  assert.match(String(warnings[0][0]), /quarantined/u);
  await store.recordTerminal({ taskId: "task-after-corruption", terminalState: "completed", summary: "recovered" });
  assert.equal((await store.list()).length, 1);
  assert.equal(store.degraded, false);
});

test("marking read is idempotent, scoped, and ignores unsafe keys", async (t) => {
  const { store } = await temporaryStore(t);
  await store.recordTerminal({ taskId: "task-1", terminalState: "completed", summary: "one" });
  await store.recordTerminal({ taskId: "task-2", terminalState: "completed", summary: "two" });
  await store.recordTerminal({ taskId: "task-3", terminalState: "failed", error: "three" });
  const scoped = await store.markRead({ keys: [taskNotificationKey("task-2", "completed"), "../../etc/passwd", 7, null] });
  assert.deepEqual(scoped, { changed: 1, unreadCount: 2 });
  assert.deepEqual(await store.markRead({ keys: [taskNotificationKey("task-2", "completed")] }), { changed: 0, unreadCount: 2 });
  assert.deepEqual(await store.markRead({}), { changed: 2, unreadCount: 0 });
  assert.deepEqual(await store.markRead({}), { changed: 0, unreadCount: 0 });
  const all = await store.list();
  assert.equal(all.every((item) => item.read === true), true);
});

test("an empty keys array marks nothing read", async (t) => {
  const { store } = await temporaryStore(t);
  await store.recordTerminal({ taskId: "task-1", terminalState: "completed", summary: "one" });
  assert.deepEqual(await store.markRead({ keys: [] }), { changed: 0, unreadCount: 1 });
});

test("default notification path is the Connector state file, not a workspace path", () => {
  const path = taskNotificationsPath();
  assert.match(path, /task-notifications\.json$/u);
  assert.match(path, /DeepSeekWorker|deepseek-worker/u);
});
