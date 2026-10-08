import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { BridgeWakeOutbox } from "../lib/bridge-outbox.mjs";
import { WakeCoordinator } from "../lib/wake-coordinator.mjs";
import { WakeTransport } from "../lib/wake-transport.mjs";
import {
  ChatBridgeController,
  bridgePublicState,
  bridgeReady,
  buildBridgeControlMessage,
  buildCloudBridgeControlMessage,
  composerContainsMessageScript,
  normalizeBridgeChatUrl,
  normalizeBridgeEnvelope,
  normalizeWakeTarget,
  sameChatUrl,
  messageVisibleScript,
  sendButtonMetadataScript,
  composerSendStateScript,
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

// The Site only sets legacy_binding for a delivery whose project is origin-unbound.
const LEGACY_ENVELOPE = { ...ENVELOPE, legacy_binding: true };
const TARGETED_ENVELOPE = {
  ...ENVELOPE,
  wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-bound", url: "https://chatgpt.com/c/conversation-bound", source: "test" },
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
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(result.deduplicated, true);
});

function fakeCdp({
  login = false,
  pageUrl = "https://chatgpt.com/c/old",
  navigationUrl,
  spaUrls = [],
  targets,
  composerAvailable = true,
  composerSequence = [],
  composerHrefSequence = [],
  loginAfterComposerChecks = Number.POSITIVE_INFINITY,
  onComposerCheck,
  runtimeErrors = [],
  runtimeError,
  scriptException = false,
  sendControl = { buttonCount: 1, selectorMatches: { 'button[data-testid="send-button"]': 1 }, candidates: [], chosen: { selector: 'button[data-testid="send-button"]', x: 420, y: 700, metadata: { tagName: "BUTTON", dataTestId: "send-button", disabled: false, visible: true, nearComposer: true, hitMatchesButton: true } } },
  mouseClickWorks = true,
  enterSends = true,
  submissionPendingAfterClick = false,
} = {}) {
  const calls = [];
  const pendingSpaUrls = [...spaUrls];
  const pendingRuntimeErrors = [...runtimeErrors];
  const pendingComposerSequence = [...composerSequence];
  const pendingComposerHrefSequence = [...composerHrefSequence];
  const targetInfos = targets ?? [{ targetId: "chat", type: "page", url: pageUrl }];
  const targetUrls = new Map(targetInfos.map((target) => [target.targetId, target.url]));
  let activeTargetId = targetInfos[0]?.targetId ?? null;
  let href = activeTargetId ? targetUrls.get(activeTargetId) : pageUrl;
  let navigated = false;
  let composerChecks = 0;
  let messageInserted = false;
  let messageSubmitted = false;
  let clickReleased = false;
  const cdp = {
    async open() { calls.push(["open"]); },
    close() {},
    async send(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Target.getTargets") return { targetInfos: targetInfos.map((target) => ({ ...target, url: targetUrls.get(target.targetId) })) };
      if (method === "Target.createTarget") {
        const targetId = `created-${targetInfos.length + 1}`;
        targetInfos.push({ targetId, type: "page", url: params.url });
        targetUrls.set(targetId, params.url);
        activeTargetId = targetId;
        href = params.url;
        return { targetId };
      }
      if (method === "Target.attachToTarget") {
        activeTargetId = params.targetId;
        href = targetUrls.get(activeTargetId);
        return { sessionId: "session" };
      }
      if (method === "Target.getTargetInfo") {
        if (navigated && pendingSpaUrls.length) {
          href = pendingSpaUrls.shift();
          targetUrls.set(params.targetId, href);
        }
        return { targetInfo: { targetId: params.targetId, type: "page", url: targetUrls.get(params.targetId) } };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Browser.getWindowForTarget") return { windowId: 1 };
      if (method === "Page.navigate") {
        navigated = true;
        href = navigationUrl || params.url;
        targetUrls.set(activeTargetId, href);
      }
      if (method === "Runtime.evaluate") {
        new Function(params.expression);
        if (runtimeError) throw new Error(runtimeError);
        if (pendingRuntimeErrors.length) throw new Error(pendingRuntimeErrors.shift());
        if (scriptException) return { exceptionDetails: { text: "untrusted page exception text" } };
        if (params.expression.includes("readyState")) {
          return { result: { value: { href, readyState: "complete" } } };
        }
        if (params.expression.includes("authRequired")) {
          if (navigated && pendingSpaUrls.length) {
            href = pendingSpaUrls.shift();
            targetUrls.set(activeTargetId, href);
          }
          const authRequired = login || composerChecks >= loginAfterComposerChecks;
          return { result: { value: { href: authRequired ? "https://chatgpt.com/auth/login" : href, authRequired } } };
        }
        if (params.expression.includes("messages.some")) return { result: { value: messageSubmitted } };
        if (params.expression.includes("composerHasMessageKey")) return { result: { value: { composerFound: true, composerHasMessageKey: messageInserted && !messageSubmitted, composerEmpty: !messageInserted || messageSubmitted, sendEnabled: messageInserted && !messageSubmitted && !(clickReleased && submissionPendingAfterClick), submitting: clickReleased && submissionPendingAfterClick } } };
        if (params.expression.includes("'MESSAGE_KEY: '")) return { result: { value: { ok: messageInserted && !messageSubmitted } } };
        if (params.expression.includes("composer_not_found")) {
          composerChecks += 1;
          onComposerCheck?.(composerChecks);
          const nextHref = pendingComposerHrefSequence.shift();
          if (nextHref) {
            href = nextHref;
            targetUrls.set(activeTargetId, href);
          }
          const available = pendingComposerSequence.length ? pendingComposerSequence.shift() : composerAvailable;
          return { result: { value: { ok: available, focused: available, reason: available ? undefined : "composer_not_found", href } } };
        }
        if (params.expression.includes("selectorMatches") && params.expression.includes("send-button")) return { result: { value: sendControl } };
      }
      if (method === "Input.insertText") messageInserted = true;
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && params.button === "left") {
        clickReleased = true;
        if (mouseClickWorks) messageSubmitted = true;
      }
      if (method === "Input.dispatchKeyEvent" && params.type === "keyUp" && enterSends) messageSubmitted = true;
      return {};
    },
  };
  return { cdp, calls };
}

