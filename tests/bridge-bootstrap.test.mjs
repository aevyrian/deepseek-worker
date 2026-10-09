import assert from "node:assert/strict";
import test from "node:test";

import { runBridgeBootstrap } from "../lib/bridge-bootstrap.mjs";

const BOUND_URL = "https://chatgpt.com/c/bound-conversation";

function ready(browserOnline = true) {
  return { ok: true, state: browserOnline ? "ready" : "unavailable", browserOnline };
}

function needsLogin(browserOnline = true) {
  return { ok: false, state: "needs-login", browserOnline };
}

function unavailable() {
  return { ok: false, state: "unavailable", browserOnline: false };
}

/**
 * Stand-in for ChatBridgeController.
 *
 * `probeBrowserHealth` follows the Agent B contract: it may ensure/reuse the CDP
 * browser but must never navigate, focus, activate, or create a session target.
 * The harness therefore records any navigation attempt and asserts it stays zero.
 */
function fakeBridge({ state = "uninitialized", browser = "unknown", config = {} } = {}) {
  const runtime = { bridgeState: state, bridgeBrowser: browser, bridgeLastError: null };
  const settings = { chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL, chatBridgeDebugPort: 9223, ...config };
  let browserOnline = browser === "online";
  const calls = [];
  // Every forbidden side effect a legacy bootstrap could trigger.
  const navigation = [];
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
    async probeBrowserHealth(options = {}) {
      // Capture the signal state at call time: a later abort (shutdown, or the
      // test's own teardown) must not rewrite what the probe was handed.
      calls.push({ ...options, abortedAtCall: options.signal?.aborted === true });
      runtime.bridgeBrowser = browserOnline ? "online" : "unavailable";
      if (typeof settings.probeBrowserHealth === "function") {
        return settings.probeBrowserHealth({ options, runtime, calls, setBrowserOnline, navigation });
      }
      // Mirrors the real contract: a probe that is allowed to launch brings the
      // browser online, and an online browser reports a usable CDP capability.
      if (!browserOnline && options.allowLaunch !== false) browserOnline = true;
      runtime.bridgeBrowser = browserOnline ? "online" : "unavailable";
      if (!browserOnline) return unavailable();
      runtime.bridgeState = "ready";
      return ready(true);
    },
    // Legacy entry point. Bootstrap must not reach for it; calling it records the
    // bound-conversation navigation it performs so the test can prove isolation.
    async testBridge() {
      navigation.push("testBridge:navigate-bound-conversation");
      throw new Error("bootstrap must not call testBridge");
    },
    async isBrowserAvailable() {
      return browserOnline;
    },
  };
  function setBrowserOnline(value) {
    browserOnline = value;
    runtime.bridgeBrowser = value ? "online" : "unavailable";
  }
  return { bridge, runtime, settings, calls, navigation, setBrowserOnline };
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

test("startup bootstrap probes browser health, then wakes the durable transport once", async () => {
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
  assert.equal(fake.calls[0].abortedAtCall, false, "lifecycle cancellation reaches the health probe");
  assert.equal(fake.calls[0].allowLaunch, true, "the first probe of an outage cycle may launch the browser");
  assert.equal(fake.runtime.bridgeState, "ready");
  assert.equal(kicks, 1);
  assert.deepEqual(fake.navigation, [], "bootstrap must not navigate the bound conversation");
});

test("bootstrap never calls the legacy testBridge and never navigates a bound chat tab", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "ready", browser: "online" });
  const { sleep } = abortingSleep(controller, 3);
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 25,
    sleep,
  });
  assert.equal(fake.calls.length, 3, "health is re-probed on the interval");
  assert.equal(kicks, 1, "a healthy browser wakes the transport once, not on every poll");
  assert.deepEqual(fake.navigation, [], "no legacy navigation happened on any probe");
});

