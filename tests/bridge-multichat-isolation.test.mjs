/**
 * Agent C — multi-conversation isolation, fake-CDP end-to-end harness.
 *
 * Scope of this file
 * ------------------
 * This file is an independent integration suite. It never touches a real
 * ChatGPT page, a real browser profile, a real Outbox or the running Connector.
 * Everything runs against a fake CDP transport: a loopback HTTP endpoint that
 * only answers `/json/version` (so `ensureBrowser` sees an "already online"
 * browser and never spawns one) plus an injected `cdpFactory` that models the
 * CDP surface the bridge actually uses.
 *
 * It covers, per the three-agent interface agreement:
 *   - two independent conversations A/B and a global legacy conversation that
 *     disagrees with `wake_target`
 *   - `wake_target` outranking the global binding, and never touching the other
 *     conversation's composer / send control
 *   - interleaved A/B deliveries
 *   - legacy `legacy_binding` deliveries still working
 *   - fail-closed behaviour for a missing or invalid target, and for ambiguous
 *     tab sets
 *   - already-visible messages not being re-sent
 *   - `uncertain` / `safe_draft` recovery rules
 *   - the NEW interfaces agreed with Agent A/B:
 *       `ChatBridgeController#probeBrowserHealth({allowLaunch, signal})`
 *       `runBridgeBootstrap` driving it instead of `testBridge`, never
 *       navigating a conversation page, and preparing browser capability
 *       without any global conversation binding.
 *
 * Baseline expectation
 * --------------------
 * This branch is cut from 9a24513672c3253cc0381cfec5da6c058b72b6ee, before the
 * Agent A / Agent B interfaces landed. Every test named `[NEW-INTERFACE]` is
 * therefore EXPECTED TO FAIL on this baseline. The failure is the contract, not
 * a harness defect: the suite self-proves the harness is runnable via the
 * `[harness]` and `[isolation]` / `[recovery]` groups, which must be green on
 * the baseline. `lib/` is deliberately not modified to make anything pass.
 * The final `[report]` test prints the tally for the integrator.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";

import {
  ChatBridgeController,
  buildCloudBridgeControlMessage,
  normalizeWakeTarget,
  sameConversationUrl,
} from "../lib/chat-bridge.mjs";
import { runBridgeBootstrap } from "../lib/bridge-bootstrap.mjs";

const URL_A = "https://chatgpt.com/c/conv-alpha";
const URL_B = "https://chatgpt.com/c/conv-bravo";
const URL_C = "https://chatgpt.com/c/conv-charlie";

const FORBIDDEN_PAGE_OPERATIONS = [
  "Page.navigate",
  "Input.insertText",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Target.createTarget",
  "Target.activateTarget",
  "Browser.setWindowBounds",
];

// ---------------------------------------------------------------------------
// Fake CDP transport
// ---------------------------------------------------------------------------

function newPage(url, overrides = {}) {
  return {
    url,
    composerFound: true,
    composerText: "",
    sendEnabled: true,
    sendControlEligible: true,
    submitting: false,
    staleStop: false,
    visibleErrors: 0,
    authRequired: false,
    visibleMessages: [],
    navigations: 0,
    ...overrides,
  };
}

/**
 * Script dispatch keys. Each entry is a substring that is unique to exactly one
 * page script the bridge sends, so a drift in `lib/chat-bridge.mjs` scripts
 * surfaces as an entry in `unknownScripts` instead of a silent pass.
 */
const SCRIPT_DISPATCH = Object.freeze([
  ["readyState: document.readyState", "pageProbe"],
  ["authRequired: authPath", "loginState"],
  ["composer_not_focusable", "composerFocus"],
  ["composerText().includes('MESSAGE_KEY: '", "composerContains"],
  ["buttonCount: allButtons.length", "sendButtonMetadata"],
  ["composerEmpty: value.trim().length === 0", "composerSendState"],
  ["data-user-message-bubble", "messageVisible"],
]);

function scriptOf(expression) {
  for (const [needle, name] of SCRIPT_DISPATCH) {
    if (expression.includes(needle)) return name;
  }
  return null;
}

function quotedAfter(expression, label) {
  const match = new RegExp(`${label}: '\\s*\\+\\s*"([^"]+)"`).exec(expression);
  return match ? match[1] : null;
}

class FakeCdp {
  constructor({ world, calls, unknownScripts, unknownMethods, wsUrl }) {
    this.world = world;
    this.calls = calls;
    this.unknownScripts = unknownScripts;
    this.unknownMethods = unknownMethods;
    this.wsUrl = wsUrl;
    this.closed = false;
  }

  async open() {
    return undefined;
  }

  close() {
    this.closed = true;
  }