function fakeController(fake, chatUrl = "https://chatgpt.com/c/bound") {
  return new ChatBridgeController({
    runtime: {},
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: chatUrl, chatBridgeDebugPort: 9223 }),
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
  const expressions = fake.calls.filter(([method]) => method === "Runtime.evaluate").map(([, params]) => params.expression);
  assert.ok(expressions.some((expression) => expression.includes("readyState")), "page probe must run");
  assert.ok(expressions.some((expression) => expression.includes("authRequired")), "login state script must run");
  assert.ok(expressions.some((expression) => expression.includes("composer_not_found")), "composer check must run");
  for (const expression of expressions) assert.doesNotThrow(() => new Function(expression));
});

test("Bridge test waits for a composer rendered after initial checks", async () => {
  const fake = fakeCdp({ composerSequence: [false, false, true] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.state, "ready");
  const composerChecks = fake.calls.filter(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("composer_not_found"));
  assert.equal(composerChecks.length, 3);
});

test("Bridge test reports composer unavailable only after its wait deadline", async () => {
  const originalNow = Date.now;
  let fakeNow = originalNow();
  Date.now = () => fakeNow;
  try {
    const fake = fakeCdp({
      composerAvailable: false,
      onComposerCheck: () => { fakeNow += 30_000; },
    });
    const controller = fakeController(fake);
    controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
    await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_composer_unavailable");
    assert.equal(fake.calls.filter(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("composer_not_found")).length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("Bridge composer wait reports a changed conversation URL", async () => {
  const fake = fakeCdp({
    composerAvailable: false,
    composerSequence: [false, false],
    composerHrefSequence: [null, "https://chatgpt.com/c/other"],
  });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_conversation_unreachable");
});

test("Bridge composer wait reports a login transition", async () => {
  const fake = fakeCdp({ composerAvailable: false, loginAfterComposerChecks: 1 });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_login_required");
  assert.equal(controller.status().state, "needs-login");
});

test("sendMessage uses the shared bounded composer wait helper and a CDP mouse click", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound", composerSequence: [false, false, true] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(result.deduplicated, false);
  assert.ok(fake.calls.filter(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("composer_not_found")).length >= 4);
  assert.ok(fake.calls.some(([method]) => method === "Input.insertText"));
  assert.deepEqual(fake.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchKeyEvent"));
});

test("sendMessage prefers the existing page that matches the requested conversation", async () => {
  const fake = fakeCdp({ targets: [
    { targetId: "other", type: "page", url: "https://chatgpt.com/c/bound" },
    { targetId: "requested", type: "page", url: "https://chatgpt.com/c/other" },
  ] });
  const controller = fakeController(fake);
  controller.getConfig = () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/other", chatBridgeDebugPort: 9223 });
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "requested"));
  assert.ok(!fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/other"));
});

test("sendMessage navigates one existing ChatGPT tab to the configured conversation without creating another", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/unrelated" });
  const controller = fakeController(fake, "https://chatgpt.com/c/requested");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/requested"));
  assert.ok(!fake.calls.some(([method]) => method === "Target.createTarget"));
});

test("sendMessage reuses the single blank Bridge page instead of creating another tab", async () => {
  const fake = fakeCdp({ pageUrl: "about:blank" });
  const controller = fakeController(fake, "https://chatgpt.com/c/requested");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/requested"));
  assert.ok(!fake.calls.some(([method]) => method === "Target.createTarget"));
});

test("composer message-key verification checks the composer value without reading unrelated page text", () => {
  const expression = composerContainsMessageScript("message-a");
  const composer = { value: "[DSW] MESSAGE_KEY: message-a", getBoundingClientRect: () => ({ width: 400, height: 60 }) };
  const result = runInNewContext(expression, {
    document: { querySelectorAll: (selector) => selector === "#prompt-textarea" ? [composer] : [] },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(expression, /document\.body|cookie|localStorage|sessionStorage/u);
});

test("composer verification prefers the focused composer when the page exposes several editors", () => {
  const expression = composerContainsMessageScript("message-active");
  const first = { value: "", getBoundingClientRect: () => ({ width: 400, height: 60 }) };
  const active = { value: "[DSW] MESSAGE_KEY: message-active", getBoundingClientRect: () => ({ width: 400, height: 60 }) };
  const result = runInNewContext(expression, {
    document: { activeElement: active, querySelectorAll: (selector) => selector === "main [contenteditable=\"true\"]" ? [first, active] : [] },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
  assert.equal(result.ok, true);
});

test("send button metadata selects only a visible send control near the composer and never reads page text", () => {
  const form = {};
  const makeButton = (testId, label, x) => ({
    tagName: "BUTTON", disabled: false,
    getAttribute(name) { return ({ "data-testid": testId, "aria-label": label, role: null })[name] ?? null; },
    contains(element) { return element === this; },
    getBoundingClientRect() { return { x, y: 10, width: 24, height: 24 }; },
    closest(selector) { return selector === "form" ? form : null; },
  });
  const stop = makeButton("stop-button", "Stop generating", 10);
  const voice = makeButton("voice-button", "Voice mode", 40);
  const attachment = makeButton("attach-file-button", "Attach files", 55);
  const send = makeButton("send-button", "Send", 70);
  const composer = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 500, height: 30 }), closest: () => form };
  form.contains = (element) => [stop, voice, attachment, send].includes(element);
  const result = runInNewContext(sendButtonMetadataScript(), {
    document: {
      querySelectorAll(selector) {
        if (selector === "button") return [stop, voice, attachment, send];
        if (selector === 'button[data-testid="send-button"]') return [send];
        if (selector === 'button[aria-label*="Send" i]' || selector === 'button[aria-label*="发送"]') return [];
        if (selector === 'main [contenteditable="true"]') return [composer];
        return [];
      },
      querySelector: () => null,
      elementFromPoint: () => send,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  assert.equal(result.buttonCount, 4);
  assert.equal(result.chosen.x, 82);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].dataTestId, "send-button");
  assert.equal(result.chosen.metadata.hitMatchesButton, true);
  assert.doesNotMatch(sendButtonMetadataScript(), /innerText|textContent|document\.body/u);
  assert.doesNotMatch(sendButtonMetadataScript(), /\.click\(/u);
});

test("send button metadata recognizes a real ChatGPT send button aligned beside the composer", () => {
  const send = {
    tagName: "BUTTON", disabled: false,
    getAttribute(name) { return ({ "data-testid": null, "aria-label": "发送", role: null })[name] ?? null; },
    contains(element) { return element === this; },
    getBoundingClientRect() { return { x: 850, y: 822, width: 36, height: 36 }; },
    closest: () => null,
  };
  const composer = { getBoundingClientRect: () => ({ x: 200, y: 790, width: 700, height: 80 }), closest: () => ({ contains: () => false }) };
  const result = runInNewContext(sendButtonMetadataScript(), {
    document: {
      querySelectorAll(selector) {
        if (selector === "button") return [send];
        if (selector === 'button[data-testid="send-button"]') return [];
        if (selector === 'button[aria-label*="Send" i]' || selector === 'button[aria-label*="发送"]') return [send];
        if (selector === 'main [contenteditable="true"]') return [composer];
        return [];
      },
      querySelector: () => null,
      elementFromPoint: () => send,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "flex", opacity: "1" }),
  });
  assert.equal(result.chosen?.metadata.ariaLabel, "发送");
  assert.equal(result.chosen?.metadata.nearComposer, true);
});

test("sendMessage uses Enter only when no safe send button is available", async () => {
  const fake = fakeCdp({
    sendControl: { buttonCount: 3, selectorMatches: { 'button[data-testid="send-button"]': 0 }, candidates: [
      { tagName: "BUTTON", dataTestId: "stop-button", ariaLabel: "Stop generating", visible: true, nearComposer: true, forbidden: true },
      { tagName: "BUTTON", dataTestId: "voice-button", ariaLabel: "Voice mode", visible: true, nearComposer: true, forbidden: true },
    ], chosen: null },
  });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.ok(fake.calls.some(([method]) => method === "Input.dispatchKeyEvent"));
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
});

test("sendMessage fails if MESSAGE_KEY is absent from conversation messages after submission", async () => {
  const fake = fakeCdp({ mouseClickWorks: false, enterSends: false });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => ["bridge_send_uncertain", "bridge_send_not_submitted"].includes(error.code));
  assert.ok(fake.calls.some(([method]) => method === "Input.insertText"));
  assert.ok(["error", "uncertain"].includes(controller.status().state));
});

test("sendMessage holds a MESSAGE_KEY with an uncertain submit result and never retries it", async () => {
  const fake = fakeCdp({ mouseClickWorks: false, enterSends: false, submissionPendingAfterClick: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE));
  const callCount = fake.calls.length;
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => error.code === "bridge_send_uncertain");
  assert.equal(fake.calls.length, callCount);
  assert.equal(controller.status().state, "uncertain");
});

test("send button metadata rejects a center hit covered by an unrelated control", () => {
  const form = {};
  const hit = { tagName: "BUTTON", getAttribute: () => "voice-button" };
  const send = {
    tagName: "BUTTON", disabled: false,
    getAttribute(name) { return ({ "data-testid": "send-button", "aria-label": "Send", role: null })[name] ?? null; },
    getBoundingClientRect: () => ({ x: 70, y: 10, width: 24, height: 24 }),
    closest: () => form,
    contains: (element) => element === send,
  };
  const composer = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 500, height: 30 }), closest: () => form };
  form.contains = (element) => element === send;
  const result = runInNewContext(sendButtonMetadataScript(), {
    document: {
      querySelectorAll(selector) {
        if (selector === "button") return [send, hit];
        if (selector === 'button[data-testid="send-button"]') return [send];
        if (selector === 'button[aria-label*="Send" i]' || selector === 'button[aria-label*="发送"]') return [];
        if (selector === 'main [contenteditable="true"]') return [composer];
        return [];
      },
      querySelector: () => null,
      elementFromPoint: () => hit,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  assert.equal(result.candidates[0].hitMatchesButton, false);
  assert.equal(result.chosen, null);
});

test("post-click state distinguishes a safe draft from a possibly submitted message without reading chat text", () => {
  const expression = composerSendStateScript("message-a");
  assert.match(expression, /composerHasMessageKey/u);
  assert.match(expression, /submitting/u);
  assert.match(expression, /staleStopControl/u);
  assert.match(expression, /visibleErrors/u);
  assert.doesNotMatch(expression, /document\.body/u);
});

test("idle probe distinguishes enabled generation, disabled stale Stop, and an idle composer", () => {
  const composer = { value: "", getBoundingClientRect: () => ({ width: 400, height: 40 }) };
  const stop = (disabled) => ({
    disabled,
    getAttribute(name) { return name === "aria-label" ? "Stop generating" : name === "data-testid" ? null : null; },
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 32, height: 32 }),
  });
  const probe = (controls) => runInNewContext(composerSendStateScript("message-a"), {
    document: {
      activeElement: composer,
      querySelectorAll(selector) {
        if (selector === "button") return controls;
        if (selector === '[role="alert"],[aria-live="assertive"]') return [];
        return [composer];
      },
    },
    getComputedStyle: () => ({ display: "flex", visibility: "visible", opacity: "1" }),
  });
  const generating = probe([stop(false)]);
  assert.equal(generating.submitting, true);
  assert.equal(generating.idle, false);
  const stale = probe([stop(true)]);
  assert.equal(stale.submitting, false);
  assert.equal(stale.staleStopControl, true);
  assert.equal(stale.idle, false);
  const idle = probe([]);
  assert.equal(idle.submitting, false);
  assert.equal(idle.staleStopControl, false);
  assert.equal(idle.idle, true);
});

test("idle probe ignores offscreen one-pixel accessibility live regions", () => {
  const composer = { value: "", getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 40 }) };
  const hiddenLiveRegion = { getBoundingClientRect: () => ({ x: -1, y: -1, left: -1, top: -1, right: 0, bottom: 0, width: 1, height: 1 }) };
  const result = runInNewContext(composerSendStateScript("message-a"), {
    document: {
      activeElement: composer,
      documentElement: { clientWidth: 1920, clientHeight: 1080 },
      querySelectorAll(selector) {
        if (selector === "button") return [];
        if (selector === '[role="alert"],[aria-live="assertive"]') return [hiddenLiveRegion, hiddenLiveRegion];
        return [composer];
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  assert.equal(result.visibleErrors, 0);
  assert.equal(result.idle, true);
});

test("sendEnvelope uses the delivery wake_target instead of the legacy global conversation", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy" });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const targetUrl = "https://chatgpt.com/c/conversation-A";
  await controller.sendEnvelope({ ...ENVELOPE, wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: targetUrl, source: "test" } });
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === targetUrl));
  assert.ok(!fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/bound"));
});

