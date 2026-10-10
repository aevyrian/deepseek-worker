import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { BridgeWakeOutbox } from "../lib/bridge-outbox.mjs";
import { WakeCoordinator } from "../lib/wake-coordinator.mjs";
import { WakeTransport } from "../lib/wake-transport.mjs";
import {
  BRIDGE_START_URL,
  ChatBridgeController,
  bridgeProfileDir,
  bridgePublicState,
  bridgeReady,
  browserLaunchArgs,
  buildBridgeControlMessage,
  buildCloudBridgeControlMessage,
  composerContainsMessageScript,
  conversationBinding,
  normalizeBridgeChatUrl,
  normalizeBridgeEnvelope,
  normalizeWakeTarget,
  sameChatUrl,
  sameTargetConversation,
  messageVisibleScript,
  sendButtonMetadataScript,
  composerSendStateScript,
} from "../lib/chat-bridge.mjs";

// Primitives that would move or focus a page. The send path may open its own tab
// and type into it, but it must never navigate or focus a tab that already
// exists, because another conversation's tab may hold an unsent user draft.
const PAGE_NAVIGATION_PRIMITIVES = [
  "Page.navigate",
  "Target.activateTarget",
  "Browser.setWindowBounds",
];

// Everything the health probe and the read-only reconciler must never use.
const READ_ONLY_PRIMITIVES = [
  ...PAGE_NAVIGATION_PRIMITIVES,
  "Target.createTarget",
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
];

function assertNoPageNavigation(fake, message) {
  const used = fake.calls.filter(([method]) => PAGE_NAVIGATION_PRIMITIVES.includes(method)).map(([method]) => method);
  assert.deepEqual(used, [], message);
}

function assertNoNavigationPrimitives(fake, message) {
  const used = fake.calls.filter(([method]) => READ_ONLY_PRIMITIVES.includes(method)).map(([method]) => method);
  assert.deepEqual(used, [], message);
}

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
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "idle" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "sent" }, config), true);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "ready" }, config), true);
  assert.equal(bridgeReady({ bridgeBrowser: "unknown", bridgeState: "uninitialized" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "uninitialized" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "needs-login" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "error" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "unavailable", bridgeState: "error" }, config), false);
  assert.equal(bridgeReady({ bridgeBrowser: "online", bridgeState: "ready" }, {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "",
  }), true);
  assert.equal(bridgeReady({ bridgeBrowser: "online" }, {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "",
  }), false);
});