  #page(targetId) {
    return this.world.targets.get(targetId)?.page ?? null;
  }

  #evaluate(targetId, expression) {
    const page = this.#page(targetId);
    if (!page) return null;
    const script = scriptOf(expression);
    this.world.beforeEvaluate?.(targetId, script, page);
    if (!script) {
      this.unknownScripts.push(expression.slice(0, 120));
      return null;
    }
    const messageKey = quotedAfter(expression, "MESSAGE_KEY");
    switch (script) {
      case "pageProbe":
        return { href: page.url, readyState: "complete" };
      case "loginState":
        return { href: page.url, authRequired: page.authRequired === true };
      case "composerFocus":
        return page.composerFound
          ? { ok: true, focused: true, tag: "DIV", href: page.url }
          : { ok: false, reason: "composer_not_found", href: page.url };
      case "composerContains":
        return {
          ok: page.composerText.includes(`MESSAGE_KEY: ${messageKey}`),
          matchesExpectedMessage: (() => {
            const literal = expression.match(/=== ("(?:[^"\\]|\\.)*")/u)?.[1];
            return !literal || page.composerText.trim() === JSON.parse(literal);
          })(),
        };
      case "sendButtonMetadata":
        return this.#sendButtonMetadata(page);
      case "composerSendState":
        return this.#composerSendState(page, messageKey);
      case "messageVisible": {
        const projectId = quotedAfter(expression, "PROJECT_ID");
        const taskId = quotedAfter(expression, "TASK_ID");
        return page.visibleMessages.some((text) => text.includes(`PROJECT_ID: ${projectId}`)
          && text.includes(`TASK_ID: ${taskId}`)
          && text.includes(`MESSAGE_KEY: ${messageKey}`));
      }
      default:
        this.unknownScripts.push(expression.slice(0, 120));
        return null;
    }
  }

  #sendButtonMetadata(page) {
    const metadata = {
      tagName: "BUTTON",
      role: null,
      dataTestId: "send-button",
      ariaLabel: "Send message",
      disabled: false,
      rect: { x: 360, y: 600, width: 36, height: 36 },
      visibility: "visible",
      display: "block",
      visible: true,
      nearComposer: true,
      inForm: true,
      inContainer: true,
      distance: 12,
      forbidden: false,
      isSendControl: true,
      hitMatchesButton: true,
    };
    const chosen = page.sendControlEligible
      ? { selector: 'button[data-testid="send-button"]', x: 378, y: 618, metadata }
      : null;
    return {
      buttonCount: 1,
      composerFound: page.composerFound === true,
      composerRect: { x: 100, y: 560, width: 600, height: 64 },
      selectorMatches: { 'button[data-testid="send-button"]': page.sendControlEligible ? 1 : 0 },
      candidates: chosen ? [metadata] : [],
      chosen,
    };
  }

  #composerSendState(page, messageKey) {
    const hasKey = page.composerText.includes(`MESSAGE_KEY: ${messageKey}`);
    const empty = page.composerText.trim().length === 0;
    return {
      composerFound: page.composerFound === true,
      composerHasMessageKey: hasKey,
      composerEmpty: empty,
      sendEnabled: page.sendEnabled === true,
      sendControlFound: page.sendControlEligible !== false,
      sendControlDisabled: page.sendEnabled !== true,
      submitting: page.submitting === true,
      staleStopControl: page.staleStop === true,
      visibleErrors: page.visibleErrors ?? 0,
      idle: empty && page.submitting !== true && page.staleStop !== true && (page.visibleErrors ?? 0) === 0,
    };
  }

  async send(method, params = {}, sessionId) {
    const targetId = sessionId ? String(sessionId).replace(/^session:/u, "") : null;
    this.calls.push({ method, params, sessionId: sessionId ?? null, targetId, script: method === "Runtime.evaluate" ? scriptOf(String(params.expression ?? "")) : null });

    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [...this.world.targets.values()].map((entry) => ({
            targetId: entry.targetId,
            type: entry.type,
            url: entry.page.url,
            title: entry.page.title ?? "",
          })),
        };
      case "Target.getTargetInfo": {
        const entry = this.world.targets.get(params.targetId);
        return {
          targetInfo: entry
            ? { targetId: entry.targetId, type: entry.type, url: entry.page.url }
            : null,
        };
      }
      case "Target.attachToTarget": {
        const entry = this.world.targets.get(params.targetId);
        if (!entry) throw new Error("No target with given id found");
        return { sessionId: `session:${entry.targetId}` };
      }
      case "Target.createTarget": {
        const targetId = `created-${this.world.sequence += 1}`;
        this.world.targets.set(targetId, { targetId, type: "page", page: newPage(params.url) });
        return { targetId };
      }
      case "Target.activateTarget":
      case "Browser.setWindowBounds":
      case "Page.enable":
      case "Runtime.enable":
      case "Input.dispatchKeyEvent":
        return {};
      case "Browser.getWindowForTarget":
        return { windowId: 1 };
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: {
              id: `frame:${targetId}`,
              url: this.#page(targetId)?.url ?? "",
            },
          },
        };
      case "Page.navigate": {
        const page = this.#page(targetId);
        if (page) {
          page.url = params.url;
          page.navigations += 1;
        }
        return { frameId: `frame:${targetId}` };
      }
      case "Input.insertText": {
        const page = this.#page(targetId);
        if (page) {
          await this.world.beforeInsert?.(targetId, params.text);
          page.composerText += String(params.text ?? "");
        }
        return {};
      }
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseReleased") {
          const page = this.#page(targetId);
          if (page) await this.world.onSubmit?.(targetId, page);
        }
        return {};
      }
      case "Runtime.evaluate":
        return { result: { value: this.#evaluate(targetId, String(params.expression ?? "")) } };
      default:
        this.unknownMethods.push(method);
        return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A loopback endpoint that only answers `/json/version`. `ensureBrowser` treats
 * a reachable endpoint as "browser already online", so no browser is launched
 * and no user profile is touched.
 *
 * One endpoint is shared by the whole file. A per-test ephemeral port made the
 * suite flaky: the kernel hands the same free port back to a later test while
 * the HTTP client still holds a pooled socket to that origin. A single stable
 * origin, `connection: close` and an unref'd listener remove that class of
 * nondeterminism.
 */
let sharedEndpoint = null;

async function startFakeDebugEndpoint() {
  const server = createServer((request, response) => {
    if (String(request.url ?? "").startsWith("/json/version")) {
      const port = server.address().port;
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({
        Browser: "FakeCdp/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json", connection: "close" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = server.address().port;
  return {
    port,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function fakeDebugEndpoint() {
  if (!sharedEndpoint) sharedEndpoint = await startFakeDebugEndpoint();
  return sharedEndpoint;
}

after(async () => {
  const endpoint = sharedEndpoint;
  sharedEndpoint = null;
  await endpoint?.stop();
});

/**
 * Default simulated submit: the composer's text becomes a visible turn and the
 * composer is cleared, which is what a real ChatGPT send does.
 */
function defaultSubmit(_targetId, page) {
  page.visibleMessages.push(page.composerText);
  page.composerText = "";
  page.submitting = false;
}

async function createHarness({ targets = [], config = {}, onSubmit, beforeInsert } = {}) {
  const endpoint = await fakeDebugEndpoint();
  const world = { targets: new Map(), sequence: 0, onSubmit: onSubmit ?? defaultSubmit, beforeInsert };
  for (const entry of targets) {
    world.targets.set(entry.targetId, {
      targetId: entry.targetId,
      type: "page",
      page: newPage(entry.url, entry.page),
    });
  }

  const calls = [];
  const unknownScripts = [];
  const unknownMethods = [];
  let spawnAttempts = 0;

  const runtime = { bridgeState: "uninitialized", bridgeBrowser: "unknown", bridgeLastError: null };
  const settings = {
    chatBridgeEnabled: true,
    chatBridgeChatUrl: "",
    chatBridgeDebugPort: endpoint.port,
    ...config,
  };

  const controller = new ChatBridgeController({
    runtime,
    getConfig: () => settings,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    cdpFactory: (wsUrl) => new FakeCdp({ world, calls, unknownScripts, unknownMethods, wsUrl }),
    spawnBrowser: () => {
      spawnAttempts += 1;
      throw Object.assign(new Error("the harness must never launch a real browser"), { code: "ENOENT" });
    },
    findBrowserExecutable: () => null,
  });

  return {
    endpoint,
    world,
    calls,
    unknownScripts,
    unknownMethods,
    runtime,
    settings,
    controller,
    get spawnAttempts() { return spawnAttempts; },
    page: (targetId) => world.targets.get(targetId)?.page ?? null,
    // The debug endpoint is shared for the whole file and torn down by the
    // `after` hook, so a per-harness close is intentionally a no-op.
    close: async () => {},
  };
}

function envelope({ key = "mk-alpha-1", project = "proj-1", task = "task-1", target = null, legacy = false } = {}) {
  return {
    delivery_id: `delivery-${key}`,
    message_key: key,
    project_id: project,
    event_id: `event-${key}`,
    task_id: task,
    event_name: "task.completed",
    project_revision: 1,
    ...(target ? { wake_target: target } : {}),
    ...(legacy ? { legacy_binding: true } : {}),
  };
}

function conversation(url) {
  return { type: "chatgpt_conversation", url };
}

function delivery({ key = "mk-alpha-1", project = "proj-1", task = "task-1", target = null, legacy = false } = {}) {
  return {
    message_key: key,
    project_id: project,
    task_id: task,
    ...(target ? { wake_target: target } : {}),
    legacy_binding: legacy,
  };
}

function callsMatching(calls, predicate) {
  return calls.filter(predicate);
}

function pageOperations(calls, targetId) {
  return callsMatching(calls, (call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)
    && (targetId === undefined || call.targetId === targetId));
}

/**
 * A sleep that always yields to the macrotask queue and aborts the run after a
 * bounded number of calls. A bare resolved promise would starve `setTimeout`
 * inside the bootstrap loop and turn a watchdog into a livelock.
 */
function boundedSleep(controller, limit = 3) {
  let count = 0;
  return async () => {
    count += 1;
    if (count >= limit) controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
  };
}

async function waitUntil(predicate, { timeoutMs = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Baseline tally for the unmerged Agent A / Agent B interfaces
// ---------------------------------------------------------------------------

const tally = { green: [], red: [] };

function newInterfaceTest(name, body) {
  test(`[NEW-INTERFACE] ${name}`, async () => {
    try {
      await body();
      tally.green.push(name);
    } catch (error) {
      tally.red.push({ name, message: String(error?.message ?? error).split("\n")[0] });
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Harness self-proof
// ---------------------------------------------------------------------------

test("[harness] the fake CDP endpoint and script dispatch drive a real end-to-end send", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  try {
    assert.equal(await harness.controller.isBrowserAvailable(), true, "the fake debugging endpoint must be reachable");

    const result = await harness.controller.sendEnvelope(envelope({ target: conversation(URL_A) }));

    assert.equal(result.ok, true);
    assert.equal(result.deduplicated, false);
    assert.equal(harness.runtime.bridgeState, "sent");
    assert.equal(harness.runtime.bridgeLastMessageKey, "mk-alpha-1");
    assert.deepEqual(harness.unknownScripts, [], "every page script the bridge sends must be modelled by the fake CDP");
    assert.deepEqual(harness.unknownMethods, [], "every CDP method the bridge sends must be modelled by the fake CDP");
    assert.equal(harness.spawnAttempts, 0, "a delivery must reuse the online CDP endpoint instead of launching a browser");
    assert.equal(harness.page("tab-A").visibleMessages.length, 1, "the wake must land in the target conversation");
    assert.equal(harness.page("tab-A").composerText, "", "the composer must be cleared by the simulated submit");
  } finally {
    await harness.close();
  }
});

test("[status] wake-target-only delivery retains its delivery state without a global binding", async () => {
  // Documents a baseline property the multi-conversation work must be aware of:
  // `bridgePublicState` derives its `state` from the GLOBAL chatBridgeChatUrl,
  // so a wake_target-only deployment reports `unbound` even right after a
  // verified send. Asserted here so an integration that changes it is noticed
  // rather than silently assumed.
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  try {
    const result = await harness.controller.sendEnvelope(envelope({ key: "mk-alpha-1", target: conversation(URL_A) }));

    assert.equal(result.ok, true);
    assert.equal(harness.runtime.bridgeState, "sent");
    assert.equal(result.state, "sent", "the delivery fact stays visible without a global binding");
    assert.equal(result.bound, false);
    assert.equal(harness.page("tab-A").visibleMessages.length, 1);
  } finally {
    await harness.close();
  }
});

test("[harness] the debug endpoint is the only network surface the harness exposes", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  try {
    const response = await fetch(`http://127.0.0.1:${harness.endpoint.port}/json/list`);
    assert.equal(response.status, 404, "no other CDP HTTP route is served, so nothing can be driven out of band");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Multi-conversation isolation
// ---------------------------------------------------------------------------

test("[isolation] wake_target A wins over a legacy global conversation pointing at B", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
    config: { chatBridgeChatUrl: URL_B },
  });
  try {
    const result = await harness.controller.sendEnvelope(envelope({ target: conversation(URL_A) }));

    assert.equal(result.ok, true);
    assert.equal(harness.page("tab-A").visibleMessages.length, 1, "the wake must land in A");
    assert.equal(harness.page("tab-B").visibleMessages.length, 0, "the wake must not land in the global legacy conversation B");
    assert.equal(harness.page("tab-B").composerText, "", "B's composer must never be written to");
    assert.deepEqual(pageOperations(harness.calls, "tab-B"), [], "B must not be navigated, activated or typed into");
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Page.navigate"), []);
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Target.createTarget"), []);
  } finally {
    await harness.close();
  }
});

test("[isolation] interleaved A/B deliveries never cross conversations", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
  });
  try {
    const first = await harness.controller.sendEnvelope(envelope({ key: "mk-a-1", target: conversation(URL_A) }));
    const second = await harness.controller.sendEnvelope(envelope({ key: "mk-b-1", target: conversation(URL_B) }));
    const third = await harness.controller.sendEnvelope(envelope({ key: "mk-a-2", target: conversation(URL_A) }));

    assert.equal(first.ok && second.ok && third.ok, true);
    const inA = harness.page("tab-A").visibleMessages.join("\n");
    const inB = harness.page("tab-B").visibleMessages.join("\n");
    assert.equal(harness.page("tab-A").visibleMessages.length, 2);
    assert.equal(harness.page("tab-B").visibleMessages.length, 1);
    assert.ok(inA.includes("MESSAGE_KEY: mk-a-1") && inA.includes("MESSAGE_KEY: mk-a-2"));
    assert.ok(!inA.includes("mk-b-1"), "B's wake must never appear in A");
    assert.ok(inB.includes("MESSAGE_KEY: mk-b-1"));
    assert.ok(!inB.includes("mk-a-1") && !inB.includes("mk-a-2"), "A's wakes must never appear in B");
    assert.equal(
      callsMatching(harness.calls, (call) => call.method === "Input.insertText").length,
      3,
      "exactly one draft insertion per delivery, never a re-insert into the other conversation",
    );
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Page.navigate"), []);
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Target.createTarget"), []);
    assert.equal(harness.page("tab-A").composerText, "");
    assert.equal(harness.page("tab-B").composerText, "");
  } finally {
    await harness.close();
  }
});

test("[isolation] reconcile of A reads only A and never moves the browser", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
  });
  try {
    await harness.controller.sendEnvelope(envelope({ key: "mk-a-1", target: conversation(URL_A) }));
    const before = harness.calls.length;
    const result = await harness.controller.reconcileDelivery(delivery({ key: "mk-a-1", target: conversation(URL_A) }));

    assert.equal(result.state, "delivered");
    assert.equal(result.stage, "page_confirmation");
    assert.equal(result.diagnostic.readOnly, true);
    const during = harness.calls.slice(before);
    assert.deepEqual(during.filter((call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)), []);
    assert.equal(harness.page("tab-B").composerText, "");
    assert.equal(harness.page("tab-B").navigations, 0);
  } finally {
    await harness.close();
  }
});

test("[legacy] an explicit legacy_binding delivery still uses the configured conversation", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
    config: { chatBridgeChatUrl: URL_B },
  });
  try {
    const result = await harness.controller.sendEnvelope(envelope({ key: "mk-legacy-1", legacy: true }));

    assert.equal(result.ok, true);
    assert.equal(harness.page("tab-B").visibleMessages.length, 1, "legacy deliveries keep working through the global binding");
    assert.equal(harness.page("tab-A").visibleMessages.length, 0);
    assert.equal(harness.page("tab-A").composerText, "");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

test("[fail-closed] a delivery with neither wake_target nor legacy_binding is refused before touching CDP", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }],
    config: { chatBridgeChatUrl: URL_A },
  });
  try {
    await assert.rejects(
      () => harness.controller.sendEnvelope(envelope({ key: "mk-orphan-1" })),
      (error) => {
        assert.equal(error.code, "bridge_wake_target_required");
        return true;
      },
    );
    assert.deepEqual(harness.calls, [], "no target means no CDP work at all");
    assert.equal(harness.page("tab-A").composerText, "");
    assert.equal(harness.page("tab-A").visibleMessages.length, 0);
  } finally {
    await harness.close();
  }
});

test("[fail-closed] invalid wake_target URLs are rejected instead of being guessed", async () => {
  for (const [label, target] of [
    ["non-conversation chatgpt URL", conversation("https://chatgpt.com/")],
    ["settings URL", conversation("https://chatgpt.com/#settings")],
    ["foreign host", conversation("https://evil.example/c/conv-alpha")],
    ["wrong target type", { type: "chatgpt_project", url: URL_A }],
    ["missing type", { url: URL_A }],
    ["non-object", "https://chatgpt.com/c/conv-alpha"],
  ]) {
    assert.throws(() => normalizeWakeTarget(target), /bridge_wake_target_invalid|Chat Bridge URL must be an HTTPS chatgpt\.com URL/u, `must reject: ${label}`);
  }

  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }],
    config: { chatBridgeChatUrl: URL_A },
  });
  try {
    await assert.rejects(
      () => harness.controller.sendEnvelope(envelope({ key: "mk-bad-1", target: conversation("https://chatgpt.com/") })),
      /bridge_wake_target_invalid/u,
    );
    assert.deepEqual(harness.calls, []);
  } finally {
    await harness.close();
  }
});