test("a steady ready browser does not re-trigger onReady on every interval", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "ready", browser: "online" });
  const { sleep, delays } = abortingSleep(controller, 4);
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0],
    checkIntervalMs: 25,
    sleep,
  });
  assert.equal(fake.calls.length, 4, "the loop kept polling health");
  assert.deepEqual(delays, [25, 25, 25, 25]);
  assert.equal(kicks, 1, "onReady fired exactly once across four healthy polls");
});

test("browser online probing does not depend on chatBridgeChatUrl", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ config: { chatBridgeChatUrl: "" } });
  const { sleep, delays } = abortingSleep(controller, 1);
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    // The wake kick is a latency signal for the durable transport, not a
    // delivery. A `wake_target` delivery is self-describing, so an unbound
    // global configuration must still be able to wake the transport the moment
    // the browser becomes usable; `sendMessage` stays the fail-closed gate.
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0],
    sleep,
  });
  assert.equal(fake.calls.length, 1, "the browser is still brought online without a bound chat URL");
  assert.equal(fake.calls[0].allowLaunch, true);
  assert.equal(fake.runtime.bridgeState, "ready");
  assert.equal(kicks, 1, "a wake_target-only deployment still wakes the durable transport once");
  assert.deepEqual(fake.navigation, [], "no fallback navigation to a global chat URL");
});

test("an unbound ready browser wakes the transport once per transition, not once per interval", async () => {
  // Integration regression: Agent A gated onReady on `status().bound`, which is
  // derived solely from the legacy global `chatBridgeChatUrl`. Combined with
  // Agent B's self-describing `wake_target` deliveries, that silenced the ready
  // signal for exactly the multi-conversation deployments this work targets.
  const controller = new AbortController();
  const fake = fakeBridge({ state: "ready", browser: "online", config: { chatBridgeChatUrl: "" } });
  const { sleep, delays } = abortingSleep(controller, 4);
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0],
    checkIntervalMs: 25,
    sleep,
  });
  assert.equal(fake.settings.chatBridgeChatUrl, "", "the deployment has no legacy global conversation");
  assert.ok(delays.length >= 2, "the steady ready state must keep polling");
  assert.equal(kicks, 1, "an unbound steady ready state wakes the transport exactly once");
});

test("disabled and invalid-port configurations do not launch a browser", async () => {
  for (const config of [
    { chatBridgeEnabled: false, chatBridgeChatUrl: BOUND_URL },
    { chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL, chatBridgeDebugPort: 80 },
    { chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL, chatBridgeDebugPort: "not-a-port" },
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
    assert.equal(fake.calls.length, 0, `probe must not run for ${JSON.stringify(config)}`);
  }
});

test("startup retries a transient failure with bounded backoff then recovers", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fake = fakeBridge({ config: {
    probeBrowserHealth: ({ setBrowserOnline, runtime }) => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("temporary CDP failure"), { code: "bridge_cdp_unavailable" });
      setBrowserOnline(true);
      runtime.bridgeState = "ready";
      return ready(true);
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
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 500], "retry probes are spaced by the configured backoff");
});

test("failed startup stops after its configured attempts instead of reopening windows forever", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fake = fakeBridge({ config: {
    probeBrowserHealth: () => {
      attempts += 1;
      throw Object.assign(new Error("browser unavailable"), { code: "bridge_browser_spawn_failed" });
    },
  } });
  const { sleep, delays } = abortingSleep(controller, 2);
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 100,
    sleep,
  });
  // One immediate probe plus one per backoff entry, then the terminal poll.
  assert.equal(attempts, 3, "launch attempts stay bounded by retryDelaysMs");
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(delays, [10, 100]);
});

test("a closed Bridge browser gets one new bounded recovery cycle", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "ready", browser: "online" });
  const { sleep, delays } = abortingSleep(controller, 2, (count) => {
    if (count === 1) fake.setBrowserOnline(false);
  });
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 25,
    sleep,
  });
  assert.equal(fake.calls.length, 3, "ready poll, disconnected poll, then one recovery probe");
  assert.deepEqual(
    fake.calls.map((call) => call.allowLaunch),
    [true, false, true],
    "a running browser is reused without launching, and the outage gets one relaunch",
  );
  assert.deepEqual(delays, [25, 25]);
  assert.equal(kicks, 2, "the initial readiness and the recovery both wake the transport");
  assert.deepEqual(fake.navigation, []);
});