test("sendEnvelope without wake_target uses the global conversation only for an explicit legacy delivery", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/legacy-bound"));
});

test("sendEnvelope refuses a delivery that has neither a wake_target nor an explicit legacy flag", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  let browserTouched = false;
  controller.ensureBrowser = async () => { browserTouched = true; return { version: { webSocketDebuggerUrl: "ws://fake" } }; };
  await assert.rejects(controller.sendEnvelope(ENVELOPE), (error) => error.code === "bridge_wake_target_required");
  assert.equal(browserTouched, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(normalizeBridgeEnvelope(ENVELOPE).legacyBinding, false);
  assert.equal(normalizeBridgeEnvelope(LEGACY_ENVELOPE).legacyBinding, true);
  assert.equal(normalizeBridgeEnvelope({ ...ENVELOPE, legacy_binding: "yes" }).legacyBinding, false);
});

test("sendLocalWake refuses an unbound delivery and honours the Site legacy flag", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const base = { project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1", terminal_state: "completed" };
  await assert.rejects(controller.sendLocalWake(base), (error) => error.code === "bridge_wake_target_required");
  await controller.sendLocalWake({ ...base, legacy_binding: true });
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/legacy-bound"));
  const targeted = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const targetedController = fakeController(targeted, "https://chatgpt.com/c/legacy-bound");
  targetedController.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await targetedController.sendLocalWake({ ...base, legacy_binding: true, wake_target: TARGETED_ENVELOPE.wake_target });
  assert.ok(targeted.calls.some(([method, params]) => method === "Page.navigate" && params.url === TARGETED_ENVELOPE.wake_target.url));
  assert.ok(!targeted.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/legacy-bound"));
});

test("reconcileDelivery refuses to reconcile against the fixed binding without the legacy flag", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy-bound" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const delivery = { project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1" };
  assert.deepEqual(await controller.reconcileDelivery(delivery), { state: "uncertain", reason: "target_unbound" });
  assert.equal(fake.calls.length, 0);
});

