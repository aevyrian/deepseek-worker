import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  ChatBridgeController,
  bridgePublicState,
  bridgeReady,
  buildBridgeControlMessage,
  buildCloudBridgeControlMessage,
  normalizeBridgeChatUrl,
  normalizeBridgeEnvelope,
  sameChatUrl,
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

function fakeCdp({
  login = false,
  pageUrl = "https://chatgpt.com/c/old",
  navigationUrl,
  spaUrls = [],
  targets,
  composerAvailable = true,
  runtimeErrors = [],
  runtimeError,
  scriptException = false,
} = {}) {
  const calls = [];
  const pendingSpaUrls = [...spaUrls];
  const pendingRuntimeErrors = [...runtimeErrors];
  const targetInfos = targets ?? [{ targetId: "chat", type: "page", url: pageUrl }];
  const targetUrls = new Map(targetInfos.map((target) => [target.targetId, target.url]));
  let activeTargetId = targetInfos[0]?.targetId ?? null;
  let href = activeTargetId ? targetUrls.get(activeTargetId) : pageUrl;
  let navigated = false;
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
          return { result: { value: { href: login ? "https://chatgpt.com/auth/login" : href, authRequired: login } } };
        }
        if (params.expression.includes("composer_not_found")) {
          return { result: { value: { ok: composerAvailable, reason: composerAvailable ? undefined : "composer_not_found", href } } };
        }
      }
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

test("Bridge test distinguishes a valid conversation without a composer", async () => {
  const fake = fakeCdp({ composerAvailable: false });
  const controller = fakeController(fake);
  controller.ensureBrowser = async () => ({ version: { webSocketDebuggerUrl: "ws://fake" } });
  await assert.rejects(controller.testBridge(), (error) => error.code === "bridge_composer_unavailable");
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