test("Public Bridge status distinguishes disabled, unbound, uninitialized, login, ready, and error", () => {
  const config = { chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/abc" };
  assert.equal(bridgePublicState({ bridgeBrowser: "unknown" }, config).state, "uninitialized");
  assert.equal(bridgePublicState({}, { chatBridgeEnabled: true, chatBridgeChatUrl: "" }).state, "unbound");
  assert.equal(bridgePublicState({}, { chatBridgeEnabled: false, chatBridgeChatUrl: "" }).state, "disabled");
  assert.equal(bridgePublicState({}, { ...config, chatBridgeDebugPort: 80 }).state, "invalid-config");
  assert.equal(bridgePublicState({ bridgeState: "needs-login" }, config).state, "needs-login");
  assert.equal(bridgePublicState({ bridgeState: "ready" }, config).state, "ready");
  assert.equal(bridgePublicState({ bridgeState: "error" }, config).state, "error");
});

test("browser spawn errors become a controlled Bridge failure without leaking paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("CDP not available"); };
  const runtime = {};
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  const controller = new ChatBridgeController({
    runtime,
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/abc", chatBridgeDebugPort: 9223 }),
    findBrowserExecutable: () => "C:\\private\\missing-browser.exe",
    spawnBrowser: () => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn C:\\private\\missing-browser.exe"), { code: "ENOENT" })));
      return child;
    },
  });
  try {
    await assert.rejects(controller.ensureBrowser(), (error) => error.code === "bridge_browser_spawn_failed");
    assert.equal(runtime.bridgeBrowser, "unavailable");
    assert.equal(runtime.bridgeHealthState, "error");
    assert.doesNotMatch(runtime.bridgeHealthLastError, /private|missing-browser/iu);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent browser bootstrap reuses one isolated browser launch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error("CDP not available");
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/test" }) };
  };
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  const controller = new ChatBridgeController({
    runtime: {},
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/abc", chatBridgeDebugPort: 9223 }),
    findBrowserExecutable: () => "C:\\test\\chrome.exe",
    spawnBrowser: () => { spawnCalls += 1; return child; },
  });
  try {
    const results = await Promise.all([controller.ensureBrowser(), controller.ensureBrowser()]);
    assert.equal(results[0].version.webSocketDebuggerUrl, "ws://127.0.0.1:9223/devtools/browser/test");
    assert.equal(results[1].version.webSocketDebuggerUrl, "ws://127.0.0.1:9223/devtools/browser/test");
    assert.equal(spawnCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  sendControl = { buttonCount: 1, selectorMatches: { 'button[data-testid="send-button"]': 1 }, candidates: [], chosen: { selector: 'button[data-testid="send-button"]', x: 420, y: 700, metadata: { tagName: "BUTTON", dataTestId: "send-button", disabled: false, visible: true, nearComposer: true, hitMatchesButton: true, isSendControl: true } } },
  sendControlSequence = [],
  composerDraftSequence = [],
  composerForeignDraft = false,
  createTargetInitialUrl,
  createTargetResolvedUrl,
  createTargetLoadReads = 3,
  generatingProbes = 0,
  mouseClickWorks = true,
  enterSends = true,
  submissionPendingAfterClick = false,
  composerDraftHasMessageKey = false,
  reconciledMessageVisible = false,
} = {}) {
  const calls = [];
  const pendingSpaUrls = [...spaUrls];
  const pendingRuntimeErrors = [...runtimeErrors];
  const pendingComposerSequence = [...composerSequence];
  const pendingComposerHrefSequence = [...composerHrefSequence];
  const pendingSendControlSequence = [...sendControlSequence];
  const pendingComposerDraftSequence = [...composerDraftSequence];
  const targetInfos = targets ?? [{ targetId: "chat", type: "page", url: pageUrl }];
  const targetUrls = new Map(targetInfos.map((target) => [target.targetId, target.url]));
  // Targets created through Target.createTarget that still have to "load" their
  // requested URL, so a freshly created SPA tab can be exercised.
  const pendingCreatedUrls = [];
  let activeTargetId = targetInfos[0]?.targetId ?? null;
  let href = activeTargetId ? targetUrls.get(activeTargetId) : pageUrl;
  let navigated = false;
  let composerChecks = 0;
  let messageInserted = false;
  let messageSubmitted = false;
  let clickReleased = false;
  let generatingProbesLeft = generatingProbes;
  const cdp = {
    async open() { calls.push(["open"]); },
    close() {},
    async send(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Target.getTargets") return { targetInfos: targetInfos.map((target) => ({ ...target, url: targetUrls.get(target.targetId) })) };
      if (method === "Target.createTarget") {
        const targetId = `created-${targetInfos.length + 1}`;
        const initialUrl = createTargetInitialUrl ?? params.url;
        const resolvedUrl = createTargetResolvedUrl ?? params.url;
        targetInfos.push({ targetId, type: "page", url: initialUrl });
        targetUrls.set(targetId, initialUrl);
        if (initialUrl !== resolvedUrl) pendingCreatedUrls.push({ targetId, url: resolvedUrl, reads: createTargetLoadReads });
        activeTargetId = targetId;
        href = initialUrl;
        return { targetId };
      }
      if (method === "Target.attachToTarget") {
        activeTargetId = params.targetId;
        href = targetUrls.get(activeTargetId);
        return { sessionId: "session" };
      }
      if (method === "Target.getTargetInfo") {
        const pendingCreated = pendingCreatedUrls.find((item) => item.targetId === params.targetId);
        if (pendingCreated) {
          pendingCreated.reads -= 1;
          if (pendingCreated.reads <= 0) {
            targetUrls.set(pendingCreated.targetId, pendingCreated.url);
            pendingCreatedUrls.splice(pendingCreatedUrls.indexOf(pendingCreated), 1);
            if (activeTargetId === pendingCreated.targetId) href = pendingCreated.url;
          }
        }
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
        if (params.expression.includes("messages.some")) return { result: { value: messageSubmitted || reconciledMessageVisible } };
        if (params.expression.includes("composerHasMessageKey")) {
          const generating = generatingProbesLeft > 0;
          if (generating) generatingProbesLeft -= 1;
          const composerHasKey = (messageInserted && !messageSubmitted) || composerDraftHasMessageKey;
          const composerEmpty = messageSubmitted || (!messageInserted && !composerDraftHasMessageKey && !composerForeignDraft);
          return { result: { value: { composerFound: true, composerHasMessageKey: composerHasKey, composerEmpty, sendEnabled: composerHasKey && !(clickReleased && submissionPendingAfterClick), submitting: generating || (clickReleased && submissionPendingAfterClick), staleStopControl: false, visibleErrors: 0 } } };
        }
        if (params.expression.includes("'MESSAGE_KEY: '")) {
          const queued = pendingComposerDraftSequence.length ? pendingComposerDraftSequence.shift() : null;
          return { result: { value: { ok: queued === null ? (messageInserted && !messageSubmitted) : queued, matchesExpectedMessage: true } } };
        }
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
        if (params.expression.includes("selectorMatches") && params.expression.includes("send-button")) {
          return { result: { value: pendingSendControlSequence.length ? pendingSendControlSequence.shift() : sendControl } };
        }
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

test("Bridge validation returns promptly when shutdown aborts a pending CDP request", async () => {
  const controllerAbort = new AbortController();
  let sendStarted;
  const waitingForSend = new Promise((resolve) => { sendStarted = resolve; });
  let closeCount = 0;
  const controller = new ChatBridgeController({
    runtime: {},
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/bound", chatBridgeDebugPort: 9223 }),
    cdpFactory: () => ({
      open: async () => {},
      send: () => { sendStarted(); return new Promise(() => {}); },
      close: () => { closeCount += 1; },
    }),
  });
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const validation = controller.testBridge({ signal: controllerAbort.signal });
  await waitingForSend;
  controllerAbort.abort(new Error("shutdown"));
  await assert.rejects(validation, /shutdown/);
  assert.ok(closeCount >= 1, "abort closes the socket before final cleanup");
  assert.equal(controller.runtime.bridgeState, "uninitialized");
  assert.equal(controller.runtime.bridgeLastError, null);
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

test("sendMessage opens a new tab for the requested conversation instead of navigating an unrelated one", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/unrelated" });
  const controller = fakeController(fake, "https://chatgpt.com/c/requested");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  const created = fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url);
  assert.deepEqual(created, ["https://chatgpt.com/c/requested"]);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), [], "no tab may ever be navigated");
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "created-2"));
  const urls = fake.calls.filter(([method]) => method === "Target.getTargets").length;
  assert.ok(urls >= 1);
});

test("sendMessage never adopts a single blank Bridge page", async () => {
  const fake = fakeCdp({ pageUrl: "about:blank" });
  const controller = fakeController(fake, "https://chatgpt.com/c/requested");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), ["https://chatgpt.com/c/requested"]);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), []);
  assert.ok(!fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "chat"), "the blank tab must stay untouched");
});

test("sendMessage leaves another conversation's tab alone and never types into it", async () => {
  // Tab A already holds the target conversation; tab B holds a different chat
  // that may contain an unsent user draft. Only A may be touched.
  const fake = fakeCdp({ targets: [
    { targetId: "tab-B", type: "page", url: "https://chatgpt.com/c/conversation-B" },
    { targetId: "tab-A", type: "page", url: "https://chatgpt.com/c/conversation-A" },
  ] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope({ ...ENVELOPE, wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/c/conversation-A", source: "site" } });
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "tab-A"));
  assert.ok(!fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "tab-B"));
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), []);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget"), []);
});