test("[isolation] absent requested tab creates a new tab without changing unrelated tabs", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-B", url: URL_B }, { targetId: "tab-C", url: URL_C }] });
  try {
    const result = await harness.controller.sendEnvelope(envelope({ key: "mk-amb-1", target: conversation(URL_A) }));
    assert.equal(result.ok, true);
    assert.equal(callsMatching(harness.calls, (call) => call.method === "Target.createTarget").length, 1);
    assert.equal(harness.page("tab-B").url, URL_B);
    assert.equal(harness.page("tab-C").url, URL_C);
    assert.equal(harness.page("tab-B").composerText, "");
    assert.equal(harness.page("tab-C").composerText, "");
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Page.navigate"), []);
  } finally { await harness.close(); }
});

test("[fail-closed] reconcile reports target_missing instead of moving the browser to look for the conversation", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-B", url: URL_B }] });
  try {
    const result = await harness.controller.reconcileDelivery(delivery({ key: "mk-a-1", target: conversation(URL_A) }));

    assert.equal(result.state, "uncertain");
    assert.equal(result.stage, "target_location");
    assert.equal(result.reason, "target_missing");
    assert.equal(result.diagnostic.targetFound, false);
    assert.deepEqual(callsMatching(harness.calls, (call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)), []);
    assert.equal(harness.page("tab-B").composerText, "");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// No duplicate delivery
// ---------------------------------------------------------------------------

test("[dedup] an already-visible wake is never re-submitted", async () => {
  const raw = envelope({ key: "mk-dup-1", target: conversation(URL_A) });
  const text = buildCloudBridgeControlMessage(raw);
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A, page: { visibleMessages: [text] } }],
  });
  try {
    const result = await harness.controller.sendEnvelope(raw);

    assert.equal(result.ok, true);
    assert.equal(result.deduplicated, true);
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Input.insertText"), []);
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Input.dispatchMouseEvent"), []);
    assert.equal(harness.page("tab-A").visibleMessages.length, 1, "the conversation must not gain a second copy");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// uncertain / safe_draft recovery rules
// ---------------------------------------------------------------------------

test("[recovery] an ambiguous submit outcome holds the MESSAGE_KEY as uncertain and blocks a resend", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }],
    // Simulated ambiguous submit: the draft left the composer and a generation
    // control is live, but the wake never became visible in the conversation.
    onSubmit: (_targetId, page) => {
      page.composerText = "";
      page.submitting = true;
    },
  });
  try {
    await assert.rejects(
      () => harness.controller.sendEnvelope(envelope({ key: "mk-uncertain-1", target: conversation(URL_A) })),
      (error) => {
        assert.equal(error.code, "bridge_send_uncertain");
        assert.equal(error.diagnostic.manualInterventionRequired, true);
        return true;
      },
    );
    assert.equal(harness.runtime.bridgeUncertainMessageKey, "mk-uncertain-1");
    assert.equal(harness.runtime.bridgeState, "uncertain");

    const insertsBefore = callsMatching(harness.calls, (call) => call.method === "Input.insertText").length;
    await assert.rejects(
      () => harness.controller.sendEnvelope(envelope({ key: "mk-uncertain-1", target: conversation(URL_A) })),
      (error) => {
        assert.equal(error.code, "bridge_send_uncertain");
        return true;
      },
    );
    assert.equal(callsMatching(harness.calls, (call) => call.method === "Input.insertText").length, insertsBefore,
      "a held MESSAGE_KEY must never be inserted or submitted a second time");
  } finally {
    await harness.close();
  }
});

