import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeNativeSession, ORCHESTRATOR_PRESET_ID } from "../lib/native-session.mjs";

function fakeContext() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
  };
}

test("new Native Worker Sessions use the orchestrator preset", async () => {
  const ctx = fakeContext();
  const events = [];
  const session = { snapshotEvents: () => [...events] };
  const agent = { session };
  const creates = [];

  const controller = {
    async create(request) {
      creates.push(request);
      return { sessionId: "session-new" };
    },
    async resolveAgent(sessionId) {
      assert.equal(sessionId, "session-new");
      return { agent };
    },
    async prompt(request) {
      assert.equal(request.sessionId, "session-new");
      events.push(
        { type: "assistant/message", seq: 1, data: { message: { content: [{ type: "text", text: "TASK_COMPLETE" }] } } },
        { type: "turn/end", seq: 2, data: { reason: "completed" } },
      );
      queueMicrotask(() => ctx.emit("session/event", session, events[1]));
      return { accepted: true };
    },
    async cancel() {},
  };

  const result = await executeNativeSession(
    ctx,
    controller,
    { id: "task-new" },
    { id: "workspace-a", path: "E:\\Project", sessionIds: [] },
    "Do the task",
    new AbortController().signal,
    1000,
  );

  assert.deepEqual(creates, [{ workspaceId: "workspace-a", agentPreset: ORCHESTRATOR_PRESET_ID }]);
  assert.equal(ORCHESTRATOR_PRESET_ID, "orchestrator-worker");
  assert.equal(result.result, "TASK_COMPLETE");
  assert.equal(result.sessionId, "session-new");
});

test("connector bundle ships the orchestrator preset and Standard capability markers", async () => {
  const patch = await readFile(new URL("../dsh.bundle.patch.yml", import.meta.url), "utf8");
  for (const expected of [
    "id: preset-orchestrator-worker",
    "id: orchestrator-worker",
    "name: 总控执行模式",
    "TASK_COMPLETE",
    "READY_FOR_NEXT_INSTRUCTION",
    "id: tool-pwsh",
    "id: tool-fs",
    "id: tool-subagent",
    "id: tool-web",
    "id: compaction",
  ]) {
    assert.equal(patch.includes(expected), true, "missing preset marker: " + expected);
  }
  assert.equal(
    patch.includes("id: tool-schedule"),
    false,
    "orchestrator preset must not hard-depend on the optional schedule tool",
  );
});