test("Site deliveries flow through the durable outbox and transport into each delivery's own conversation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsw-site-delivery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outbox = new BridgeWakeOutbox({ filePath: join(directory, "outbox.json") });
  const targetA = { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/c/conversation-A", source: "site" };
  const targetB = { type: "chatgpt_conversation", conversation_id: "conversation-B", url: "https://chatgpt.com/c/conversation-B", source: "site" };
  const coordinator = new WakeCoordinator({ outbox });
  // Completion of B arrives before A, and each carries only its own target.
  await coordinator.acceptResponse({ bridge_delivery: {
    delivery_id: "delivery-B", message_key: "message-B", project_id: "project-B", event_id: "event-B",
    task_id: "task-B", event_name: "task.completed", project_revision: 2, wake_target: targetB,
  } });
  await coordinator.acceptResponse({ bridge_delivery: {
    delivery_id: "delivery-A", message_key: "message-A", project_id: "project-A", event_id: "event-A",
    task_id: "task-A", event_name: "task.completed", project_revision: 2, wake_target: targetA,
  } });
  assert.equal((await outbox.findByMessageKey("message-A")).wake_target.url, targetA.url);
  assert.equal((await outbox.findByMessageKey("message-B")).wake_target.url, targetB.url);
  assert.equal((await outbox.findByMessageKey("message-A")).legacy_binding, false);

  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy-bound" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const transport = new WakeTransport({ outbox, bridge: controller });
  await transport.drainOnce();

  const navigations = fake.calls.filter(([method]) => method === "Page.navigate").map(([, params]) => params.url);
  assert.ok(navigations.includes(targetA.url), navigations.join(","));
  assert.ok(navigations.includes(targetB.url), navigations.join(","));
  assert.ok(!navigations.includes("https://chatgpt.com/c/legacy-bound"));
  assert.equal((await outbox.findByMessageKey("message-A")).delivery_state, "delivered");
  assert.equal((await outbox.findByMessageKey("message-B")).delivery_state, "delivered");
});