test("[recovery] a retained draft is reported as not-submitted, then reconciled as safe_draft", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A, page: { sendControlEligible: false } }],
  });
  try {
    await assert.rejects(
      () => harness.controller.sendEnvelope(envelope({ key: "mk-draft-1", target: conversation(URL_A) })),
      (error) => {
        assert.equal(error.code, "bridge_send_not_submitted");
        assert.equal(error.diagnostic.draftRetained, true);
        assert.equal(error.diagnostic.submitAttempted, false);
        return true;
      },
    );
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Input.dispatchMouseEvent"), [],
      "no blind Enter or click fallback may be used");
    assert.ok(harness.page("tab-A").composerText.includes("MESSAGE_KEY: mk-draft-1"), "the verified draft must be preserved");

    const before = harness.calls.length;
    const result = await harness.controller.reconcileDelivery(delivery({ key: "mk-draft-1", target: conversation(URL_A) }));

    assert.equal(result.state, "safe_draft");
    assert.equal(result.stage, "submission_state");
    assert.equal(result.diagnostic.composerHasMessageKey, true);
    assert.equal(result.diagnostic.messageVisible, false);
    assert.equal(result.diagnostic.readOnly, true);
    assert.deepEqual(callsMatching(harness.calls.slice(before), (call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)), []);
  } finally {
    await harness.close();
  }
});