test("sendMessage refuses to type into a target that resolves to a different conversation", async () => {
  // The requested tab exists but ChatGPT serves a different conversation id.
  const fake = fakeCdp({ targets: [
    { targetId: "tab-A", type: "page", url: "https://chatgpt.com/c/conversation-A" },
  ], createTargetResolvedUrl: "https://chatgpt.com/c/conversation-OTHER", createTargetLoadReads: 1 });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(
    controller.sendEnvelope({ ...ENVELOPE, wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-MISSING", url: "https://chatgpt.com/c/conversation-MISSING", source: "site" } }),
    (error) => error.code === "bridge_conversation_unreachable",
  );
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText"), "a wrong target is never typed into");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
});

test("sendMessage waits for a freshly created tab whose SPA is still loading", async () => {
  const fake = fakeCdp({
    pageUrl: "https://chatgpt.com/c/legacy-bound",
    createTargetInitialUrl: "about:blank",
    createTargetLoadReads: 3,
    composerSequence: [false, false, true],
  });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const targetUrl = "https://chatgpt.com/c/conversation-slow";
  const result = await controller.sendEnvelope({ ...ENVELOPE, wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-slow", url: targetUrl, source: "site" } });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), [targetUrl]);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), []);
  const reads = fake.calls.filter(([method, params]) => method === "Target.getTargetInfo" && params.targetId === "created-2");
  assert.ok(reads.length >= 3, "the created tab's URL is polled until it commits");
});

test("sendMessage preserves an existing unrelated composer draft and submits nothing", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy-bound", composerForeignDraft: true });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => error.code === "bridge_composer_draft_present");
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText"), "the existing draft is never overwritten");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"), "the existing draft is never submitted");
  assert.equal(controller.runtime.bridgeLastSubmitDiagnostic.draftRetained, true);
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

test("sendMessage never blind-enters and retains the draft when no safe send control exists", async () => {
  const fake = fakeCdp({
    sendControl: { buttonCount: 3, composerFound: true, composerRect: { x: 200, y: 700, width: 600, height: 80 }, selectorMatches: { 'button[data-testid="send-button"]': 0 }, candidates: [
      { tagName: "BUTTON", dataTestId: "stop-button", ariaLabel: "Stop generating", visible: true, nearComposer: true, forbidden: true },
      { tagName: "BUTTON", dataTestId: "voice-button", ariaLabel: "Voice mode", visible: true, nearComposer: true, forbidden: true },
    ], chosen: null },
  });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => {
    assert.equal(error.code, "bridge_send_not_submitted");
    assert.equal(error.diagnostic.draftRetained, true);
    assert.equal(error.diagnostic.submitAttempted, false);
    assert.equal(error.diagnostic.sendControlFound, true);
    assert.equal(error.diagnostic.sendControlEnabled, false);
    assert.equal(error.diagnostic.messageVisible, false);
    assert.equal(error.diagnostic.manualInterventionRequired, false);
    return true;
  });
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchKeyEvent"), "no blind Enter fallback");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"), "no click without an eligible control");
  assert.ok(fake.calls.some(([method]) => method === "Input.insertText"));
  const status = controller.status();
  assert.equal(status.lastSubmitDiagnostic.draftRetained, true);
  assert.equal(status.state, "error");
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

test("a retained draft without a send control becomes exactly one bounded recovery, never a blind resend", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsw-draft-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outbox = new BridgeWakeOutbox({ filePath: join(directory, "outbox.json") });
  await outbox.adoptCloudDelivery({
    deliveryId: "delivery-draft", messageKey: "message-draft", projectId: "project_1", eventId: "event_1",
    taskId: "task_1", eventName: "task.completed", revision: 1,
    wakeTarget: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conv-draft", source: "site" },
  });
  assert.ok(await outbox.beginAttempt("message-draft"));
  await outbox.markFailed("message-draft", Object.assign(new Error("no safe send control"), { code: "bridge_send_not_submitted" }));
  const held = await outbox.findByMessageKey("message-draft");
  assert.equal(held.delivery_state, "uncertain");
  assert.equal(held.send_state, "safe_draft");

  let sendAttempts = 0;
  const bridge = {
    // Reconciliation is read-only and keeps reporting the retained draft.
    reconcileDelivery: async () => ({ state: "safe_draft", stage: "submission_state", diagnostic: { composerHasMessageKey: true, sendEnabled: true, readOnly: true } }),
    sendEnvelope: async () => { sendAttempts += 1; throw Object.assign(new Error("still no safe send control"), { code: "bridge_send_not_submitted" }); },
    sendLocalWake: async () => { sendAttempts += 1; throw Object.assign(new Error("still no safe send control"), { code: "bridge_send_not_submitted" }); },
  };
  const transport = new WakeTransport({ outbox, bridge });
  await transport.drainOnce();
  const recovered = await outbox.findByMessageKey("message-draft");
  assert.equal(recovered.recovery_attempts, 1, "the safe draft schedules one bounded recovery");
  assert.equal(sendAttempts, 1, "the recovery submits exactly once");

  // Every later safe_draft reconciliation must not schedule another recovery.
  await transport.drainOnce();
  await transport.drainOnce();
  const exhausted = await outbox.findByMessageKey("message-draft");
  assert.equal(exhausted.delivery_state, "uncertain");
  assert.equal(exhausted.recovery_attempts, 1, "recovery stays bounded to a single attempt");
  assert.equal(sendAttempts, 1, "no blind resend after the bounded recovery is spent");
  assert.ok(exhausted.reconcile_attempts >= 1, "later reconciliations are recorded without scheduling another send");
});

test("a draft that is never retained is retried without entering the uncertain hold", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsw-draft-lost-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outbox = new BridgeWakeOutbox({ filePath: join(directory, "outbox.json") });
  await outbox.adoptCloudDelivery({
    deliveryId: "delivery-lost", messageKey: "message-lost", projectId: "project_1", eventId: "event_2",
    taskId: "task_2", eventName: "task.completed", revision: 1,
    wakeTarget: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conv-lost", source: "site" },
  });
  await outbox.beginAttempt("message-lost");
  await outbox.markFailed("message-lost", Object.assign(new Error("draft not retained"), { code: "bridge_draft_not_inserted" }));
  const row = await outbox.findByMessageKey("message-lost");
  assert.equal(row.delivery_state, "pending", "nothing was submitted, so a normal retry is safe");
  assert.equal(row.send_state, null);
});

