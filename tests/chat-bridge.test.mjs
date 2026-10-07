import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatBridgeController,
  bridgePublicState,
  bridgeReady,
  buildBridgeControlMessage,
  buildCloudBridgeControlMessage,
  normalizeBridgeChatUrl,
  normalizeBridgeEnvelope,
  messageVisibleScript,
} from "../lib/chat-bridge.mjs";

const ENVELOPE = {
  delivery_id: "bridge_del_1",
  message_key: "bridge_msg_1",
  project_id: "project_123",
  event_id: "evt_123",
  task_id: "task_123",
  event_name: "task.completed",
  project_revision: 7,
};

test("Chat Bridge only accepts chatgpt.com HTTPS bindings", () => {
  assert.match(normalizeBridgeChatUrl("https://chatgpt.com/c/abc"), /^https:\/\/chatgpt\.com\/c\/abc/u);
  assert.throws(() => normalizeBridgeChatUrl("http://chatgpt.com/c/abc"), /HTTPS chatgpt\.com/u);
  assert.throws(() => normalizeBridgeChatUrl("https://evil.example/c/abc"), /HTTPS chatgpt\.com/u);
});

test("Bridge control message is small and contains no task result/log payload", () => {
  const message = buildBridgeControlMessage({
    ...ENVELOPE,
    result: "SHOULD_NOT_APPEAR",
    logs: "SHOULD_NOT_APPEAR",
    prompt: "SHOULD_NOT_APPEAR",
  });
  assert.match(message, /^\[DSW\]/u);
  assert.match(message, /PROJECT_ID: project_123/u);
  assert.match(message, /EVENT_ID: evt_123/u);
  assert.doesNotMatch(message, /SHOULD_NOT_APPEAR/u);
  assert.ok(Buffer.byteLength(message, "utf8") < 1000);
});

test("Production v13 wake contains only project/task/message key and the required action", () => {
  const message = buildCloudBridgeControlMessage({ ...ENVELOPE, result: "secret result", logs: "secret logs" });
  assert.equal(message, [
    "[DSW]", "STATE: PROJECT_EVENT_PENDING", "PROJECT_ID: project_123", "TASK_ID: task_123", "MESSAGE_KEY: bridge_msg_1", "",
    "ACTION:", "Use DeepSeek Worker tools.", "Acquire the project lease.", "Read pending project events and the completed task result.",
    "Continue orchestration.", "Ack processed project events.", "Release the lease.", "Then end this turn.", "Do not poll task status.",
  ].join("\n"));
  assert.doesNotMatch(message, /EVENT_ID|REVISION|result:|logs:|secret/u);
});

test("Bridge envelope rejects non-terminal or arbitrary event names", () => {
  assert.equal(normalizeBridgeEnvelope(ENVELOPE).eventName, "task.completed");
  assert.throws(
    () => normalizeBridgeEnvelope({ ...ENVELOPE, event_name: "run.shell" }),
    /not allowed/u,
  );
});

test("Public Bridge status never returns the bound chat URL", () => {
  const state = bridgePublicState(
    {
      bridgeBrowser: "online",
      bridgeState: "idle",
      bridgeLastEventId: "evt_123",
    },
    {
      chatBridgeEnabled: true,
      chatBridgeChatUrl: "https://chatgpt.com/c/private-chat-id",
    },
  );
  assert.equal(state.bound, true);
  assert.equal(state.browser, "online");
  assert.ok(!Object.hasOwn(state, "chatUrl"));
  assert.ok(!JSON.stringify(state).includes("private-chat-id"));
});

test("Bridge readiness preserves the wake advertisement contract across bridge states", () => {
  const config = {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "https://chatgpt.com/c/abc",
  };
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "idle" }, config), true);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "sent" }, config), true);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "ready" }, config), true);
  assert.equal(bridgeReady({ bridgeBrowser: "unavailable", bridgeState: "error" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "ready" }, {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "",
  }), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online" }, {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "",
  }), false);
});

test("Controller deduplicates an already-sent message key before any browser access", async () => {
  const runtime = {
    bridgeBrowser: "online",
    bridgeState: "sent",
    bridgeLastMessageKey: "bridge_msg_1",
    bridgeLastSentAt: "2026-10-06T12:00:00Z",
  };
  const controller = new ChatBridgeController({
    runtime,
    getConfig: () => ({
      chatBridgeEnabled: true,
      chatBridgeChatUrl: "https://chatgpt.com/c/abc",
      chatBridgeDebugPort: 9223,
    }),
  });
  const result = await controller.sendEnvelope(ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(result.deduplicated, true);
});

function fakeCdp({ login = false } = {}) {
  const calls = [];
  const cdp = {
    async open() { calls.push(["open"]); },
    close() {},
    async send(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "chat", type: "page", url: "https://chatgpt.com/c/old" }] };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "Browser.getWindowForTarget") return { windowId: 1 };
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("authRequired")) return { result: { value: { href: login ? "https://chatgpt.com/auth/login" : "https://chatgpt.com/c/bound", authRequired: login } } };
        if (params.expression.includes("composer_not_found")) return { result: { value: { ok: true, href: "https://chatgpt.com/c/bound" } } };
      }
      return {};
    },
  };
  return { cdp, calls };
}

function fakeController(fake) {
  return new ChatBridgeController({
    runtime: {},
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/bound", chatBridgeDebugPort: 9223 }),
    cdpFactory: () => fake.cdp,
  });
}

test("Open/Login activates and restores an existing ChatGPT browser page", async () => {
  const fake = fakeCdp();
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.openLoginBrowser();
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/"));
  assert.ok(fake.calls.some(([method]) => method === "Browser.setWindowBounds"));
  assert.ok(fake.calls.some(([method]) => method === "Target.activateTarget"));
});

test("Bridge test marks ready only after bound composer check and never sends", async () => {
  const fake = fakeCdp();
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.ok, true);
  assert.equal(result.state, "ready");
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/bound"));
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText" || method === "Input.dispatchKeyEvent"));
  assert.ok(!fake.calls.some(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("button.click")));
});

test("Bridge test explicitly reports login required and never reports ready", async () => {
  const fake = fakeCdp({ login: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_login_required");
  assert.equal(controller.status().state, "needs-login");
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText" || method === "Input.dispatchKeyEvent"));
});

test("pre-send visibility probe requires the complete project/task/message identity", () => {
  const script = messageVisibleScript("project_123", "task_123", "bridge_msg_1");
  assert.match(script, /PROJECT_ID/);
  assert.match(script, /TASK_ID/);
  assert.match(script, /MESSAGE_KEY/);
  assert.match(script, /project_123/);
  assert.match(script, /task_123/);
  assert.match(script, /bridge_msg_1/);
});