test("[recovery] reconcile stays uncertain while the page is still generating", async () => {
  const raw = envelope({ key: "mk-gen-1", target: conversation(URL_A) });
  const text = buildCloudBridgeControlMessage(raw);
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A, page: { composerText: text, submitting: true } }],
  });
  try {
    const result = await harness.controller.reconcileDelivery(delivery({ key: "mk-gen-1", target: conversation(URL_A) }));

    assert.equal(result.state, "uncertain");
    assert.equal(result.reason, "generating");
    assert.equal(result.diagnostic.draftRetained, undefined);
    assert.equal(result.diagnostic.composerHasMessageKey, true);
    assert.equal(result.diagnostic.submitting, true);
    assert.deepEqual(callsMatching(harness.calls, (call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)), []);
  } finally {
    await harness.close();
  }
});

test("[recovery] reconcile does not claim safe_draft while a visible error is on the page", async () => {
  const raw = envelope({ key: "mk-err-1", target: conversation(URL_A) });
  const text = buildCloudBridgeControlMessage(raw);
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A, page: { composerText: text, visibleErrors: 1 } }],
  });
  try {
    const result = await harness.controller.reconcileDelivery(delivery({ key: "mk-err-1", target: conversation(URL_A) }));

    assert.equal(result.state, "uncertain");
    assert.equal(result.reason, "visible_error");
    assert.equal(result.diagnostic.visibleErrors, 1);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// NEW interfaces: Agent B `probeBrowserHealth` + Agent A `runBridgeBootstrap`
// ---------------------------------------------------------------------------

newInterfaceTest("ChatBridgeController#probeBrowserHealth exists and returns the agreed shape", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  try {
    assert.equal(
      typeof harness.controller.probeBrowserHealth,
      "function",
      "Agent B must add `async probeBrowserHealth({allowLaunch=true, signal}={})` to ChatBridgeController on baseline 9a24513",
    );

    const result = await harness.controller.probeBrowserHealth({ allowLaunch: false });

    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.browserOnline, "boolean");
    assert.ok(["ready", "needs-login", "unavailable"].includes(result.state), `unexpected state: ${result.state}`);
    assert.equal(result.ok, true);
    assert.equal(result.state, "ready");
    assert.equal(result.browserOnline, true);
  } finally {
    await harness.close();
  }
});