test("sendMessage re-inserts a draft that hydration dropped, then submits the stable control once", async () => {
  const fake = fakeCdp({ composerDraftSequence: [false], sendControlSequence: [null, null] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.filter(([method]) => method === "Input.insertText").length, 1, "the dropped draft is re-inserted once");
  assert.deepEqual(fake.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("sendMessage waits out a slow hydration instead of falling back to a blind submit", async () => {
  // While ChatGPT is still hydrating the toolbar keeps re-rendering, so the
  // observed fingerprint changes on every poll and the wait must continue.
  const hydrating = (tick) => ({ buttonCount: 2, composerFound: true, composerRect: { x: 200, y: 700 + tick, width: 600, height: 80 }, selectorMatches: { 'button[data-testid="send-button"]': 1 }, candidates: [
    { tagName: "BUTTON", dataTestId: "send-button", ariaLabel: "发送消息", disabled: true, visible: true, nearComposer: true, hitMatchesButton: true, isSendControl: true },
  ], chosen: null });
  const readyControl = { buttonCount: 2, composerFound: true, composerRect: { x: 200, y: 700, width: 600, height: 80 }, selectorMatches: { 'button[data-testid="send-button"]': 1 }, candidates: [
    { tagName: "BUTTON", dataTestId: "send-button", ariaLabel: "发送消息", disabled: false, visible: true, nearComposer: true, hitMatchesButton: true, isSendControl: true },
  ], chosen: { selector: 'button[data-testid="send-button"]', x: 420, y: 700, metadata: { tagName: "BUTTON", dataTestId: "send-button", disabled: false, hitMatchesButton: true, isSendControl: true } } };
  const fake = fakeCdp({ sendControlSequence: [...Array(22).keys()].map((tick) => hydrating(tick)).concat([readyControl]) });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchKeyEvent"));
  assert.ok(fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
  assert.equal(fake.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length, 3, "the stable control is clicked exactly once");
});

test("sendMessage refuses to click a lookalike control such as Send feedback", async () => {
  const lookalike = { buttonCount: 1, composerFound: true, composerRect: { x: 200, y: 700, width: 600, height: 80 }, selectorMatches: { 'button[aria-label*="Send" i]': 1 }, candidates: [
    { tagName: "BUTTON", dataTestId: null, ariaLabel: "Send feedback", disabled: false, visible: true, nearComposer: true, hitMatchesButton: true, isSendControl: false },
  ], chosen: null };
  const fake = fakeCdp({ sendControl: lookalike });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => error.code === "bridge_send_not_submitted");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
});

test("send button metadata only accepts a control whose label really names the send action", () => {
  const makeControl = (label, testId) => ({
    tagName: "BUTTON", disabled: false,
    getAttribute(name) { return ({ "data-testid": testId, "aria-label": label, role: null })[name] ?? null; },
    contains(element) { return element === this; },
    getBoundingClientRect: () => ({ x: 500, y: 730, width: 36, height: 36 }),
    closest: () => null,
  });
  const composer = { getBoundingClientRect: () => ({ x: 200, y: 700, width: 600, height: 80 }), closest: () => null };
  const run = (control) => runInNewContext(sendButtonMetadataScript(), {
    document: {
      querySelectorAll(selector) {
        if (selector === "button") return [control];
        if (selector === 'button[data-testid="send-button"]') return control.getAttribute("data-testid") === "send-button" ? [control] : [];
        if (selector === 'button[aria-label*="Send" i]' || selector === 'button[aria-label*="发送"]') return control.getAttribute("aria-label") ? [control] : [];
        if (selector === 'main form button[type="submit"]') return [];
        if (selector === 'main [contenteditable="true"]') return [composer];
        return [];
      },
      querySelector: () => null,
      elementFromPoint: () => control,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  assert.equal(run(makeControl("发送消息", null)).chosen?.metadata.ariaLabel, "发送消息", "a real label-only send button is accepted");
  assert.equal(run(makeControl("Send message", null)).chosen?.metadata.ariaLabel, "Send message");
  assert.equal(run(makeControl("Send feedback", null)).chosen, null, "a lookalike label is rejected");
  assert.equal(run(makeControl("Stop generating", null)).chosen, null, "the stop control is never treated as send");
  assert.equal(run(makeControl(null, "send-button")).chosen?.metadata.dataTestId, "send-button");
});

test("idle probe never reports a disabled send control as enabled", () => {
  const composer = { value: "[DSW] MESSAGE_KEY: message-a", getBoundingClientRect: () => ({ x: 200, y: 700, width: 600, height: 80 }) };
  const control = ({ label = null, testId = null, disabled = false }) => ({
    disabled,
    getAttribute(name) { return name === "aria-label" ? label : name === "data-testid" ? testId : null; },
    getBoundingClientRect: () => ({ x: 500, y: 730, width: 36, height: 36 }),
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
  // Regression: the previous `testId || (label && !disabled)` precedence reported
  // a disabled test-id button as an enabled send control.
  const disabledById = probe([control({ testId: "send-button", disabled: true })]);
  assert.equal(disabledById.sendControlFound, true);
  assert.equal(disabledById.sendControlDisabled, true);
  assert.equal(disabledById.sendEnabled, false);
  // Regression: the real zh control is labelled 发送消息 and carries no test id.
  const labelOnly = probe([control({ label: "发送消息" })]);
  assert.equal(labelOnly.sendEnabled, true);
  assert.equal(labelOnly.sendControlDisabled, false);
  assert.equal(probe([control({ label: "发送", disabled: true })]).sendEnabled, false);
  assert.equal(probe([control({ label: "Stop generating" })]).sendEnabled, false, "the stop control is not a send control");
  assert.equal(probe([control({ label: "Send feedback" })]).sendEnabled, false, "a lookalike label is not a send control");
  assert.equal(probe([control({ testId: "send-button" })]).sendEnabled, true);
});

test("sendMessage confirms a visible wake exactly once and never re-clicks on the same key", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound", reconciledMessageVisible: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(result.deduplicated, true, "an already-visible MESSAGE_KEY is deduplicated before any click");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText"));
});

test("sendMessage waits for an in-progress generation to finish before clicking", async () => {
  const fake = fakeCdp({ generatingProbes: 5 });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  const firstClick = fake.calls.findIndex(([method]) => method === "Input.dispatchMouseEvent");
  assert.ok(firstClick > 0, "a click happened");
  const stateProbes = fake.calls.slice(0, firstClick)
    .filter(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("composerHasMessageKey"));
  assert.ok(stateProbes.length >= 6, `waited for the generation to end (saw ${stateProbes.length} state probes)`);
});

test("a confirmation timeout holds the MESSAGE_KEY instead of submitting a second time", async () => {
  // The click landed, the composer cleared and a Stop control appeared, but the
  // wake bubble has not rendered yet: the outcome is ambiguous, never a resend.
  const fake = fakeCdp({ mouseClickWorks: false, submissionPendingAfterClick: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => {
    assert.equal(error.code, "bridge_send_uncertain");
    assert.equal(error.diagnostic.submitAttempted, true);
    assert.equal(error.diagnostic.manualInterventionRequired, true);
    return true;
  });
  const clicks = fake.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length;
  assert.equal(clicks, 3, "one click sequence only");
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => error.code === "bridge_send_uncertain");
  assert.equal(fake.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length, clicks, "a held key is never clicked again");
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
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), [targetUrl]);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), []);
});

test("sendEnvelope without wake_target uses the global conversation only for an explicit legacy delivery", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), ["https://chatgpt.com/c/legacy-bound"]);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), []);
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
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), ["https://chatgpt.com/c/legacy-bound"]);
  const targeted = fakeCdp({ pageUrl: "https://chatgpt.com/c/other" });
  const targetedController = fakeController(targeted, "https://chatgpt.com/c/legacy-bound");
  targetedController.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await targetedController.sendLocalWake({ ...base, legacy_binding: true, wake_target: TARGETED_ENVELOPE.wake_target });
  assert.deepEqual(targeted.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), [TARGETED_ENVELOPE.wake_target.url]);
  assert.ok(!targeted.calls.some(([method, params]) => method === "Page.navigate" && params.url === "https://chatgpt.com/c/legacy-bound"));
});

