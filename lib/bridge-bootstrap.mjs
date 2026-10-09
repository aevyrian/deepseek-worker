import { setTimeout as delay } from "node:timers/promises";
import { normalizeBridgeChatUrl } from "./chat-bridge.mjs";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 1_000, 5_000]);
const DEFAULT_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_LOGIN_RECHECK_INTERVAL_MS = 60_000;

function configuration(config) {
  if (config?.chatBridgeEnabled === false) return { kind: "disabled", key: "disabled" };
  try {
    const url = normalizeBridgeChatUrl(config?.chatBridgeChatUrl ?? "");
    if (!url) return { kind: "unbound", key: "unbound" };
    const port = Number(config?.chatBridgeDebugPort ?? 9223);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { kind: "invalid-config", key: `invalid-port|${String(config?.chatBridgeDebugPort ?? "")}` };
    }
    return { kind: "bound", key: `${url}|${port}` };
  } catch {
    return { kind: "invalid", key: `invalid|${String(config?.chatBridgeDebugPort ?? "")}` };
  }
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
 * Independently boot and monitor Chat Bridge without blocking Worker startup.
 * Browser launches are bounded per configuration/outage; an already-running
 * browser is revalidated without launching a second window.
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
  sleep = delay,
} = {}) {
  if (!bridge || typeof bridge.testBridge !== "function" || typeof getConfig !== "function" || !signal) {
    throw new Error("Bridge bootstrap requires a controller, config reader, and abort signal");
  }

  let configKey = null;
  let attempts = 0;
  let exhausted = false;
  let wasBrowserOnline = false;

  while (!signal.aborted) {
    let config;
    try {
      config = getConfig();
    } catch (error) {
      bridge.runtime.bridgeState = "error";
      bridge.runtime.bridgeLastError = "Chat Bridge configuration could not be read.";
      logger?.warn?.("deepseek-worker Chat Bridge bootstrap: configuration unavailable");
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    const target = configuration(config);
    if (target.key !== configKey) {
      configKey = target.key;
      attempts = 0;
      exhausted = false;
    }

    if (target.kind !== "bound") {
      bridge.runtime.bridgeState = target.kind === "unbound" ? "unbound" : target.kind;
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    const status = bridge.status();
    let browserOnline = false;
    try {
      browserOnline = await bridge.isBrowserAvailable({ signal });
    } catch {}

    if (wasBrowserOnline && !browserOnline) {
      // A real browser-close transition starts one new bounded recovery cycle.
      attempts = 0;
      exhausted = false;
      if (bridge.runtime.bridgeState === "ready" || bridge.runtime.bridgeState === "sent") {
        bridge.runtime.bridgeState = "error";
        bridge.runtime.bridgeLastError = "Chat Bridge browser disconnected.";
      }
    } else if (!wasBrowserOnline && browserOnline) {
      // A manually reopened browser can recover a previously exhausted cycle.
      attempts = 0;
      exhausted = false;
    }
    wasBrowserOnline = browserOnline;

    if (status.state === "needs-login" && browserOnline) {
      if (!await wait(loginRecheckIntervalMs, signal, sleep)) break;
      try {
        await bridge.testBridge({ allowLaunch: false, signal });
        if (signal.aborted) break;
        attempts = 0;
        exhausted = false;
        await onReady?.();
      } catch (error) {
        if (signal.aborted) break;
        if (error?.code !== "bridge_login_required") {
          logger?.warn?.("deepseek-worker Chat Bridge validation failed; browser reuse will be retried");
        }
      }
      continue;
    }

    if ((status.state === "ready" || status.state === "sent") && browserOnline) {
      attempts = 0;
      exhausted = false;
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    if (exhausted || attempts >= retryDelaysMs.length) {
      exhausted = true;
      if (!await wait(checkIntervalMs, signal, sleep)) break;
      continue;
    }

    const backoffMs = retryDelaysMs[attempts];
    if (backoffMs > 0 && !await wait(backoffMs, signal, sleep)) break;
    attempts += 1;
    try {
      await bridge.testBridge({ signal });
      if (signal.aborted) break;
      attempts = 0;
      exhausted = false;
      wasBrowserOnline = true;
      await onReady?.();
    } catch (error) {
      if (signal.aborted) break;
      if (error?.code === "bridge_login_required") {
        // Login is a user action; keep the one browser open and never relaunch
        // it while the bound tab remains on the login page.
        attempts = retryDelaysMs.length;
        exhausted = true;
      }
      logger?.warn?.("deepseek-worker Chat Bridge bootstrap attempt failed: %s", error?.code || "bridge_error");
    }
  }
}