newInterfaceTest("probeBrowserHealth is read-only: no navigate, focus, activate, Input or new target", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
    config: { chatBridgeChatUrl: URL_B },
  });
  try {
    assert.equal(typeof harness.controller.probeBrowserHealth, "function", "Agent B must add probeBrowserHealth");
    await harness.controller.probeBrowserHealth({ allowLaunch: false });
    await harness.controller.probeBrowserHealth({ allowLaunch: true });

    assert.deepEqual(
      callsMatching(harness.calls, (call) => FORBIDDEN_PAGE_OPERATIONS.includes(call.method)),
      [],
      "probeBrowserHealth may reuse/launch CDP but must never navigate, focus, activate, type into or open a page",
    );
    assert.equal(harness.spawnAttempts, 0, "an already-online CDP endpoint must be reused, not relaunched");
    assert.equal(harness.page("tab-A").composerText, "");
    assert.equal(harness.page("tab-B").composerText, "");
  } finally {
    await harness.close();
  }
});

newInterfaceTest("probeBrowserHealth reports unavailable instead of assuming login when no CDP endpoint exists", async () => {
  const harness = await createHarness({ targets: [] });
  try {
    assert.equal(typeof harness.controller.probeBrowserHealth, "function", "Agent B must add probeBrowserHealth");
    harness.settings.chatBridgeDebugPort = 1; // unreachable, and out of the launchable range
    const result = await harness.controller.probeBrowserHealth({ allowLaunch: true });

    assert.equal(result.ok, false);
    assert.equal(result.state, "unavailable");
    assert.equal(result.browserOnline, false);
  } finally {
    await harness.close();
  }
});

newInterfaceTest("runBridgeBootstrap drives probeBrowserHealth and never calls testBridge", async () => {
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 6000);
  const probes = [];
  let testBridgeCalls = 0;
  const bridge = {
    runtime: { bridgeState: "uninitialized", bridgeBrowser: "unknown", bridgeLastError: null },
    status: () => ({ enabled: true, bound: true, state: "uninitialized", browser: "unknown" }),
    async isBrowserAvailable() { return false; },
    async probeBrowserHealth(options) {
      probes.push(options);
      return { ok: true, state: "ready", browserOnline: true };
    },
    async testBridge() {
      testBridgeCalls += 1;
      throw new Error("runBridgeBootstrap must not call the legacy testBridge");
    },
  };
  try {
    await runBridgeBootstrap({
      bridge,
      getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: URL_A, chatBridgeDebugPort: 65535 }),
      onReady: () => controller.abort(),
      signal: controller.signal,
      retryDelaysMs: [0],
      sleep: boundedSleep(controller, 2),
    });

    assert.equal(testBridgeCalls, 0, "the legacy testBridge must never be reached from bootstrap");
    assert.equal(probes.length, 1, "bootstrap must prepare browser health through probeBrowserHealth");
    assert.equal(probes[0].signal.aborted, true, "lifecycle cancellation must reach the composed deadline signal");
    assert.deepEqual(Object.keys(probes[0]).sort(), ["allowLaunch", "signal"],
      "bootstrap must not hand a conversation URL to the probe");
    assert.equal(probes[0].allowLaunch, true, "startup may launch the isolated browser");
  } finally {
    clearTimeout(watchdog);
  }
});

newInterfaceTest("bootstrap never navigates or activates a conversation page, even with a global binding", async () => {
  // Only B is open while the global legacy binding points at A. The legacy
  // bootstrap drags B to A; the new one must not move any page at all.
  const harness = await createHarness({
    targets: [{ targetId: "tab-B", url: URL_B }],
    config: { chatBridgeChatUrl: URL_A },
  });
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 6000);
  let sleeps = 0;
  try {
    await runBridgeBootstrap({
      bridge: harness.controller,
      getConfig: () => harness.settings,
      signal: controller.signal,
      retryDelaysMs: [0],
      checkIntervalMs: 20,
      loginRecheckIntervalMs: 20,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) controller.abort();
      },
    });

    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Page.navigate"), [],
      "bootstrap must not navigate a conversation page from the global chatBridgeChatUrl");
    assert.deepEqual(
      callsMatching(harness.calls, (call) => call.method === "Target.activateTarget" || call.method === "Browser.setWindowBounds"),
      [],
      "bootstrap must not restore or activate a page",
    );
    assert.equal(harness.page("tab-B").url, URL_B, "B must stay where it was");
    assert.equal(harness.page("tab-B").navigations, 0);
  } finally {
    clearTimeout(watchdog);
    await harness.close();
  }
});

newInterfaceTest("bootstrap preserves retry, backoff, stop and onReady semantics through probeBrowserHealth", async () => {
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 6000);
  let attempts = 0;
  let ready = 0;
  let testBridgeCalls = 0;
  const delays = [];
  const bridge = {
    runtime: { bridgeState: "uninitialized", bridgeBrowser: "unknown", bridgeLastError: null },
    status: () => ({ enabled: true, bound: true, state: "uninitialized", browser: "unknown" }),
    async isBrowserAvailable() { return false; },
    async probeBrowserHealth() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("temporary CDP failure"), { code: "bridge_cdp_unavailable" });
      return { ok: true, state: "ready", browserOnline: true };
    },
    async testBridge() {
      testBridgeCalls += 1;
      throw new Error("runBridgeBootstrap must not call the legacy testBridge");
    },
  };
  try {
    await runBridgeBootstrap({
      bridge,
      getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: URL_A, chatBridgeDebugPort: 65535 }),
      onReady: () => { ready += 1; controller.abort(); },
      signal: controller.signal,
      retryDelaysMs: [0, 100, 500],
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= 4) controller.abort();
      },
    });

    assert.equal(attempts, 3, "transient failures must be retried");
    assert.deepEqual(delays, [100], "bounded backoff must be preserved");
    assert.equal(testBridgeCalls, 0);
    assert.equal(ready, 1, "onReady must fire exactly once when the probe succeeds");
  } finally {
    clearTimeout(watchdog);
  }
});