test("wake target requires an explicit ChatGPT conversation URL and preserves validated metadata", () => {
  const target = normalizeWakeTarget({ type: "chatgpt_conversation", conversation_id: "conv-a", url: "https://chatgpt.com/c/conv-a", source: "mcp", captured_at: "2026-10-08T00:00:00.000Z" });
  assert.equal(target.url, "https://chatgpt.com/c/conv-a");
  assert.equal(target.conversation_id, "conv-a");
  assert.equal(normalizeWakeTarget({ type: "chatgpt_conversation", url: "https://chatgpt.com/g/g-p-project/c/conv-b", conversation_id: "conv-b" }).url, "https://chatgpt.com/g/g-p-project/c/conv-b");
  assert.equal(normalizeWakeTarget(null), null);
  assert.throws(() => normalizeWakeTarget({ type: "chatgpt_conversation", conversation_id: "conv-a" }), /bridge_wake_target_invalid/u);
  assert.throws(() => normalizeWakeTarget({ type: "chatgpt_conversation", url: "https://chatgpt.com/" }), /bridge_wake_target_invalid/u);
});

test("message confirmation inspects conversation message nodes rather than page text or composer", () => {
  const expression = messageVisibleScript("project-a", "task-a", "message-a");
  const message = { textContent: "PROJECT_ID: project-a TASK_ID: task-a MESSAGE_KEY: message-a" };
  assert.equal(runInNewContext(expression, { document: { querySelectorAll: (selector) => selector.includes("data-user-message-bubble") ? [message] : [], body: { innerText: "same text in unrelated page chrome" } } }), true);
  assert.doesNotMatch(expression, /document\.body|innerText/u);
  assert.match(expression, /data-user-message-bubble|data-message-author-role|conversation-turn-/u);
  assert.doesNotMatch(expression, /#prompt-textarea|contenteditable/u);
});

test("Generated login-state script recognizes auth paths and their subpaths without regex escaping", async () => {
  const fake = fakeCdp();
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.state, "ready");
  const expression = fake.calls.find(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("authRequired"))[1].expression;
  assert.doesNotMatch(expression, /\/\/auth\//u);
  const evaluateAuth = (pathname) => runInNewContext(expression, {
    location: { href: `https://chatgpt.com${pathname}`, pathname },
    document: { body: { innerText: "" }, querySelectorAll: () => [] },
  }).authRequired;
  for (const path of ["/auth/login", "/auth/signin", "/auth/sign-up", "/auth/signup"]) {
    assert.equal(evaluateAuth(path), true, `${path} should require login`);
    assert.equal(evaluateAuth(`${path}/continue`), true, `${path}/continue should require login`);
  }
  assert.equal(evaluateAuth("/c/conversation-id"), false);
});

test("Bridge test prefers the bound conversation target among multiple ChatGPT pages", async () => {
  const fake = fakeCdp({
    targets: [
      { targetId: "home", type: "page", url: "https://chatgpt.com/" },
      { targetId: "other", type: "page", url: "https://chatgpt.com/c/other" },
      { targetId: "bound", type: "page", url: "https://chatgpt.com/c/bound?model=selected#latest" },
    ],
  });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.state, "ready");
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "bound"));
  assert.ok(!fake.calls.some(([method]) => method === "Page.navigate"));
});