test("reconcileDelivery refuses to reconcile against the fixed binding without the legacy flag", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy-bound" });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const delivery = { project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1" };
  assert.deepEqual(await controller.reconcileDelivery(delivery), { state: "uncertain", stage: "target_location", reason: "target_unbound", diagnostic: {} });
  assert.equal(fake.calls.length, 0);
});

test("reconciliation only calls a draft safe when the exact message remains in a ready composer", async () => {
  const ambiguous = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound" });
  const ambiguousController = fakeController(ambiguous);
  ambiguousController.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const delivery = { project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1", legacy_binding: true };
  const unknown = await ambiguousController.reconcileDelivery(delivery);
  assert.equal(unknown.state, "uncertain", "absence from message nodes alone is not proof of non-submission");
  assert.equal(unknown.diagnostic.composerHasMessageKey, false);
  assert.ok(!ambiguous.calls.some(([method]) => method.startsWith("Input.")));

  const safe = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound", composerDraftHasMessageKey: true });
  const safeController = fakeController(safe);
  safeController.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const safeResult = await safeController.reconcileDelivery(delivery);
  assert.equal(safeResult.state, "safe_draft");
  assert.equal(safeResult.diagnostic.composerHasMessageKey, true);
  assert.equal(safeResult.diagnostic.sendEnabled, true);
  assert.ok(!safe.calls.some(([method]) => method.startsWith("Input.")), "reconciliation is read-only and never submits on its own");
});

test("reconciliation matches one conversation across trailing-slash, query, www and project URL variants", async () => {
  const variants = [
    "https://chatgpt.com/c/conv-variant/",
    "https://chatgpt.com/c/conv-variant?model=auto",
    "https://chatgpt.com/c/conv-variant?temporary-chat=true#latest",
    "https://www.chatgpt.com/c/conv-variant",
    "https://chatgpt.com/g/g-project/c/conv-variant",
  ];
  for (const variant of variants) {
    const fake = fakeCdp({ pageUrl: variant, composerDraftHasMessageKey: true });
    const controller = fakeController(fake);
    controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
    const result = await controller.reconcileDelivery({
      project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1",
      wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conv-variant", source: "site" },
    });
    assert.equal(result.diagnostic.targetFound, true, variant);
    assert.equal(result.state, "safe_draft", variant);
    assert.equal(result.diagnostic.readOnly, true, variant);
    assert.ok(!fake.calls.some(([method]) => method === "Page.navigate" || method.startsWith("Input.")), `reconciliation stays read-only for ${variant}`);
  }
});

test("reconciliation fails closed on a different chat, the home page and the global binding", async () => {
  const fake = fakeCdp({
    targets: [
      { targetId: "home", type: "page", url: "https://chatgpt.com/" },
      { targetId: "prefix", type: "page", url: "https://chatgpt.com/c/conv-variant-extra" },
      { targetId: "config", type: "page", url: "https://chatgpt.com/c/legacy-bound" },
    ],
    composerDraftHasMessageKey: true,
  });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.reconcileDelivery({
    project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1",
    wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conv-variant", source: "site" },
  });
  assert.equal(result.state, "uncertain");
  assert.equal(result.stage, "target_location");
  assert.equal(result.reason, "target_missing");
  assert.equal(result.diagnostic.targetFound, false);
  assert.equal(result.diagnostic.chatPageCount, 3);
  assert.equal(result.diagnostic.readOnly, true);
  assert.ok(!fake.calls.some(([method]) => method === "Target.attachToTarget"), "an unmatched target is never attached");
  assert.ok(!fake.calls.some(([method]) => method === "Target.createTarget"), "reconciliation never opens a tab to search for the target");
  assert.ok(!fake.calls.some(([method]) => method === "Page.navigate"), "reconciliation never navigates away from the current draft");
  assert.ok(!fake.calls.some(([method]) => method.startsWith("Input.")));
});

test("reconciliation prefers the delivery wake_target over the globally bound conversation", async () => {
  const fake = fakeCdp({
    targets: [
      { targetId: "config", type: "page", url: "https://chatgpt.com/c/legacy-bound" },
      { targetId: "wake", type: "page", url: "https://chatgpt.com/c/conv-variant/" },
    ],
    composerDraftHasMessageKey: true,
  });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.reconcileDelivery({
    project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1",
    wake_target: { type: "chatgpt_conversation", url: "https://chatgpt.com/c/conv-variant", source: "site" },
  });
  assert.equal(result.state, "safe_draft");
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "wake"));
  assert.ok(!fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "config"));
});

