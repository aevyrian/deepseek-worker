import { setTimeout as delay, setImmediate as yieldToLoop } from "node:timers/promises";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 1_000, 5_000]);
const DEFAULT_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_LOGIN_RECHECK_INTERVAL_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

const HEALTH_STATES = Object.freeze(["ready", "needs-login", "unavailable"]);

/**
 * Resolve the bootstrap gate from configuration alone.
 *
 * Deliberately independent of `chatBridgeChatUrl`: browser/CDP reachability is a
 * transport-level fact, not a property of the bound conversation. Navigation to
 * the bound conversation is owned by `sendMessage`, which strictly validates the
 * target composer before delivery.
 */
function configuration(config) {
  if (config?.chatBridgeEnabled === false) return { kind: "disabled", key: "disabled" };
  const rawPort = config?.chatBridgeDebugPort ?? 9223;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { kind: "invalid-config", key: `invalid-port|${String(rawPort)}` };
  }
  return { kind: "bound", key: `cdp|${port}` };
}

async function wait(ms, signal, sleep) {
  if (signal.aborted) return false;
  try {
    await sleep(ms, undefined, { signal });
    return !signal.aborted;
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") return false;
    throw error;
  }
}

/**
 * Normalize the controller health probe into a closed shape.
 *
 * `ready` means only that the browser/CDP capability is usable for *attempting*
 * delivery. It never means the target composer is validated, and it never means
 * a user is logged in: an unconfirmed login must not be reported as logged in.
 */
function normalizeHealth(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, state: "unavailable", browserOnline: false };
  }
  const browserOnline = raw.browserOnline === true;
  let state = HEALTH_STATES.includes(raw.state) ? raw.state : null;
  if (!state) state = raw.ok === true && browserOnline ? "ready" : "unavailable";
  // A probe cannot assert readiness without an online browser.
  if (state === "ready" && !browserOnline) state = "unavailable";
  return { ok: raw.ok === true && state === "ready", state, browserOnline };
}

/**
 * Call the controller health probe without ever touching a conversation page.
 *
 * The probe contract forbids `Page.navigate`, focus, `restoreAndActivate`,
 * `Input`, and `Target.createTarget` against session pages; only the browser's
 * first-launch default home page is permitted. We additionally bound each call
 * so a wedged CDP socket cannot stall the loop.
 */
async function probeHealth({ bridge, signal, allowLaunch, timeoutMs }) {
  const timeoutController = new AbortController();
  const probeSignal = AbortSignal.any([signal, timeoutController.signal]);
  let timer;
  let abortListener;
  let timedOut = false;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(probeSignal.reason || new Error("Chat Bridge health probe interrupted."));
    probeSignal.addEventListener("abort", abortListener, { once: true });
    if (probeSignal.aborted) abortListener();
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new Error("Chat Bridge health probe timed out."));
      }, timeoutMs);
    }
  });
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => bridge.probeBrowserHealth({ allowLaunch, signal: probeSignal })),
      interrupted,
    ]);
    if (signal.aborted) return { aborted: true };
    return normalizeHealth(raw);
  } catch (error) {
    if (signal.aborted) return { aborted: true };
    if (timedOut) return { ok: false, state: "unavailable", browserOnline: false, timedOut: true };
    return { ok: false, state: "unavailable", browserOnline: false, error, code: error?.code };
  } finally {
    clearTimeout(timer);
    probeSignal.removeEventListener("abort", abortListener);
    timeoutController.abort();
  }
}

/**
 * Independently boot and monitor the Chat Bridge transport without blocking
 * Worker startup.
 *
 * Isolation guarantees:
 *  - Health is probed through `probeBrowserHealth`, never through `testBridge`.
 *    The legacy `testBridge` navigates and focuses the globally bound
 *    conversation tab, which must not happen on a timer.
 *  - The probe never depends on `chatBridgeChatUrl`; an unbound configuration
 *    still brings the browser online.
 *  - `onReady` fires only on a transition into the ready state, so a healthy
 *    steady state does not re-trigger callbacks or navigation every interval.
 *  - Browser launches stay bounded: at most one launch per outage cycle, and
 *    never while the browser is open but sitting on a login page.
 */