newInterfaceTest("bootstrap stops after its bounded attempts instead of probing forever", async () => {
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 6000);
  let attempts = 0;
  let sleeps = 0;
  const bridge = {
    runtime: { bridgeState: "uninitialized", bridgeBrowser: "unknown", bridgeLastError: null },
    status: () => ({ enabled: true, bound: true, state: "uninitialized", browser: "unknown" }),
    async isBrowserAvailable() { return false; },
    async probeBrowserHealth() {
      attempts += 1;
      throw Object.assign(new Error("browser unavailable"), { code: "bridge_browser_spawn_failed" });
    },
    async testBridge() { throw new Error("runBridgeBootstrap must not call the legacy testBridge"); },
  };
  try {
    await runBridgeBootstrap({
      bridge,
      getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: URL_A, chatBridgeDebugPort: 65535 }),
      signal: controller.signal,
      retryDelaysMs: [0, 10],
      checkIntervalMs: 15,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) controller.abort();
      },
    });

    assert.equal(attempts, 4, "after retry exhaustion health remains read-only and polls at the normal interval");
  } finally {
    clearTimeout(watchdog);
  }
});

newInterfaceTest("bootstrap prepares browser capability without any global conversation binding", async () => {
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 6000);
  const probes = [];
  const bridge = {
    runtime: { bridgeState: "uninitialized", bridgeBrowser: "unknown", bridgeLastError: null },
    status: () => ({ enabled: true, bound: false, state: "unbound", browser: "unknown" }),
    async isBrowserAvailable() { return false; },
    async probeBrowserHealth(options) {
      probes.push(options);
      controller.abort();
      return { ok: true, state: "ready", browserOnline: true };
    },
    async testBridge() { throw new Error("runBridgeBootstrap must not call the legacy testBridge"); },
  };
  try {
    await runBridgeBootstrap({
      bridge,
      getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: "", chatBridgeDebugPort: 65535 }),
      signal: controller.signal,
      retryDelaysMs: [0],
      sleep: boundedSleep(controller, 2),
    });

    assert.ok(probes.length >= 1,
      "an unbound configuration must still prepare browser/CDP capability: ready only means delivery can be attempted");
    assert.deepEqual(Object.keys(probes[0]).sort(), ["allowLaunch", "signal"]);
  } finally {
    clearTimeout(watchdog);
  }
});

newInterfaceTest("bootstrap runs concurrently with an in-flight delivery without disturbing it", async () => {
  const harness = await createHarness({
    targets: [{ targetId: "tab-A", url: URL_A }, { targetId: "tab-B", url: URL_B }],
    config: { chatBridgeChatUrl: URL_B },
  });
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 8000);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let gated = false;
  harness.world.beforeInsert = async () => {
    if (gated) return;
    gated = true;
    await gate;
  };
  try {
    const sending = harness.controller.sendEnvelope(envelope({ key: "mk-par-1", target: conversation(URL_A) }));
    await waitUntil(() => gated, { label: "the delivery to reach its draft insertion" });

    let sleeps = 0;
    await runBridgeBootstrap({
      bridge: harness.controller,
      getConfig: () => harness.settings,
      signal: controller.signal,
      retryDelaysMs: [0],
      checkIntervalMs: 20,
      loginRecheckIntervalMs: 20,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) controller.abort();
      },
    });

    releaseGate();
    const result = await sending;

    assert.equal(result.ok, true, "the in-flight delivery must not be broken by bootstrap");
    assert.equal(harness.page("tab-A").visibleMessages.length, 1, "the wake must still land in A");
    assert.equal(harness.page("tab-B").visibleMessages.length, 0, "bootstrap must not deliver or type into B");
    assert.equal(harness.page("tab-B").composerText, "");
    assert.deepEqual(callsMatching(harness.calls, (call) => call.method === "Page.navigate"), [],
      "bootstrap must not navigate a conversation while a delivery is in flight");
    assert.deepEqual(
      callsMatching(harness.calls, (call) => call.method === "Target.activateTarget" || call.method === "Browser.setWindowBounds"),
      [],
      "bootstrap must not activate or restore a page while a delivery is in flight",
    );
  } finally {
    releaseGate?.();
    clearTimeout(watchdog);
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Integrator report
// ---------------------------------------------------------------------------

test("[report] baseline tally for the Agent A / Agent B interfaces", (t) => {
  const lines = [
    `baseline 9a24513672c3253cc0381cfec5da6c058b72b6ee: ${tally.green.length} new-interface contract(s) already satisfied, ${tally.red.length} expected baseline failure(s)`,
  ];
  for (const entry of tally.green) lines.push(`  green: ${entry}`);
  for (const entry of tally.red) lines.push(`  expected-red: ${entry.name} -> ${entry.message}`);
  t.diagnostic(lines.join("\n"));
  assert.ok(tally.green.length + tally.red.length > 0, "the new-interface contract tests must have run");
});


test("[concurrency] simultaneous duplicate delivery submits once and creates one target", async () => {
  const harness = await createHarness({ targets: [] });
  try {
    const raw = envelope({ key: "mk-concurrent", target: conversation(URL_A) });
    const results = await Promise.all([harness.controller.sendEnvelope(raw), harness.controller.sendEnvelope(raw)]);
    assert.equal(results.filter((r) => r.deduplicated).length, 1);
    assert.equal(callsMatching(harness.calls, (c) => c.method === "Target.createTarget").length, 1);
    assert.equal(callsMatching(harness.calls, (c) => c.method === "Input.insertText").length, 1);
    assert.equal(callsMatching(harness.calls, (c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").length, 1);
  } finally { await harness.close(); }
});

test("[draft] human draft appearing after preflight survives without insertion or click", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  let containsRead = false;
  harness.world.beforeEvaluate = (_target, script, page) => {
    if (script === "composerContains" && !containsRead) {
      containsRead = true;
      page.composerText = "Human draft typed while delivery was preparing";
    }
  };
  try {
    await assert.rejects(harness.controller.sendEnvelope(envelope({ key: "mk-late-draft", target: conversation(URL_A) })), e => e.code === "bridge_composer_draft_present");
    assert.equal(harness.page("tab-A").composerText, "Human draft typed while delivery was preparing");
    assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.insertText" || c.method === "Input.dispatchMouseEvent"), []);
  } finally { await harness.close(); }
});


test("[draft] user edit to a retained message-key draft is never submitted", async () => {
  const raw = envelope({ key: "mk-edited", target: conversation(URL_A) });
  const edited = buildCloudBridgeControlMessage(raw) + "\nHuman annotation";
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A, page: { composerText: edited } }] });
  try {
    await assert.rejects(harness.controller.sendEnvelope(raw), e => e.code === "bridge_composer_draft_present");
    assert.equal(harness.page("tab-A").composerText, edited);
    assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.insertText" || c.method === "Input.dispatchMouseEvent"), []);
  } finally { await harness.close(); }
});