test("Bridge test creates the bound conversation target when no ChatGPT page exists", async () => {
  const fake = fakeCdp({ targets: [] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.state, "ready");
  assert.ok(fake.calls.some(([method, params]) => method === "Target.createTarget" && params.url === "https://chatgpt.com/c/bound"));
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "created-1"));
});

test("Bridge test retries a transient Runtime.evaluate navigation error", async () => {
  const fake = fakeCdp({ runtimeErrors: ["Execution context was destroyed."] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.state, "ready");
  assert.ok(fake.calls.filter(([method]) => method === "Runtime.evaluate").length >= 4);
});

test("Bridge test classifies persistent Runtime.evaluate errors and reports Target URL metadata", async () => {
  const fake = fakeCdp({ runtimeError: "Runtime.evaluate failed during page startup" });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => {
    assert.equal(error.code, "bridge_page_eval_failed");
    assert.match(error.message, /期望：https:\/\/chatgpt\.com\/c\/bound/u);
    assert.match(error.message, /实际：https:\/\/chatgpt\.com\/c\/bound/u);
    assert.doesNotMatch(error.message, /绑定的 ChatGPT 对话无法访问/u);
    return true;
  });
});

test("Bridge test reports page script exceptions separately from CDP evaluation failures", async () => {
  const fake = fakeCdp({ scriptException: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => {
    assert.equal(error.code, "bridge_page_script_exception");
    assert.doesNotMatch(error.message, /untrusted page exception text/u);
    return true;
  });
});

test("Bridge test accepts an already-open bound pathname when ChatGPT changes query and hash", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound?model=auto#answer" });
  const controller = fakeController(fake, "https://chatgpt.com/c/bound?model=some-model");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.ok, true);
  assert.equal(result.state, "ready");
  assert.ok(!fake.calls.some(([method]) => method === "Page.navigate"));
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText" || method === "Input.dispatchKeyEvent"));
});

