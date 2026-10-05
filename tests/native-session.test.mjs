import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExistingSessionMatchesWorkspace,
  executeNativeSession,
  latestAssistantText,
} from "../lib/native-session.mjs";

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

function fakeSession() {
  const events = [];
  return {
    events,
    snapshotEvents() { return [...events]; },
  };
}

function successfulController(ctx, session, options = {}) {
  const calls = { create: [], inspect: [], resolveAgent: [], prompt: [] };
  const agent = { session };
  return {
    calls,
    agent,
    async create(request) {
      calls.create.push(request);
      return { sessionId: options.newSessionId ?? "session-new" };
    },
    async inspect(sessionId, signal) {
      calls.inspect.push({ sessionId, signal });
      if (options.inspectError) throw options.inspectError;
      return { meta: { cwd: options.cwd } };
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId);
      return { agent };
    },
    async prompt(request, signal) {
      calls.prompt.push({ request, signal });
      const start = session.events.at(-1)?.seq ?? -1;
      session.events.push({
        type: "assistant/message",
        seq: start + 1,
        data: { message: { content: [{ type: "text", text: "Done from Harness." }] } },
      });
      const turnEnd = { type: "turn/end", seq: start + 2, data: { reason: "completed" } };
      session.events.push(turnEnd);
      queueMicrotask(() => ctx.emit("session/event", session, turnEnd));
      return { accepted: true };
    },
  };
}

test("new Native Session is created with WorkspaceId and never cwd", async () => {
  const ctx = fakeContext();
  const session = fakeSession();
  const controller = successfulController(ctx, session);
  const workspace = { id: "workspace-a", path: "E:\\Project", sessionIds: [] };
  const result = await executeNativeSession(
    ctx,
    controller,
    { id: "task-a" },
    workspace,
    "Do work",
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(controller.calls.create, [{ workspaceId: "workspace-a" }]);
  assert.equal(Object.hasOwn(controller.calls.create[0], "cwd"), false);
  assert.equal(result.sessionId, "session-new");
  assert.equal(result.result, "Done from Harness.");
});

test("continuation resumes the original Session only after Workspace and cwd validation", async () => {
  const ctx = fakeContext();
  const session = fakeSession();
  const controller = successfulController(ctx, session, { cwd: "E:\\Project" });
  const workspace = {
    id: "workspace-a",
    path: "E:\\Project",
    sessionIds: ["session-old"],
  };
  const result = await executeNativeSession(
    ctx,
    controller,
    { id: "task-a", session_id: "session-old" },
    workspace,
    "Continue",
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(controller.calls.create, []);
  assert.deepEqual(controller.calls.inspect.map((call) => call.sessionId), ["session-old"]);
  assert.deepEqual(controller.calls.resolveAgent, ["session-old"]);
  assert.equal(result.sessionId, "session-old");
});

test("continuation fails instead of silently creating when Session is outside the Workspace", async () => {
  const controller = { inspect: async () => ({ meta: { cwd: "E:\\Project" } }) };
  await assert.rejects(
    () => assertExistingSessionMatchesWorkspace(
      controller,
      { id: "workspace-a", path: "E:\\Project", sessionIds: [] },
      "session-old",
      new AbortController().signal,
    ),
    /not attached/,
  );
});

test("continuation fails when persisted Session cwd does not match the official Workspace path", async () => {
  const controller = { inspect: async () => ({ meta: { cwd: "E:\\Other" } }) };
  await assert.rejects(
    () => assertExistingSessionMatchesWorkspace(
      controller,
      { id: "workspace-a", path: "E:\\Project", sessionIds: ["session-old"] },
      "session-old",
      new AbortController().signal,
    ),
    /does not belong/,
  );
});

test("continuation fails when the Session cannot be inspected", async () => {
  const controller = { inspect: async () => { throw new Error("not found"); } };
  await assert.rejects(
    () => assertExistingSessionMatchesWorkspace(
      controller,
      { id: "workspace-a", path: "E:\\Project", sessionIds: ["session-old"] },
      "session-old",
      new AbortController().signal,
    ),
    /could not be inspected/,
  );
});

test("assistant extraction only reads messages after the task baseline", () => {
  const events = [
    { type: "assistant/message", seq: 1, data: { message: { content: [{ type: "text", text: "old" }] } } },
    { type: "assistant/message", seq: 3, data: { message: { content: [{ type: "text", text: "new" }] } } },
  ];
  assert.equal(latestAssistantText(events, 1), "new");
});