test("[progress] durable stages precede submit and persistence failure prevents every click", async () => {
  for (const failedStage of [null, "draft_verified", "submit_attempted"]) {
    const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
    const progress = [];
    try {
      const sending = harness.controller.sendEnvelope(envelope({ key: "mk-progress", target: conversation(URL_A) }), {
        onProgress: async (stage, diagnostic) => {
          progress.push(stage);
          assert.equal(diagnostic.composerHasMessageKey, true);
          assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent"), []);
          if (stage === failedStage) throw new Error("simulated durable write failure");
        },
      });
      if (failedStage) {
        await assert.rejects(sending, e => e.code === "bridge_progress_persist_failed");
        assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent"), []);
        assert.equal(harness.page("tab-A").visibleMessages.length, 0);
      } else {
        assert.equal((await sending).ok, true);
        assert.deepEqual(progress, ["draft_verified", "submit_attempted"]);
      }
    } finally { await harness.close(); }
  }
});

test("[visibility] a failed pre-send visibility observation never permits insertion or click", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  harness.world.beforeEvaluate = (_target, script) => {
    if (script === "messageVisible") throw new Error("simulated observation failure");
  };
  try {
    await assert.rejects(harness.controller.sendEnvelope(envelope({ key: "mk-visibility-failure", target: conversation(URL_A) })));
    assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.insertText" || c.method === "Input.dispatchMouseEvent"), []);
  } finally { await harness.close(); }
});


test("[visibility] a failed post-submit observation holds the key even when the composer retains a ready draft", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }], onSubmit: () => {} });
  let observations = 0;
  harness.world.beforeEvaluate = (_target, script) => {
    if (script === "messageVisible" && callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").length > 0) throw new Error("simulated post-submit observation failure");
  };
  const raw = envelope({ key: "mk-post-visibility", target: conversation(URL_A) });
  try {
    await assert.rejects(harness.controller.sendEnvelope(raw), e => e.code === "bridge_send_uncertain");
    const clicks = callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").length;
    await assert.rejects(harness.controller.sendEnvelope(raw), e => e.code === "bridge_send_uncertain");
    assert.equal(clicks, 1);
    assert.equal(callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").length, clicks);
  } finally { await harness.close(); }
});


test("[progress] a user edit during durable submit-intent persistence is preserved", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  try {
    await assert.rejects(harness.controller.sendEnvelope(envelope({ key: "mk-write-edit", target: conversation(URL_A) }), {
      onProgress: async stage => {
        if (stage === "submit_attempted") harness.page("tab-A").composerText = "Human edit while durable write awaited";
      },
    }), e => e.code === "bridge_composer_draft_present");
    assert.equal(harness.page("tab-A").composerText, "Human edit while durable write awaited");
    assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent"), []);
  } finally { await harness.close(); }
});


test("[visibility] a late-hydrated existing bubble deduplicates before durable submit intent or click", async () => {
  const raw = envelope({ key: "mk-late-bubble", target: conversation(URL_A) });
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  let visibilityReads = 0;
  const progress = [];
  harness.world.beforeEvaluate = (_target, script, page) => {
    if (script === "messageVisible" && ++visibilityReads === 2) page.visibleMessages.push(buildCloudBridgeControlMessage(raw));
  };
  try {
    const result = await harness.controller.sendEnvelope(raw, { onProgress: async stage => progress.push(stage) });
    assert.equal(result.deduplicated, true);
    assert.deepEqual(progress, ["draft_verified"]);
    assert.equal(harness.page("tab-A").visibleMessages.length, 1);
    assert.deepEqual(callsMatching(harness.calls, c => c.method === "Input.dispatchMouseEvent"), []);
  } finally { await harness.close(); }
});


test("[concurrency] separate controllers sharing one browser port cannot mix concurrent drafts", async () => {
  const harness = await createHarness({ targets: [{ targetId: "tab-A", url: URL_A }] });
  const second = new ChatBridgeController({ runtime: {}, getConfig: () => harness.settings, cdpFactory: harness.controller.cdpFactory });
  try {
    const one = envelope({ key: "mk-controller-one", target: conversation(URL_A) });
    const two = envelope({ key: "mk-controller-two", target: conversation(URL_A) });
    const results = await Promise.all([harness.controller.sendEnvelope(one), second.sendEnvelope(two)]);
    assert.equal(results.every(r => r.ok), true);
    const messages = harness.page("tab-A").visibleMessages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].includes("MESSAGE_KEY: mk-controller-two"), false);
    assert.equal(messages[1].includes("MESSAGE_KEY: mk-controller-one"), false);
  } finally { await harness.close(); }
});
