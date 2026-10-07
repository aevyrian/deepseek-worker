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

test("Bridge readiness requires local enablement and a bound chat", () => {
  assert.equal(bridgeReady({ bridgeBrowser: "online" }, {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "https://chatgpt.com/c/abc",
  }), true);
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

test("pre-send visibility probe requires the complete project/task/message identity", () => {
  const script = messageVisibleScript("project_123", "task_123", "bridge_msg_1");
  assert.match(script, /PROJECT_ID/);
  assert.match(script, /TASK_ID/);
  assert.match(script, /MESSAGE_KEY/);
  assert.match(script, /project_123/);
  assert.match(script, /task_123/);
  assert.match(script, /bridge_msg_1/);
});