export async function runBridgeBootstrap({
  bridge,
  getConfig,
  onReady,
  logger,
  signal,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  loginRecheckIntervalMs = DEFAULT_LOGIN_RECHECK_INTERVAL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  sleep = delay,
} = {}) {
  if (!bridge || typeof bridge.probeBrowserHealth !== "function" || typeof getConfig !== "function" || !signal) {
    throw new Error("Bridge bootstrap requires a controller exposing probeBrowserHealth, a config reader, and an abort signal");
  }

  let configKey = null;
  let attempts = 0;
  let exhausted = false;
  let wasBrowserOnline = false;
  let launchUsed = false;
  let readyNotified = false;
  let notedState = null;

  const noteState = (state, message) => {
    if (notedState === state) return;
    notedState = state;
    logger?.warn?.(message);
  };

  while (!signal.aborted) {
    let config;
    try {
      config = getConfig();
    } catch {
      bridge.runtime.bridgeHealthState = "error";
      bridge.runtime.bridgeHealthLastError = "Chat Bridge configuration could not be read.";
      logger?.warn?.("deepseek-worker Chat Bridge bootstrap: configuration unavailable");
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    const target = configuration(config);
    if (target.key !== configKey) {
      configKey = target.key;
      attempts = 0;
      exhausted = false;
      launchUsed = false;
      notedState = null;
    }

    // Disabled or unparseable transport configuration: never launch a browser.
    if (target.kind !== "bound") {
      bridge.runtime.bridgeHealthState = target.kind;
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    // One launch is permitted per outage cycle: while the browser was offline in
    // the previous iteration we may start it, otherwise we only reuse. The first
    // probe of a cycle runs immediately; retries are spaced by the backoff applied
    // at the end of this loop body.
    const allowLaunch = !wasBrowserOnline && !launchUsed;
    if (allowLaunch) launchUsed = true;
    const health = await probeHealth({ bridge, signal, allowLaunch, timeoutMs: probeTimeoutMs });
    if (health.aborted || signal.aborted) break;

    const browserOnline = health.browserOnline;

    if (wasBrowserOnline && !browserOnline) {
      // A real browser-close transition starts one new bounded recovery cycle.
      launchUsed = false;
      attempts = 0;
      exhausted = false;
      if (bridge.runtime.bridgeHealthState === "ready" || bridge.runtime.bridgeHealthState === "sent") {
        bridge.runtime.bridgeHealthState = "error";
        bridge.runtime.bridgeHealthLastError = "Chat Bridge browser disconnected.";
      }
    } else if (!wasBrowserOnline && browserOnline) {
      // A manually reopened browser can recover a previously exhausted cycle.
      attempts = 0;
      exhausted = false;
    }
    wasBrowserOnline = browserOnline;

    if (health.state === "needs-login") {
      // Login is a user action. Keep the open browser, never relaunch it while it
      // sits on the login page, and never assert readiness or login on its behalf.
      bridge.runtime.bridgeHealthState = "needs-login";
      bridge.runtime.bridgeHealthLastError = "Chat Bridge browser requires an interactive ChatGPT login.";
      readyNotified = false;
      noteState("needs-login", "deepseek-worker Chat Bridge bootstrap: browser is waiting for an interactive login");
      const interval = browserOnline ? loginRecheckIntervalMs : checkIntervalMs;
      if (!await wait(interval, signal, sleep)) break;
      continue;
    }

    if (health.state === "ready") {
      attempts = 0;
      exhausted = false;
      bridge.runtime.bridgeHealthState = "ready";
      bridge.runtime.bridgeHealthLastError = null;
      notedState = "ready";
      // The Outbox can contain explicit wake targets without a global binding.
      if (!readyNotified) {
        readyNotified = true;
        await onReady?.();
        if (signal.aborted) break;
      }
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    // Unavailable: the browser/CDP capability is not usable yet.
    readyNotified = false;
    if (bridge.runtime.bridgeHealthState !== "sent") {
      bridge.runtime.bridgeHealthState = "error";
      if (health.timedOut) {
        bridge.runtime.bridgeHealthLastError = "Chat Bridge health probe timed out.";
      } else if (health.code) {
        bridge.runtime.bridgeHealthLastError = `Chat Bridge health probe failed: ${health.code}`;
      } else {
        bridge.runtime.bridgeHealthLastError = "Chat Bridge browser is unavailable.";
      }
    }
    noteState("unavailable", "deepseek-worker Chat Bridge bootstrap: browser/CDP is not available yet");

    // Bounded launch attempts. The first probe of an outage cycle ran
    // immediately; every retry waits the configured backoff first. Once the
    // configured attempts are spent, the browser is only re-probed at
    // checkIntervalMs, so a persistent outage can never reopen windows in a
    // tight loop.
    if (exhausted) {
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }
    const backoffMs = retryDelaysMs[attempts];
    if (backoffMs > 0) {
      if (!await wait(backoffMs, signal, sleep)) break;
    } else {
      // A 0ms step is not routed through sleep, but it must still yield so a
      // fast-failing probe cannot spin the event loop.
      await yieldToLoop();
      if (signal.aborted) break;
    }
    attempts += 1;
    if (attempts >= retryDelaysMs.length) exhausted = true;
  }
}