test("Bridge test waits for SPA navigation to settle on the bound pathname", async () => {
  const fake = fakeCdp({
    pageUrl: "https://chatgpt.com/c/other",
    targets: [
      { targetId: "home", type: "page", url: "https://chatgpt.com/" },
      { targetId: "other", type: "page", url: "https://chatgpt.com/c/other" },
    ],
    navigationUrl: "https://chatgpt.com/c/loading",
    spaUrls: ["https://chatgpt.com/c/loading?phase=1", "https://chatgpt.com/c/bound?model=normalized#latest"],
  });
  const controller = fakeController(fake, "https://chatgpt.com/c/bound?model=selected");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.testBridge();
  assert.equal(result.ok, true);
  assert.equal(result.state, "ready");
  assert.ok(fake.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/bound?model=selected"));
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText" || method === "Input.dispatchKeyEvent"));
});

test("Bridge conversation identity ignores query/hash but rejects different paths and non-HTTPS URLs", () => {
  assert.equal(sameChatUrl("https://chatgpt.com/c/bound?model=one#latest", "https://chatgpt.com/c/bound?model=two"), true);
  assert.equal(sameChatUrl("https://chatgpt.com/c/bound/", "https://chatgpt.com/c/bound"), true);
  assert.equal(sameChatUrl("https://chatgpt.com/", "https://chatgpt.com/c/bound"), false);
  assert.equal(sameChatUrl("https://chatgpt.com/c/other", "https://chatgpt.com/c/bound"), false);
  assert.equal(sameChatUrl("http://chatgpt.com/c/bound", "https://chatgpt.com/c/bound"), false);
});

test("Bridge test rejects a genuinely different pathname without reaching ready", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/other", navigationUrl: "https://chatgpt.com/c/other?access_token=must-not-appear#secret" });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => {
    assert.equal(error.code, "bridge_conversation_unreachable");
    assert.match(error.message, /期望：https:\/\/chatgpt\.com\/c\/bound/u);
    assert.match(error.message, /实际：https:\/\/chatgpt\.com\/c\/other/u);
    assert.equal(error.message.includes("must-not-appear"), false);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(controller.status().state, "error");
});

test("Bridge test explicitly reports login required and never reports ready", async () => {
  const fake = fakeCdp({ login: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_login_required");
  assert.equal(controller.status().state, "needs-login");
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText" || method === "Input.dispatchKeyEvent"));
});

test("Bridge test exposes only safe Runtime.evaluate failure reason", async () => {
  const fake = fakeCdp({ runtimeError: "Runtime.evaluate failed; token=secret-token" });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => {
    assert.equal(error.code, "bridge_page_eval_failed");
    assert.match(error.message, /runtime-evaluate-failed/u);
    assert.doesNotMatch(error.message, /secret-token|token=/u);
    return true;
  });
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