test("login recovery reuses the open browser and never launches another", async () => {
  const controller = new AbortController();
  const fake = fakeBridge({ state: "needs-login", browser: "online", config: {
    probeBrowserHealth: () => needsLogin(true),
  } });
  const { sleep } = abortingSleep(controller, 1);
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { throw new Error("needs-login must not be reported as ready"); },
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    loginRecheckIntervalMs: 60,
    sleep,
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].allowLaunch, true, "the first probe may open the browser for the user to log into");
  assert.equal(fake.calls[0].abortedAtCall, false);
  assert.equal(fake.runtime.bridgeState, "needs-login");
  assert.deepEqual(fake.navigation, [], "login recovery must not navigate or focus a conversation tab");
});

test("a login wait does not assume the user is authenticated and keeps the browser open", async () => {
  const controller = new AbortController();
  let probes = 0;
  const fake = fakeBridge({ state: "needs-login", browser: "online", config: {
    probeBrowserHealth: () => {
      probes += 1;
      // The user logs in between the second and third probe.
      return probes < 3 ? needsLogin(true) : ready(true);
    },
  } });
  const { sleep, delays } = abortingSleep(controller, 4);
  let kicks = 0;
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => { kicks += 1; },
    signal: controller.signal,
    retryDelaysMs: [0, 10],
    checkIntervalMs: 25,
    loginRecheckIntervalMs: 60,
    sleep,
  });
  assert.equal(probes, 4);
  assert.deepEqual(delays, [60, 60, 25, 25], "login rechecks use the login interval, not the CDP retry backoff");
  assert.equal(kicks, 1, "the transport is woken once the user finishes logging in");
  assert.deepEqual(fake.navigation, []);
});

test("shutdown aborts an in-flight health probe without waiting for the poll interval", async () => {
  const controller = new AbortController();
  let probeStarted = false;
  const fake = fakeBridge({ config: {
    probeBrowserHealth: ({ options }) => new Promise((resolve, reject) => {
      probeStarted = true;
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
  assert.equal(probeStarted, true);
  controller.abort(new Error("shutdown"));
  await run;
  assert.equal(fake.runtime.bridgeState, "uninitialized");
});

test("a wedged probe is bounded by probeTimeoutMs instead of stalling the loop", async () => {
  const controller = new AbortController();
  let probes = 0;
  const fake = fakeBridge({ config: {
    probeBrowserHealth: ({ options }) => new Promise((resolve, reject) => {
      probes += 1;
      if (probes === 1) {
        // Never settles on its own; only the bootstrap probe deadline can end it.
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        return;
      }
      resolve(ready(true));
    }),
  } });
  const { sleep, delays } = abortingSleep(controller, 2);
  await runBridgeBootstrap({
    bridge: fake.bridge,
    getConfig: () => fake.settings,
    onReady: () => controller.abort(),
    signal: controller.signal,
    retryDelaysMs: [5, 10],
    checkIntervalMs: 100,
    probeTimeoutMs: 20,
    sleep,
  });
  assert.equal(probes, 2, "the hung probe was abandoned and health was re-probed");
  assert.deepEqual(delays, [5], "the wedged probe did not block the retry backoff");
});

test("bootstrap refuses a controller without the probeBrowserHealth contract", async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => runBridgeBootstrap({
      bridge: { runtime: {}, status: () => ({ state: "uninitialized" }), testBridge: async () => {} },
      getConfig: () => ({ chatBridgeEnabled: true, chatBridgeChatUrl: BOUND_URL }),
      signal: controller.signal,
      sleep: async () => {},
    }),
    /probeBrowserHealth/,
  );
});