test("reconciliation confirms only the matching sent message in the conversation region", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/bound", reconciledMessageVisible: true });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.reconcileDelivery({
    project_id: "project_123", task_id: "task_123", message_key: "bridge_msg_1", legacy_binding: true,
  });
  assert.equal(result.state, "delivered");
  assert.equal(result.stage, "page_confirmation");
  assert.equal(result.diagnostic.messageVisible, true);
  assert.ok(!JSON.stringify(result).includes("PROJECT_ID"), "diagnostics do not contain message text");
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

  const opened = fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url);
  assert.ok(opened.includes(targetA.url), opened.join(","));
  assert.ok(opened.includes(targetB.url), opened.join(","));
  assert.deepEqual(fake.calls.filter(([method]) => method === "Page.navigate"), [], "the legacy tab is never navigated");
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

// ---------------------------------------------------------------------------
// Agent B contract: probeBrowserHealth + independent conversation tabs
// ---------------------------------------------------------------------------

test("probeBrowserHealth reports ready from the neutral home page without moving the browser", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "home", type: "page", url: "https://chatgpt.com/" }] });
  const controller = fakeController(fake);
  let ensureOptions = null;
  controller.ensureBrowser = async (options) => { ensureOptions = options; return { version: { webSocketDebuggerUrl: "ws://fake" } }; };
  const health = await controller.probeBrowserHealth();
  assert.deepEqual(health, { ok: true, state: "ready", browserOnline: true });
  assert.equal(ensureOptions.allowLaunch, true);
  assert.equal(ensureOptions.openHome, false, "the probe must not ask the browser to open a page");
  assertNoNavigationPrimitives(fake, "the probe must never navigate, create, focus or type");
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "home"));
  // Integration contract: a ready probe is what makes the bridge advertisement ready.
  assert.equal(controller.runtime.bridgeBrowser, "online");
  assert.equal(bridgeReady(controller.runtime, { chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/bound" }), true);
});

test("probeBrowserHealth forwards allowLaunch and reports unavailable without touching a page", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "home", type: "page", url: "https://chatgpt.com/" }] });
  const controller = fakeController(fake);
  let ensureOptions = null;
  controller.ensureBrowser = async (options) => {
    ensureOptions = options;
    throw Object.assign(new Error("Chat Bridge CDP browser is not already connected"), { code: "bridge_cdp_unavailable" });
  };
  const health = await controller.probeBrowserHealth({ allowLaunch: false });
  assert.deepEqual(health, { ok: false, state: "unavailable", browserOnline: false });
  assert.equal(ensureOptions.allowLaunch, false);
  assert.equal(controller.runtime.bridgeBrowser, "unavailable");
  assert.equal(fake.calls.length, 0, "an unavailable browser never opens a CDP session");
});

test("probeBrowserHealth reports needs-login from an already-open login wall without attaching to it", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "auth", type: "page", url: "https://chatgpt.com/auth/login" }] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const health = await controller.probeBrowserHealth();
  assert.deepEqual(health, { ok: false, state: "needs-login", browserOnline: true });
  assert.equal(controller.status().healthState, "needs-login");
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.attachToTarget"), []);
  assertNoNavigationPrimitives(fake);
});

test("probeBrowserHealth reports needs-login when the home page shows the login wall", async () => {
  const fake = fakeCdp({ login: true, targets: [{ targetId: "home", type: "page", url: "https://chatgpt.com/" }] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  assert.deepEqual(await controller.probeBrowserHealth(), { ok: false, state: "needs-login", browserOnline: true });
  assertNoNavigationPrimitives(fake);
});

test("probeBrowserHealth never inspects or claims login for an unrelated conversation tab", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "conv", type: "page", url: "https://chatgpt.com/c/some-private-chat" }] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const health = await controller.probeBrowserHealth();
  // Ready means "CDP capability is usable to attempt a delivery" and nothing
  // more: login was not confirmed, so it must not be reported as logged in.
  assert.deepEqual(health, { ok: true, state: "ready", browserOnline: true });
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.attachToTarget"), [], "an unrelated chat tab is never attached to");
  assert.deepEqual(fake.calls.filter(([method]) => method === "Runtime.evaluate"), [], "an unrelated chat tab is never read");
  assertNoNavigationPrimitives(fake);
});

test("probeBrowserHealth treats an aborted signal as cancellation, not as a health result", async () => {
  const fake = fakeCdp();
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const abort = new AbortController();
  abort.abort(new Error("shutdown"));
  await assert.rejects(controller.probeBrowserHealth({ signal: abort.signal }), /shutdown/u);
});

test("the health probe is what the bootstrap loop calls; the legacy testBridge stays out of it", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "home", type: "page", url: "https://chatgpt.com/" }] });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  let legacyCalls = 0;
  controller.testBridge = async () => { legacyCalls += 1; throw new Error("must not be called"); };
  await controller.probeBrowserHealth();
  await controller.probeBrowserHealth({ allowLaunch: false });
  assert.equal(legacyCalls, 0);
  assert.ok(!fake.calls.some(([method]) => method === "Page.navigate"));
});

test("sameTargetConversation binds the conversation id, the explicit project group and the HTTPS host", () => {
  assert.equal(sameTargetConversation("https://chatgpt.com/c/abc", "https://www.chatgpt.com/c/abc/"), true);
  assert.equal(sameTargetConversation("https://chatgpt.com/c/abc?model=x", "https://chatgpt.com/c/abc"), true);
  assert.equal(sameTargetConversation("https://chatgpt.com/g/g-p-1/c/abc", "https://chatgpt.com/c/abc"), true);
  assert.equal(sameTargetConversation("https://chatgpt.com/g/g-p-1/c/abc", "https://chatgpt.com/g/g-p-1/c/abc"), true);
  assert.equal(sameTargetConversation("https://chatgpt.com/g/g-p-2/c/abc", "https://chatgpt.com/g/g-p-1/c/abc"), false);
  assert.equal(sameTargetConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/c/other"), false);
  assert.equal(sameTargetConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/"), false);
  assert.equal(sameTargetConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/auth/login"), false);
  assert.equal(sameTargetConversation("http://chatgpt.com/c/abc", "https://chatgpt.com/c/abc"), false);
  assert.equal(sameTargetConversation("https://evil.example/c/abc", "https://chatgpt.com/c/abc"), false);
  assert.equal(conversationBinding("https://chatgpt.com/g/g-p-1/c/abc").groupId, "g-p-1");
  assert.equal(conversationBinding("https://chatgpt.com/c/abc").groupId, null);
});

test("sendMessage reuses a canonical tab for a project-prefixed wake target and opens no extra tab", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "tab-A", type: "page", url: "https://chatgpt.com/c/conversation-A" }] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope({
    ...ENVELOPE,
    wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/g/g-p-1/c/conversation-A", source: "site" },
  });
  assert.equal(result.ok, true);
  assert.ok(fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "tab-A"));
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget"), []);
  assertNoPageNavigation(fake);
});

