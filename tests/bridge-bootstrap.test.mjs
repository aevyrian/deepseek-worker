import assert from "node:assert/strict";
import test from "node:test";

import { runBridgeBootstrap } from "../lib/bridge-bootstrap.mjs";

const BOUND_URL = "https://chatgpt.com/c/bound-conversation";

function fakeBridge({ state = "uninitialized", browser = "unknown", config = {} } = {}) {
  const runtime = { bridgeState: state, bridgeBrowser: browser, bridgeLastError: null };
  const settings = { chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL, chatBridgeDebugPort: 9223, ...config };
  let browserOnline = browser === "online";
  const calls = [];
  const bridge = {
    runtime,
    status() {
      return {
        enabled: settings.chatBridgeEnabled !== false,
        bound: Boolean(settings.chatBridgeChatUrl),
        state: runtime.bridgeState,
        browser: runtime.bridgeBrowser,
      };
    },
    async isBrowserAvailable() {
      runtime.bridgeBrowser = browserOnline ? "online" : "unavailable";
      return browserOnline;
    },
    async testBridge(options) {
      calls.push(options);
      if (typeof settings.testBridge === "function") return settings.testBridge({ options, runtime, calls, setBrowserOnline });
      browserOnline = true;
      runtime.bridgeBrowser = "online";
      runtime.bridgeState = "ready";
      return { ok: true };
    },
  };
  function setBrowserOnline(value) {
    browserOnline = value;
    runtime.bridgeBrowser = value ? "online" : "unavailable";
  }
  return { bridge, runtime, settings, calls, setBrowserOnline };
}

function abortingSleep(controller, after = 1, onSleep = null) {
  let count = 0;
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
    count += 1;
    await onSleep?.(count);
    if (count >= after) {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
  };
  return { sleep, delays };
}

test("startup bootstrap validates a configured conversation and wakes the durable transport", async () => {
  const controller = new AbortController();
  const fake = fakeBridge();
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; controller.abort(); },
    signal: controller.signal,
    retryDelaysMs: [0],
    sleep: async () => {},
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].signal, controller.signal, "lifecycle cancellation reaches bridge validation");
  assert.equal("allowLaunch" in fake.calls[0], false, "initial validation may launch the isolated browser");
  assert.equal(fake.runtime.bridgeState, "ready");
  assert.equal(kicks, 1);
});

test("disabled and unbound configurations do not launch a browser", async () => {
  for (const config of [
    { chatBridgeEnabled: false, chatBridgeChatUrl: BOUND_URL },
    { chatBridgeEnabled: true, chatBridgeChatUrl: "" },
    { chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL, chatBridgeDebugPort: 80 },
  ]) {
    const controller = new AbortController();
    const fake = fakeBridge({ config });
    const { sleep } = abortingSleep(controller);
    await runBridgeBootstrap({
      bridge: fake.bridge,
      getConfig: () => fake.settings,
      signal: controller.signal,
      sleep,
    });
    assert.equal(fake.calls.length, 0);
  }
});

test("startup retries a transient failure with bounded backoff then recovers", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fake = fakeBridge({ config: {
    testBridge: ({ runtime, setBrowserOnline }) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("temporary CDP failure"), { code: "bridge_cdp_unavailable" });
      setBrowserOnline(true);
      runtime.bridgeState = "ready";
      return { ok: true };
    },
  } });
  const delays = [];
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => controller.abort(),
    signal: controller.signal,
    retryDelaysMs: [0, 100, 500],
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 500]);
});

test("failed startup stops after its configured attempts instead of reopening windows forever", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fake = fakeBridge({ config: {
    testBridge: () => {
      attempts += 1;
      throw Object.assign(new Error("browser unavailable"), { code: "bridge_browser_spawn_failed" });
    },
  } });
  const { sleep } = abortingSleep(controller, 2);
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 100,
    sleep,
  });
  assert.equal(attempts, 2);
  assert.equal(fake.calls.length, 2);
});

test("a closed Bridge browser gets one new bounded recovery cycle", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "ready", browser: "online" });
  const { sleep, delays } = abortingSleep(controller, 2, (count) => {
    if (count === 1) fake.setBrowserOnline(false);
  });
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => controller.abort(),
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 25,
    sleep,
  });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(delays, [25]);
});

test("login recovery revalidates by reusing the open browser and does not launch another", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "needs-login", browser: "online", config: {
    testBridge: ({ options }) => {
      if (options?.allowLaunch === false) throw Object.assign(new Error("login required"), { code: "bridge_login_required" });
      throw new Error("should not launch");
    },
  } });
  const { sleep } = abortingSleep(controller, 2);
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    loginRecheckIntervalMs: 60,
    sleep,
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].allowLaunch, false);
  assert.equal(fake.calls[0].signal, controller.signal);
});

test("shutdown aborts an in-flight bridge validation without waiting for the poll interval", async () => {
  const controller = new AbortController();
  let validationStarted = false;
  const fake = fakeBridge({ config: {
    testBridge: ({ options }) => new Promise((resolve, reject) => {
      validationStarted = true;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  } });
  const run = runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    signal: controller.signal,
    retryDelaysMs: [0],
    sleep: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validationStarted, true);
  controller.abort(new Error("shutdown"));
  await run;
  assert.equal(fake.runtime.bridgeState, "uninitialized");
});