test("sendMessage never types into a tab that belongs to a different explicit project group", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "tab-other-group", type: "page", url: "https://chatgpt.com/g/g-p-2/c/conversation-A" }] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await controller.sendEnvelope({
    ...ENVELOPE,
    wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/g/g-p-1/c/conversation-A", source: "site" },
  });
  assert.ok(!fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "tab-other-group"));
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), ["https://chatgpt.com/g/g-p-1/c/conversation-A"]);
});

test("a legacy delivery never navigates the default empty ChatGPT page", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "home", type: "page", url: "https://chatgpt.com/" }] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.filter(([method]) => method === "Target.createTarget").map(([, params]) => params.url), ["https://chatgpt.com/c/legacy-bound"]);
  assert.ok(!fake.calls.some(([method, params]) => method === "Target.attachToTarget" && params.targetId === "home"));
  assertNoPageNavigation(fake);
});

test("sendMessage is idempotent when the same MESSAGE_KEY is already visible in the target conversation", async () => {
  const fake = fakeCdp({ pageUrl: "https://chatgpt.com/c/legacy-bound", reconciledMessageVisible: true });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.sendEnvelope(LEGACY_ENVELOPE);
  assert.equal(result.ok, true);
  assert.equal(result.deduplicated, true);
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText"), "a visible identical wake is never typed again");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"));
});

test("sendMessage never clicks a disabled send control and keeps the verified draft", async () => {
  const fake = fakeCdp({
    pageUrl: "https://chatgpt.com/c/legacy-bound",
    sendControl: {
      buttonCount: 1,
      selectorMatches: { 'button[data-testid="send-button"]': 1 },
      candidates: [{ tagName: "BUTTON", dataTestId: "send-button", disabled: true, visible: true, nearComposer: true, hitMatchesButton: true, forbidden: false, isSendControl: true }],
      chosen: null,
    },
  });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.sendEnvelope(LEGACY_ENVELOPE), (error) => error.code === "bridge_send_not_submitted");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchMouseEvent"), "a disabled control is never clicked");
  assert.ok(!fake.calls.some(([method]) => method === "Input.dispatchKeyEvent"), "the blind Enter fallback must not come back");
  assert.equal(controller.runtime.bridgeLastSubmitDiagnostic.draftRetained, true);
});

test("reconcileDelivery stays read-only and never opens, navigates or types into a tab", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "tab-A", type: "page", url: "https://chatgpt.com/c/conversation-A" }] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  let ensureOptions = null;
  controller.ensureBrowser = async (options) => { ensureOptions = options; return { version: { webSocketDebuggerUrl: "ws://fake" } }; };
  const result = await controller.reconcileDelivery({
    project_id: "project_123",
    task_id: "task_123",
    message_key: "bridge_msg_1",
    wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/c/conversation-A", source: "site" },
  });
  assert.equal(result.state, "uncertain");
  assert.equal(result.diagnostic.readOnly, true);
  assert.equal(ensureOptions.allowLaunch, false, "reconcile never launches a browser");
  assertNoNavigationPrimitives(fake, "reconcile must never navigate, create, focus or type");
});

test("reconcileDelivery reports target_missing for another conversation without creating a tab", async () => {
  const fake = fakeCdp({ targets: [{ targetId: "tab-B", type: "page", url: "https://chatgpt.com/c/conversation-B" }] });
  const controller = fakeController(fake, "https://chatgpt.com/c/legacy-bound");
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  const result = await controller.reconcileDelivery({
    project_id: "project_123",
    task_id: "task_123",
    message_key: "bridge_msg_1",
    wake_target: { type: "chatgpt_conversation", conversation_id: "conversation-A", url: "https://chatgpt.com/c/conversation-A", source: "site" },
  });
  assert.equal(result.reason, "target_missing");
  assert.equal(result.diagnostic.targetFound, false);
  assertNoNavigationPrimitives(fake);
});


test("transport readiness supports wake targets without a global conversation and preserves delivery uncertainty", () => {
  const config = { chatBridgeEnabled: true, chatBridgeChatUrl: "" };
  const runtime = { bridgeBrowser: "online", bridgeHealthState: "ready", bridgeState: "uncertain", bridgeLastError: "Ambiguous submit" };
  assert.equal(bridgeReady(runtime, config), true);
  assert.equal(bridgePublicState(runtime, config).readinessScope, "transport");
  assert.equal(bridgePublicState(runtime, config).lastError, "Ambiguous submit");
  assert.equal(bridgeReady({ ...runtime, bridgeHealthState: "needs-login" }, config), false);
});


test("message visibility rejects assistant echoes and accepts an explicit user bubble", () => {
  const expression = messageVisibleScript("project-a", "task-a", "message-a");
  const textContent = "PROJECT_ID: project-a TASK_ID: task-a MESSAGE_KEY: message-a";
  const assistantTurn = { textContent };
  const assistantOnly = { querySelectorAll: selector => selector.includes("conversation-turn-") ? [assistantTurn] : [] };
  assert.equal(runInNewContext(expression, { document: assistantOnly }), false);
  const userBubble = { textContent };
  assert.equal(runInNewContext(expression, { document: { querySelectorAll: selector => selector.includes('[data-message-author-role="user"]') ? [userBubble] : [] } }), true);
  assert.doesNotMatch(expression, /conversation-turn-/u);
});


test("message visibility matches complete marker values and rejects every identity prefix", () => {
  const expression = messageVisibleScript("project.a", "task+1", "key[1]");
  const observe = textContent => runInNewContext(expression, { document: { querySelectorAll: () => [{ textContent }] } });
  assert.equal(observe("PROJECT_ID: project.a\nTASK_ID: task+1\nMESSAGE_KEY: key[1]"), true);
  for (const text of [
    "PROJECT_ID: project.abc\nTASK_ID: task+1\nMESSAGE_KEY: key[1]",
    "PROJECT_ID: project.a\nTASK_ID: task+12\nMESSAGE_KEY: key[1]",
    "PROJECT_ID: project.a\nTASK_ID: task+1\nMESSAGE_KEY: key[1]longer",
    "NOT_PROJECT_ID: project.a\nTASK_ID: task+1\nMESSAGE_KEY: key[1]",
  ]) assert.equal(observe(text), false);
});

// ---------------------------------------------------------------------------
// Cold-start regression: the CDP browser never opens about:blank
// ---------------------------------------------------------------------------

/**
 * Cold-start a real ChatBridgeController with a spawn mock, so the exact argv
 * handed to the browser process can be inspected. `fetch` fails once (no CDP
 * endpoint yet), which is what makes ensureBrowser take the launch path.
 */
async function coldStartLaunch({ options } = {}) {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error("CDP not available");
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/test" }) };
  };
  const launches = [];
  let cdpFactoryCalls = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  const controller = new ChatBridgeController({
    runtime: {},
    getConfig: () => ({
      chatBridgeEnabled: true,
      // A bound conversation exists and must never become the start page.
      chatBridgeChatUrl: "https://chatgpt.com/c/legacy-bound",
      chatBridgeDebugPort: 9223,
    }),
    cdpFactory: () => { cdpFactoryCalls += 1; throw new Error("the cold-start path must not open a CDP session"); },
    findBrowserExecutable: () => "C:\\test\\chrome.exe",
    spawnBrowser: (executable, args, spawnOptions) => {
      launches.push({ executable, args, spawnOptions });
      return child;
    },
  });
  try {
    await controller.ensureBrowser(options);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { launches, cdpFactoryCalls: () => cdpFactoryCalls };
}

test("browserLaunchArgs pins the neutral home page and can never emit about:blank", () => {
  const args = browserLaunchArgs({ port: 9223, profileDir: "C:\\profile" });
  assert.deepEqual(args, [
    "--remote-debugging-port=9223",
    "--user-data-dir=C:\\profile",
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/",
  ]);
  assert.equal(BRIDGE_START_URL, "https://chatgpt.com/");
  assert.equal(args.some((arg) => /about:blank/iu.test(arg)), false);
});

test("cold-start browser launch opens the ChatGPT home page instead of about:blank", async () => {
  // No options: this is the `openHome: false` bootstrap/probe shape that used to
  // produce an empty tab on every launch.
  const launch = await coldStartLaunch();
  assert.equal(launch.launches.length, 1, "exactly one browser process is spawned");
  const [{ executable, args, spawnOptions }] = launch.launches;
  assert.equal(executable, "C:\\test\\chrome.exe");
  assert.deepEqual(args, [
    "--remote-debugging-port=9223",
    `--user-data-dir=${bridgeProfileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/",
  ]);
  assert.equal(args.at(-1), BRIDGE_START_URL, "the last argument is the start page");
  assert.equal(args.some((arg) => /about:blank/iu.test(arg)), false, "no launch argument may be about:blank");
  // Isolation: a stale binding must never be opened as the start page.
  assert.equal(args.some((arg) => arg.includes("chatgpt.com/c/")), false, "no conversation URL may be opened at launch");
  // The launch path must not send anything: a wake is only ever typed later,
  // into a tab that was explicitly selected for that conversation.
  assert.equal(args.some((arg) => arg.includes("[DSW]")), false, "a launch argument never carries a wake message");
  // Port, profile and spawn options are unchanged by this fix.
  assert.deepEqual(args.filter((arg) => arg.startsWith("--remote-debugging-port=")), ["--remote-debugging-port=9223"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("--user-data-dir=")), [`--user-data-dir=${bridgeProfileDir()}`]);
  assert.deepEqual(spawnOptions, { detached: false, windowsHide: false, stdio: "ignore" });
  assert.equal(launch.cdpFactoryCalls(), 0, "launching the browser opens no CDP session and touches no page");
});

test("openHome no longer selects the launch URL in either direction", async () => {
  const withHome = await coldStartLaunch({ options: { openHome: true } });
  const withoutHome = await coldStartLaunch({ options: { openHome: false } });
  assert.deepEqual(withHome.launches[0].args, withoutHome.launches[0].args);
  assert.equal(withHome.launches[0].args.at(-1), BRIDGE_START_URL);
  assert.equal(withoutHome.launches[0].args.at(-1), BRIDGE_START_URL);
  assert.equal(withoutHome.launches[0].args.some((arg) => /about:blank/iu.test(arg)), false);
});

test("probeBrowserHealth cold-starts on the home page and never adopts or moves an old chat tab", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error("CDP not available");
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://fake" }) };
  };
  // The launched browser exposes the neutral home page it was started on, plus a
  // pre-existing conversation tab belonging to the user.
  const fake = fakeCdp({
    targets: [
      { targetId: "home", type: "page", url: BRIDGE_START_URL },
      { targetId: "old-chat", type: "page", url: "https://chatgpt.com/c/legacy-bound" },
    ],
  });
  const launches = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  const controller = new ChatBridgeController({
    runtime: {},
    getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/legacy-bound", chatBridgeDebugPort: 9223 }),
    cdpFactory: () => fake.cdp,
    findBrowserExecutable: () => "C:\\test\\chrome.exe",
    spawnBrowser: (_executable, args) => { launches.push(args); return child; },
  });
  let health;
  try {
    health = await controller.probeBrowserHealth();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(health, { ok: true, state: "ready", browserOnline: true });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].at(-1), BRIDGE_START_URL);
  assert.equal(launches[0].some((arg) => /about:blank/iu.test(arg)), false);
  // Read-only probe discipline is unchanged: no navigation, creation or typing.
  assertNoNavigationPrimitives(fake, "the probe must never navigate, create, focus or type");
  assert.ok(!fake.calls.some(([method]) => method === "Input.insertText"), "the probe never types a wake message");
  // Only the neutral home page is read; the user's conversation tab is untouched.
  const attached = fake.calls.filter(([method]) => method === "Target.attachToTarget").map(([, params]) => params.targetId);
  assert.deepEqual(attached, ["home"]);
});
