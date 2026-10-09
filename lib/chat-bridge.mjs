import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DEBUG_PORT = 9223;
const MAX_MESSAGE_BYTES = 900;
const CHAT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);
const ALLOWED_EVENT_NAMES = new Set(["task.completed", "task.failed"]);
// Submit-path budgets. The old 3s toolbar window was shorter than a slow ChatGPT
// hydration, which is how a delivery ended up on the blind-Enter fallback.
const SEND_CONTROL_WAIT_MS = 15_000;
const SEND_CONTROL_MIN_WAIT_MS = 3_000;
const SEND_CONTROL_POLL_MS = 150;
const SEND_CONTROL_STABLE_READS = 3;
const SEND_CONTROL_STABLE_NEGATIVE_READS = 4;
const MAX_DRAFT_INSERTIONS = 3;
const CONFIRMATION_ATTEMPTS = 20;
const CONFIRMATION_INTERVAL_MS = 300;
// Budget for a tab to commit to the conversation we asked for. A freshly
// created tab needs this while its SPA hydrates; an already-open tab matches on
// the first read.
const TARGET_BIND_WAIT_MS = 20_000;
// A composer that already holds somebody else's unsent draft is re-read a few
// times before we give up, so a mid-hydration render cannot be mistaken for a
// human draft (and vice versa).
const FOREIGN_DRAFT_CONFIRMATIONS = 2;
const FOREIGN_DRAFT_POLL_MS = 200;

function withSubmitDiagnostic(error, diagnostic) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  if (!wrapped.diagnostic) wrapped.diagnostic = Object.freeze({ ...diagnostic });
  return wrapped;
}

function withAbort(operation, signal) {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Chat Bridge operation was interrupted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("Chat Bridge operation was interrupted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    Promise.resolve().then(operation).then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}

function requiredId(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new Error(`${field} must be a non-empty string up to 160 characters`);
  }
  return value.trim();
}

export function normalizeBridgeChatUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Chat Bridge URL must be a valid URL");
  }
  if (url.protocol !== "https:" || !CHAT_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new Error("Chat Bridge URL must be an HTTPS chatgpt.com URL");
  }
  if (url.pathname.startsWith("/auth") || url.pathname.startsWith("/plugins") || url.pathname.startsWith("/#settings")) {
    throw new Error("Chat Bridge URL must point to a ChatGPT chat or project, not settings/auth");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeBridgeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridge delivery envelope must be an object");
  }
  const eventName = requiredId(value.event_name ?? value.name, "event_name");
  if (!ALLOWED_EVENT_NAMES.has(eventName)) {
    throw new Error("Bridge delivery event is not allowed");
  }
  const revision = Number(value.project_revision ?? value.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("project_revision must be a positive integer");
  return Object.freeze({
    deliveryId: requiredId(value.delivery_id, "delivery_id"),
    messageKey: requiredId(value.message_key, "message_key"),
    projectId: requiredId(value.project_id, "project_id"),
    eventId: requiredId(value.event_id, "event_id"),
    taskId: requiredId(value.task_id, "task_id"),
    eventName,
    revision,
    wakeTarget: normalizeWakeTarget(value.wake_target ?? value.wakeTarget),
    // The fixed configured conversation is only usable for a delivery the Site
    // explicitly marked as belonging to an origin-unbound legacy project.
    legacyBinding: value.legacy_binding === true,
  });
}

export function normalizeWakeTarget(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "chatgpt_conversation") {
    throw new Error("bridge_wake_target_invalid: expected a chatgpt_conversation target");
  }
  const url = normalizeBridgeChatUrl(value.url ?? "");
  if (!url || !/^https:\/\/(?:www\.)?chatgpt\.com\/(?:c\/[^/?#]+|g\/[^/?#]+\/c\/[^/?#]+)(?:\/|$)/iu.test(url)) {
    throw new Error("bridge_wake_target_invalid: conversation URL must identify a ChatGPT conversation");
  }
  const conversationId = typeof value.conversation_id === "string" && value.conversation_id.trim()
    ? requiredId(value.conversation_id, "conversation_id")
    : null;
  return Object.freeze({
    type: "chatgpt_conversation",
    ...(conversationId ? { conversation_id: conversationId } : {}),
    url,
    source: typeof value.source === "string" && value.source.trim() ? value.source.trim().slice(0, 80) : "delivery",
    captured_at: typeof value.captured_at === "string" && !Number.isNaN(Date.parse(value.captured_at)) ? value.captured_at : null,
  });
}

export function buildBridgeControlMessage(envelope) {
  const event = normalizeBridgeEnvelope(envelope);
  const state = event.eventName === "task.completed" ? "TASK_COMPLETED" : "TASK_FAILED";
  const text = [
    "[DSW]",
    `STATE: ${state}`,
    `PROJECT_ID: ${event.projectId}`,
    `EVENT_ID: ${event.eventId}`,
    `TASK_ID: ${event.taskId}`,
    `REVISION: ${event.revision}`,
    "",
    "ACTION:",
    "Use DeepSeek Worker tools. Acquire the project lease, read pending project events and the task result, continue/retry/submit only what is needed, ack handled events, release the lease, then end this turn. Do not poll task status.",
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Bridge control message exceeded the size limit");
  }
  return text;
}

export function buildCloudBridgeControlMessage(envelope) {
  const event = normalizeBridgeEnvelope(envelope);
  const text = [
    "[DSW]", "STATE: PROJECT_EVENT_PENDING",
    `PROJECT_ID: ${event.projectId}`, `TASK_ID: ${event.taskId}`, `MESSAGE_KEY: ${event.messageKey}`,
    "", "ACTION:", "Use DeepSeek Worker tools.", "Acquire the project lease.",
    "Read pending project events and the completed task result.", "Continue orchestration.",
    "Ack processed project events.", "Release the lease.", "Then end this turn.", "Do not poll task status.",
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Bridge control message exceeded the size limit");
  return text;
}

export function bridgePublicState(runtime = {}, config = {}) {
  let chatUrl = null;
  let bindingError = null;
  try {
    chatUrl = normalizeBridgeChatUrl(config.chatBridgeChatUrl ?? "");
  } catch (error) {
    bindingError = error instanceof Error ? error.message : String(error);
  }
  const enabled = config.chatBridgeEnabled !== false;
  const debugPort = Number(config.chatBridgeDebugPort ?? DEFAULT_DEBUG_PORT);
  const portError = Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65535
    ? null
    : "Invalid Chat Bridge debug port.";
  const state = !enabled
    ? "disabled"
    : bindingError
      ? "invalid-binding"
      : portError
        ? "invalid-config"
      : !chatUrl
        ? "unbound"
        : (runtime.bridgeState || "uninitialized");
  return Object.freeze({
    enabled,
    bound: Boolean(chatUrl),
    browser: runtime.bridgeBrowser || "unknown",
    state,
    lastEventId: runtime.bridgeLastEventId || null,
    lastMessageKey: runtime.bridgeLastMessageKey || null,
    lastSentAt: runtime.bridgeLastSentAt || null,
    lastError: bindingError || portError || runtime.bridgeLastError || null,
    // Delivery diagnostics: whether a verified draft is still sitting in the
    // composer, whether a submit was actually attempted, whether the wake is
    // visible in the conversation, and whether a human has to confirm it.
    // Conversation URLs are never part of this object.
    lastSubmitDiagnostic: runtime.bridgeLastSubmitDiagnostic
      ? Object.freeze({ ...runtime.bridgeLastSubmitDiagnostic })
      : null,
    heldMessageKey: runtime.bridgeUncertainMessageKey || null,
    manualInterventionRequired: runtime.bridgeLastSubmitDiagnostic?.manualInterventionRequired === true
      || runtime.bridgeState === "uncertain",
  });
}

export function bridgeReady(runtime = {}, config = {}) {
  const state = bridgePublicState(runtime, config);
  return state.enabled
    && state.bound
    && state.browser === "online"
    && (state.state === "ready" || state.state === "sent");
}

function envPath(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function bridgeProfileDir() {
  if (process.platform === "win32") {
    return join(envPath("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "DeepSeekWorker", "ChatBridgeProfile");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "DeepSeekWorker", "ChatBridgeProfile");
  }
  return join(envPath("XDG_STATE_HOME") || join(homedir(), ".local", "state"), "deepseek-worker", "chat-bridge-profile");
}

export function chromiumCandidates() {
  if (process.platform === "win32") {
    const local = envPath("LOCALAPPDATA");
    const pf = envPath("PROGRAMFILES");
    const pfx86 = envPath("PROGRAMFILES(X86)");
    return [
      local && join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      pf && join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      pfx86 && join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
      local && join(local, "Google", "Chrome", "Application", "chrome.exe"),
      pf && join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      pfx86 && join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export function findChromiumExecutable() {
  return chromiumCandidates().find((candidate) => existsSync(candidate)) || null;
}

// The only page the CDP browser may be cold-started on.
//
// Two things must never appear here:
//   - `about:blank`, which left a stray empty tab in the user's window on every
//     launch;
//   - a conversation URL, because a bound conversation may be stale and opening
//     it would drag the user into (or reuse) a chat they are not working in.
// The neutral home page is also the only page the health probe is allowed to
// read, so starting there keeps the probe honest.
export const BRIDGE_START_URL = "https://chatgpt.com/";

/**
 * Command line for the dedicated CDP browser profile.
 *
 * The start URL is a constant: neither `openHome: true` nor `openHome: false`
 * may change it, so no code path can reintroduce an `about:blank` tab.
 */
export function browserLaunchArgs({ port, profileDir }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    BRIDGE_START_URL,
  ];
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open(timeoutMs = 10_000, signal) {
    if (typeof WebSocket !== "function") throw new Error("Node WebSocket runtime is unavailable");
    if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    const abort = () => {
      const error = signal.reason || new Error("Chat Bridge operation was interrupted");
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      try { socket.close(); } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    let rejectOnAbort;
    const opened = [
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
      }),
      delay(timeoutMs).then(() => { throw new Error("CDP WebSocket connection timed out"); }),
    ];
    if (signal) opened.push(new Promise((_, reject) => {
      rejectOnAbort = () => reject(signal.reason || new Error("Chat Bridge operation was interrupted"));
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    }));
    try {
      await Promise.race(opened);
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      try { socket.close(); } catch {}
      throw error;
    } finally {
      if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
    }
    socket.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (!data?.id) return;
      const waiter = this.pending.get(data.id);
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.error) waiter.reject(new Error(data.error.message || "CDP command failed"));
      else waiter.resolve(data.result || {});
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function fetchJson(url, timeoutMs = 2500, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Browser debugging endpoint returned HTTP ${response.status}`);
  return response.json();
}

async function waitForDebugEndpoint(port, timeoutMs = 15_000, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 2500, signal);
      if (typeof version?.webSocketDebuggerUrl === "string") return version;
    } catch (error) {
      lastError = error;
    }
    if (signal?.aborted) break;
    await delay(250, undefined, { signal }).catch(() => {});
  }
  if (signal?.aborted) throw signal.reason || lastError || new Error("Chat Bridge browser startup was interrupted");
  throw lastError || new Error("Chat Bridge browser did not expose a debugging endpoint");
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (result?.exceptionDetails) {
    throw Object.assign(new Error("Chat Bridge page script failed"), {
      code: "bridge_page_script_exception",
      reason: "page-script-exception",
    });
  }
  return result?.result?.value;
}

function pageProbeScript() {
  return "(() => ({ href: location.href, readyState: document.readyState }))()";
}

// Selector order is priority order. The first selector that yields a visible
// candidate wins, so a real `#prompt-textarea` is never displaced by a larger
// unrelated contenteditable; inside one selector group the focused element wins
// and the largest remaining candidate is used as a deterministic fallback.
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'textarea[data-testid*="prompt"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="消息"]',
  'main [contenteditable="true"][role="textbox"]',
  'main [contenteditable="true"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
];

function composerPickerSource({ includeText = false } = {}) {
  return `
    const composerSelectors = ${JSON.stringify(COMPOSER_SELECTORS)};
    const visibleComposer = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const composerArea = (el) => {
      const r = el.getBoundingClientRect();
      return (r.width || 0) * (r.height || 0);
    };
    const composerGroups = composerSelectors.map((selector) => [...new Set([...document.querySelectorAll(selector)].filter(visibleComposer))]);
    const flatComposers = [...new Set(composerGroups.flat())];
    const focusedComposer = flatComposers.find((el) => el === document.activeElement) || null;
    const composerGroup = composerGroups.find((group) => group.length > 0) || [];
    const composer = focusedComposer
      || composerGroup.slice().sort((a, b) => composerArea(b) - composerArea(a))[0]
      || null;
    const composerForm = composer && typeof composer.closest === 'function' ? composer.closest('form') : null;
    const composerContainer = composer && typeof composer.closest === 'function'
      ? composer.closest('form, [data-testid*="composer"], [class*="composer"]')
      : null;
    const composerRect = composer ? composer.getBoundingClientRect() : null;
    ${includeText ? `const composerText = () => {
      if (!composer) return '';
      return typeof composer.value === 'string' ? composer.value : (composer.innerText || composer.textContent || '');
    };` : ""}
  `;
}

function composerFocusScript() {
  return `(() => {
    ${composerPickerSource()}
    if (!composer) return { ok: false, reason: 'composer_not_found', href: location.href };
    if (typeof composer.focus !== 'function') return { ok: false, reason: 'composer_not_focusable', href: location.href };
    composer.focus();
    return { ok: true, focused: document.activeElement === composer, tag: composer.tagName, href: location.href };
  })()`;
}

export function sendButtonMetadataScript() {
  return `(() => {
    ${composerPickerSource()}
    const selectors = ['button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="发送"]','main form button[type="submit"]'];
    const allButtons = [...document.querySelectorAll('button')];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((el) => ({ el, selector })));
    const metadata = candidates.map(({ el, selector }) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      const ariaLabel = el.getAttribute('aria-label');
      const testId = el.getAttribute('data-testid');
      const forbidden = /stop|voice|attach|upload|dictate|record|mic|share|cancel|停止|语音|附件|上传|录音|朗读|听写|分享|取消/iu.test([ariaLabel, testId].filter(Boolean).join(' '));
      const inForm = Boolean(composerForm && composerForm.contains(el));
      const inContainer = Boolean(composerContainer && composerContainer.contains(el));
      const buttonRect = r;
      const nearComposerByRect = Boolean(composerRect
        && Number.isFinite(composerRect.x) && Number.isFinite(composerRect.y)
        && Math.abs((buttonRect.y + buttonRect.height / 2) - (composerRect.y + composerRect.height / 2)) <= Math.max(160, composerRect.height * 3)
        && buttonRect.x >= composerRect.x - 100
        && buttonRect.x + buttonRect.width <= composerRect.x + composerRect.width + 100);
      const nearComposer = Boolean(composer && (inForm || inContainer || nearComposerByRect));
      const visible = r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
      const x = r.x + r.width / 2; const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const hitMatchesButton = Boolean(hit && (hit === el || el.contains(hit)));
      const hitMetadata = hit ? {
        tagName: hit.tagName,
        role: hit.getAttribute('role'),
        dataTestId: hit.getAttribute('data-testid'),
        ariaLabel: hit.getAttribute('aria-label'),
      } : null;
      const distance = Number.isFinite(composerRect?.x) && Number.isFinite(composerRect?.y)
        ? Math.round(Math.hypot(x - (composerRect.x + composerRect.width), y - (composerRect.y + composerRect.height)))
        : null;
      // The aria-label selectors are substring matches, so they also catch
      // lookalikes such as "Send feedback". Only a control that really names the
      // send action (or is the composer form's submit button) may be clicked.
      const isSendControl = /^send-button$/iu.test(testId || '')
        || /^(?:send(?:\\s+(?:message|prompt|now))?|发送(?:消息|提示)?)$/iu.test((ariaLabel || '').trim())
        || selector === 'main form button[type="submit"]';
      return { el, selector, tagName: el.tagName, role: el.getAttribute('role'), dataTestId: testId, ariaLabel, disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, visibility: s.visibility, display: s.display, visible, nearComposer, inForm, inContainer, distance, forbidden, isSendControl, hitMatchesButton, hitMetadata };
    });
    const eligible = metadata.filter((item) => item.tagName === 'BUTTON' && item.visible && !item.disabled && item.nearComposer && !item.forbidden && item.isSendControl && item.hitMatchesButton);
    eligible.sort((a, b) => {
      const byTestId = Number(b.dataTestId === 'send-button') - Number(a.dataTestId === 'send-button');
      if (byTestId !== 0) return byTestId;
      return (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER);
    });
    const chosen = eligible[0] || null;
    return {
      buttonCount: allButtons.length,
      composerFound: Boolean(composer),
      composerRect: composerRect ? { x: composerRect.x, y: composerRect.y, width: composerRect.width, height: composerRect.height } : null,
      selectorMatches: Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length])),
      candidates: metadata.map(({ el, ...item }) => item),
      chosen: chosen ? { selector: chosen.selector, x: chosen.rect.x + chosen.rect.width / 2, y: chosen.rect.y + chosen.rect.height / 2, metadata: (({ el, ...item }) => item)(chosen) } : null,
    };
  })()`;
}

export function composerSendStateScript(messageKey) {
  const key = JSON.stringify(messageKey);
  return `(() => {
    ${composerPickerSource({ includeText: true })}
    if (!composer) return { composerFound: false, composerHasMessageKey: false, composerEmpty: null, sendEnabled: false, sendControlFound: false, sendControlDisabled: false, submitting: false };
    const value = composerText();
    const nearComposer = (el, r) => Boolean((composerForm && composerForm.contains(el))
      || (composerContainer && composerContainer.contains(el))
      || (composerRect
        && Number.isFinite(composerRect.x) && Number.isFinite(composerRect.y)
        && Math.abs((r.y + r.height / 2) - (composerRect.y + composerRect.height / 2)) <= Math.max(160, composerRect.height * 3)
        && r.x >= composerRect.x - 100
        && r.x + r.width <= composerRect.x + composerRect.width + 100));
    const controls = [...document.querySelectorAll('button')].map((el) => {
      const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
      const label = el.getAttribute('aria-label') || '';
      const testId = el.getAttribute('data-testid') || '';
      return {
        label,
        testId,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        visible: r.width > 8 && r.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0,
        nearComposer: nearComposer(el, r),
        // A control is only a send control when it is neither a generation-stop,
        // voice, attachment, dictation nor share control, and its label really
        // names the send action. The previous test-id branch bypassed the
        // disabled check entirely (OR binds looser than AND), so a disabled send
        // button was reported as an enabled one; the anchored label list also
        // missed the real 发送消息 label.
        isSend: !/stop|voice|attach|upload|dictate|record|mic|share|cancel|停止|语音|附件|上传|录音|朗读|听写|分享|取消/iu.test(label + ' ' + testId)
          && (/^send-button$/iu.test(testId) || /^(?:send(?:\\s+(?:message|prompt|now))?|发送(?:消息|提示)?)$/iu.test(label.trim())),
      };
    });
    const stopControls = controls.filter((item) => /stop|cancel|停止|取消/iu.test(item.label + ' ' + item.testId) && item.visible);
    const submitting = stopControls.some((item) => !item.disabled);
    const staleStopControl = stopControls.some((item) => item.disabled);
    const sendControls = controls.filter((item) => item.isSend && item.visible);
    const sendEnabled = sendControls.some((item) => !item.disabled);
    const visibleErrors = [...document.querySelectorAll('[role="alert"],[aria-live="assertive"]')].filter((el) => {
      const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && r.right > 0 && r.bottom > 0
        && r.left < (document.documentElement?.clientWidth || Number.MAX_SAFE_INTEGER)
        && r.top < (document.documentElement?.clientHeight || Number.MAX_SAFE_INTEGER)
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    }).length;
    return {
      composerFound: true,
      composerHasMessageKey: value.includes('MESSAGE_KEY: ' + ${key}),
      composerEmpty: value.trim().length === 0,
      sendEnabled,
      sendControlFound: sendControls.length > 0,
      sendControlDisabled: sendControls.length > 0 && !sendEnabled,
      submitting,
      staleStopControl,
      visibleErrors,
      idle: value.trim().length === 0 && !submitting && !staleStopControl && visibleErrors === 0,
    };
  })()`;
}

export function composerContainsMessageScript(messageKey) {
  const key = JSON.stringify(messageKey);
  return `(() => {
    ${composerPickerSource({ includeText: true })}
    if (!composer) return { ok: false, reason: 'composer_not_found' };
    return { ok: composerText().includes('MESSAGE_KEY: ' + ${key}) };
  })()`;
}

export function messageVisibleScript(projectId, taskId, messageKey) {
  const project = JSON.stringify(projectId);
  const task = JSON.stringify(taskId);
  const key = JSON.stringify(messageKey);
  return `(() => {
    const messages = [...document.querySelectorAll('main [data-user-message-bubble="true"], main [data-message-author-role="user"], main [data-testid^="conversation-turn-"]')];
    return messages.some((node) => {
      const text = node.textContent || '';
      return text.includes('PROJECT_ID: ' + ${project}) && text.includes('TASK_ID: ' + ${task}) && text.includes('MESSAGE_KEY: ' + ${key});
    });
  })()`;
}

function loginStateScript() {
  return `(() => {
    const href = location.href;
    const text = (document.body?.innerText || '').toLowerCase();
    const path = location.pathname.toLowerCase();
    const authPaths = ['/auth/login', '/auth/signin', '/auth/sign-up', '/auth/signup'];
    const authPath = authPaths.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
    const loginCopy = /log in to continue|sign in to continue|登录以继续|登录以继续使用|欢迎回来/u.test(text);
    const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid*="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], main [contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"]')].some((el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    return { href, authRequired: authPath || (loginCopy && !composer) };
  })()`;
}

function chatPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && CHAT_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

function isChatLoginUrl(value) {
  if (!chatPageUrl(value)) return false;
  try { return /\/auth\/(login|signin|sign-up|signup)(\/|$)/iu.test(new URL(value).pathname); }
  catch { return false; }
}

export function sameChatUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const path = (value) => value.pathname.replace(/\/+$/u, "") || "/";
    return a.protocol === "https:" && b.protocol === "https:"
      && CHAT_HOSTS.has(a.hostname.toLowerCase()) && CHAT_HOSTS.has(b.hostname.toLowerCase())
      && path(a) === path(b);
  } catch { return false; }
}

// ChatGPT serves the same conversation under cosmetic URL variants: a trailing
// slash, an SPA-appended query string (`?model=...`, `?temporary-chat=true`,
// cache-busters) and a `www.` host prefix. The conversation itself is identified
// by the id in the path, so those variants must resolve to one identity or the
// send path and the reconcile path disagree and a delivery looks "target_missing"
// while its tab is actually open. Different conversation ids stay different.
const CONVERSATION_PATH = /^(?:\/g\/[^/]+)?\/c\/([^/?#]+)$/u;

function normalizedChatPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (host !== "chatgpt.com") return null;
  let path = url.pathname.replace(/\/{2,}/gu, "/").toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/u, "");
  if (!path) path = "/";
  if (path === "/auth" || path.startsWith("/auth/") || path.startsWith("/plugins")) return null;
  return path;
}

/**
 * Canonical, non-secret identity of a ChatGPT page for Chat Bridge targeting.
 * Returns `chat:<conversation-id>` for a conversation page and `path:<path>` for
 * any other allowed ChatGPT page, or `null` when the URL is not a usable
 * ChatGPT HTTPS page (fail closed: never guess a target).
 */
export function conversationIdentity(value) {
  const path = normalizedChatPath(value);
  if (!path) return null;
  const conversation = CONVERSATION_PATH.exec(path);
  return conversation ? `chat:${conversation[1]}` : `path:${path}`;
}

/**
 * Shared target semantics for both send and reconcile: identical conversation
 * identity, with trailing slashes and harmless query parameters normalized away.
 */
export function sameConversationUrl(left, right) {
  const a = conversationIdentity(left);
  const b = conversationIdentity(right);
  return a !== null && b !== null && a === b;
}

// Delivery needs a stricter binding than "same conversation identity": it has to
// prove the HTTPS chatgpt.com origin and that an explicitly requested project
// prefix (`/g/<gizmo>/c/<id>`) is not contradicted by the page we are about to
// type into. A group that is absent on either side is not a contradiction,
// because ChatGPT serves the same conversation both with and without the project
// prefix; two *different* explicit groups are, and then we fail closed.
const CONVERSATION_BINDING_PATH = /^(?:\/g\/([^/]+))?\/c\/([^/?#]+)$/u;

export function conversationBinding(value) {
  const path = normalizedChatPath(value);
  if (!path) return null;
  const match = CONVERSATION_BINDING_PATH.exec(path);
  if (!match) return { conversationId: null, groupId: null, path };
  return { conversationId: match[2], groupId: match[1] ?? null, path };
}

export function sameTargetConversation(left, right) {
  const a = conversationBinding(left);
  const b = conversationBinding(right);
  if (!a?.conversationId || !b?.conversationId) return false;
  if (a.conversationId !== b.conversationId) return false;
  if (a.groupId && b.groupId && a.groupId !== b.groupId) return false;
  return true;
}

function safeChatHref(value) {
  if (typeof value !== "string") return "(无法读取)";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !CHAT_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
      return "(非允许的 ChatGPT HTTPS 地址)";
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(无法读取)";
  }
}

function inaccessibleConversationError(expectedUrl, actualUrl) {
  return Object.assign(new Error([
    "绑定的 ChatGPT 对话无法访问。",
    `期望：${safeChatHref(expectedUrl)}`,
    `实际：${safeChatHref(actualUrl)}`,
  ].join("\n")), { code: "bridge_conversation_unreachable" });
}

function navigationUnstableError(expectedUrl, actualUrl) {
  return Object.assign(new Error([
    "ChatGPT 对话导航在等待期限内未稳定。",
    `期望：${safeChatHref(expectedUrl)}`,
    `实际：${safeChatHref(actualUrl)}`,
  ].join("\n")), { code: "bridge_navigation_unstable" });
}

function targetEvaluationUrlError(expectedUrl, actualUrl, error) {
  const reason = error?.reason || classifyEvaluationError(error);
  const code = error?.code === "bridge_page_script_exception"
    ? "bridge_page_script_exception"
    : "bridge_page_eval_failed";
  return Object.assign(new Error([
    `ChatGPT 页面检查失败（${reason}）。`,
    `期望：${safeChatHref(expectedUrl)}`,
    `实际：${safeChatHref(actualUrl)}`,
  ].join("\n")), { code, reason });
}

function classifyEvaluationError(error) {
  const message = String(error?.message || "");
  if (/execution context was destroyed/iu.test(message)) return "execution-context-destroyed";
  if (/cannot find context with specified id|cannot find execution context/iu.test(message)) return "execution-context-not-found";
  if (/inspected target navigated or closed|target navigated/iu.test(message)) return "target-navigated";
  if (/target closed|session closed|cdp connection closed/iu.test(message)) return "target-closed";
  return "runtime-evaluate-failed";
}

const TRANSIENT_EVALUATION_REASONS = new Set([
  "execution-context-destroyed",
  "execution-context-not-found",
  "target-navigated",
  "target-closed",
]);

async function evaluateWithRetry(cdp, sessionId, expression, { deadline, expectedUrl, target } = {}) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await evaluate(cdp, sessionId, expression);
    } catch (error) {
      lastError = error;
      const reason = error?.reason || classifyEvaluationError(error);
      if (error?.code === "bridge_page_script_exception" || !TRANSIENT_EVALUATION_REASONS.has(reason)) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(100, remaining));
    }
  }
  const actualUrl = target ? await currentTargetUrl(cdp, target) : null;
  throw targetEvaluationUrlError(expectedUrl, actualUrl, lastError || new Error("Runtime.evaluate deadline expired"));
}

async function currentTargetUrl(cdp, target) {
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo", { targetId: target.targetId });
    if (chatPageUrl(targetInfo?.url)) return targetInfo.url;
  } catch {}
  try {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const current = targetInfos.find((info) => info.targetId === target.targetId);
    if (chatPageUrl(current?.url)) return current.url;
  } catch {}
  return chatPageUrl(target.url) ? target.url : null;
}

/**
 * Conversation-aware page comparison for the send path.
 *
 * `sameChatUrl` compares raw pathnames, which is not enough for delivery: the
 * same conversation is served as `/c/<id>`, `/g/<gizmo>/c/<id>`, with a `www.`
 * host and with cosmetic query strings, and a raw pathname mismatch used to make
 * the composer wait reject a tab that really was the target conversation. The
 * conversation identity is what both the send path and the reconciler agree on.
 */
function samePageConversation(left, right) {
  return sameConversationUrl(left, right);
}

async function waitForBoundTarget(cdp, target, chatUrl, deadline) {
  let lastUrl = null;
  let stableSince = 0;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const href = await currentTargetUrl(cdp, target);
    if (href) {
      if (href === lastUrl) {
        stableReads += 1;
      } else {
        lastUrl = href;
        stableSince = Date.now();
        stableReads = 1;
      }
      if (samePageConversation(href, chatUrl) && stableReads >= 2) return href;
      if (isChatLoginUrl(href) && stableReads >= 2) return href;
      if (!samePageConversation(href, chatUrl) && !isChatLoginUrl(href) && stableReads >= 3 && Date.now() - stableSince >= 500) {
        throw inaccessibleConversationError(chatUrl, href);
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(150, remaining));
  }
  if (lastUrl && !samePageConversation(lastUrl, chatUrl) && !isChatLoginUrl(lastUrl)
    && stableReads >= 2 && Date.now() - stableSince >= 500) {
    throw inaccessibleConversationError(chatUrl, lastUrl);
  }
  if (lastUrl && isChatLoginUrl(lastUrl)) return lastUrl;
  throw navigationUnstableError(chatUrl, lastUrl);
}

/**
 * Read the URL a target really reports right now.
 *
 * Returns `null` instead of the URL we *asked* for, so a target that has not
 * committed to the requested conversation yet can never be mistaken for one that
 * has. That distinction is what makes a freshly created tab safe to wait on
 * while its SPA is still loading.
 */
async function readTargetUrl(cdp, targetId) {
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo", { targetId });
    if (chatPageUrl(targetInfo?.url)) return targetInfo.url;
  } catch {}
  try {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const info = targetInfos.find((item) => item.targetId === targetId);
    if (chatPageUrl(info?.url)) return info.url;
  } catch {}
  return null;
}

/**
 * Wait until a tab really is the requested conversation (or has landed on the
 * ChatGPT login wall). Matching uses the conversation identity, so a cosmetic
 * `?model=`/trailing-slash/`www.` variant or the project `/g/<gizmo>` prefix
 * still counts, while a different conversation or the ChatGPT home page does
 * not and fails closed.
 */
async function waitForConversationTarget(cdp, target, chatUrl, deadline) {
  let lastUrl = null;
  let stableReads = 0;
  let stableSince = 0;
  let loginUrl = null;
  while (Date.now() < deadline) {
    const href = await readTargetUrl(cdp, target.targetId);
    if (href) {
      if (href === lastUrl) {
        stableReads += 1;
      } else {
        lastUrl = href;
        stableSince = Date.now();
        stableReads = 1;
      }
      if (isChatLoginUrl(href)) {
        loginUrl = href;
        if (stableReads >= 2) return href;
      } else if (sameTargetConversation(href, chatUrl)) {
        if (stableReads >= 2) return href;
      } else if (conversationBinding(href)?.conversationId) {
        // A *different* conversation id is never a transient hydration state for
        // the tab we asked for: fail closed at once instead of typing into it.
        throw inaccessibleConversationError(chatUrl, href);
      } else if (stableReads >= 4 && Date.now() - stableSince >= 1_500) {
        // Settled on a non-conversation ChatGPT page (for example the home page
        // after an inaccessible conversation redirect). Never type into it.
        throw inaccessibleConversationError(chatUrl, href);
      }
    } else {
      lastUrl = null;
      stableReads = 0;
      stableSince = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(150, remaining));
  }
  if (loginUrl) return loginUrl;
  if (lastUrl) throw inaccessibleConversationError(chatUrl, lastUrl);
  throw navigationUnstableError(chatUrl, null);
}

function composerUnavailableError(expectedUrl, actualUrl) {
  return Object.assign(new Error([
    "绑定对话已打开，但未找到可用的 ChatGPT 输入框。",
    `期望：${safeChatHref(expectedUrl)}`,
    `实际：${safeChatHref(actualUrl)}`,
  ].join("\n")), { code: "bridge_composer_unavailable" });
}

function loginRequiredError() {
  return Object.assign(new Error("需要登录 ChatGPT：请在桥接浏览器中登录后重试。"), { code: "bridge_login_required" });
}

async function waitForComposer(cdp, sessionId, { deadline, expectedUrl, target } = {}) {
  let focus = null;
  let actualUrl = await currentTargetUrl(cdp, target);
  while (Date.now() < deadline) {
    focus = await evaluateWithRetry(cdp, sessionId, composerFocusScript(), { deadline, expectedUrl, target });
    const pageUrl = focus?.href || await currentTargetUrl(cdp, target);
    if (isChatLoginUrl(pageUrl)) throw loginRequiredError();
    if (!samePageConversation(pageUrl, expectedUrl)) {
      actualUrl = await currentTargetUrl(cdp, target);
      if (isChatLoginUrl(actualUrl)) throw loginRequiredError();
      if (!samePageConversation(actualUrl, expectedUrl)) throw inaccessibleConversationError(expectedUrl, actualUrl);
      throw navigationUnstableError(expectedUrl, pageUrl);
    }
    actualUrl = pageUrl;
    if (focus?.ok && focus.focused === true) return focus;

    if (focus?.reason === "composer_not_found" && Date.now() < deadline) {
      const page = await evaluateWithRetry(cdp, sessionId, loginStateScript(), { deadline, expectedUrl, target });
      if (page?.authRequired) throw loginRequiredError();
      if (!samePageConversation(page?.href, expectedUrl)) {
        actualUrl = await currentTargetUrl(cdp, target);
        if (isChatLoginUrl(page?.href) || isChatLoginUrl(actualUrl)) throw loginRequiredError();
        if (!samePageConversation(actualUrl, expectedUrl)) throw inaccessibleConversationError(expectedUrl, actualUrl);
        throw navigationUnstableError(expectedUrl, page?.href || actualUrl);
      }
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(300, remaining));
  }
  throw composerUnavailableError(expectedUrl, focus?.href || actualUrl);
}

async function cdpPage(cdp, url, { preferUrl } = {}) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  let target = preferUrl
    ? targetInfos.find((info) => info.type === "page" && chatPageUrl(info.url) && samePageConversation(info.url, preferUrl))
    : undefined;
  target ||= targetInfos.find((info) => info.type === "page" && chatPageUrl(info.url));
  if (!target) {
    const created = await cdp.send("Target.createTarget", { url });
    target = { targetId: created.targetId, url };
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  return { target, sessionId };
}

async function restoreAndActivate(cdp, targetId) {
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Target.activateTarget", { targetId });
}

export class ChatBridgeController {
  constructor({ runtime, getConfig, logger, cdpFactory, spawnBrowser = spawn, findBrowserExecutable = findChromiumExecutable } = {}) {
    this.runtime = runtime || {};
    this.getConfig = typeof getConfig === "function" ? getConfig : () => ({});
    this.logger = logger;
    this.cdpFactory = cdpFactory || ((url) => new CdpConnection(url));
    this.spawnBrowser = spawnBrowser;
    this.findBrowserExecutable = findBrowserExecutable;
    this.browserChild = null;
    this.ensureBrowserPromise = null;
  }

  status() {
    return bridgePublicState(this.runtime, this.getConfig());
  }

  async isBrowserAvailable({ signal } = {}) {
    const config = this.getConfig();
    const port = Number(config.chatBridgeDebugPort ?? DEFAULT_DEBUG_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 2500, signal);
      if (typeof version?.webSocketDebuggerUrl === "string") {
        this.runtime.bridgeBrowser = "online";
        return true;
      }
    } catch {}
    this.runtime.bridgeBrowser = "unavailable";
    return false;
  }

  async ensureBrowser(options = {}) {
    if (this.ensureBrowserPromise) return this.ensureBrowserPromise;
    this.ensureBrowserPromise = this.#ensureBrowser(options).finally(() => {
      this.ensureBrowserPromise = null;
    });
    return this.ensureBrowserPromise;
  }

  /**
   * Ensure a CDP browser is reachable, cold-starting one only when allowed.
   *
   * `openHome` is accepted for call-site compatibility and is deliberately
   * ignored: it no longer selects the launch URL. A cold start always lands on
   * `BRIDGE_START_URL` (the neutral ChatGPT home page), so `openHome: false` —
   * used by the health probe and the send path — can no longer leave an
   * `about:blank` tab behind, and no value of `openHome` can substitute a
   * conversation URL as the start page. Everything else about the launch
   * (debug port, profile directory, CDP endpoint) is unchanged.
   */
  async #ensureBrowser({ openHome = false, allowLaunch = true, signal } = {}) {
    void openHome;
    if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");
    const config = this.getConfig();
    if (config.chatBridgeEnabled === false) throw new Error("Chat Bridge is disabled");
    const port = Number(config.chatBridgeDebugPort ?? DEFAULT_DEBUG_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Chat Bridge debug port");

    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 2500, signal);
      if (version?.webSocketDebuggerUrl) {
        this.runtime.bridgeBrowser = "online";
        return { port, version };
      }
    } catch {}
    if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");

    const existingChild = this.browserChild;
    if (existingChild && existingChild.exitCode === null && existingChild.signalCode === null && existingChild.killed !== true) {
      try {
        const version = await waitForDebugEndpoint(port, 15_000, signal);
        this.runtime.bridgeBrowser = "online";
        this.runtime.bridgeLastError = null;
        return { port, version };
      } catch {
        if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");
        this.runtime.bridgeBrowser = "unavailable";
        this.runtime.bridgeState = "error";
        this.runtime.bridgeLastError = "Chat Bridge browser process is running but its debugging endpoint is unavailable.";
        throw Object.assign(new Error(this.runtime.bridgeLastError), { code: "bridge_browser_start_timeout" });
      }
    }

    if (!allowLaunch) {
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeLastError = "Chat Bridge CDP browser is not already connected; refusing to launch another browser during message delivery.";
      throw Object.assign(new Error(this.runtime.bridgeLastError), { code: "bridge_cdp_unavailable" });
    }

    const executable = this.findBrowserExecutable();
    if (!executable) {
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeLastError = "未找到 Microsoft Edge / Google Chrome / Chromium。";
      throw new Error(this.runtime.bridgeLastError);
    }

    const args = browserLaunchArgs({ port, profileDir: bridgeProfileDir() });
    let child;
    try {
      child = this.spawnBrowser(executable, args, {
        detached: false,
        windowsHide: false,
        stdio: "ignore",
      });
    } catch (error) {
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeState = "error";
      this.runtime.bridgeLastError = `Chat Bridge browser failed to start${code}.`;
      throw Object.assign(new Error(this.runtime.bridgeLastError), { code: "bridge_browser_spawn_failed" });
    }
    child.once?.("error", (error) => {
      if (this.browserChild === child) this.browserChild = null;
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeState = "error";
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      this.runtime.bridgeLastError = `Chat Bridge browser failed to start${code}.`;
    });
    child.once?.("exit", () => {
      if (this.browserChild !== child) return;
      this.browserChild = null;
      this.runtime.bridgeBrowser = "unavailable";
      if (this.runtime.bridgeState === "ready" || this.runtime.bridgeState === "sent") {
        this.runtime.bridgeState = "error";
        this.runtime.bridgeLastError = "Chat Bridge browser disconnected.";
      }
    });
    child.unref?.();
    this.browserChild = child;
    let version;
    const endpointWait = new AbortController();
    try {
      const spawnFailed = new Promise((_, reject) => {
        child.once?.("error", (error) => {
          endpointWait.abort(error);
          reject(error);
        });
      });
      const startupSignal = signal ? AbortSignal.any([signal, endpointWait.signal]) : endpointWait.signal;
      version = await Promise.race([waitForDebugEndpoint(port, 15_000, startupSignal), spawnFailed]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (this.browserChild === child && (child.exitCode !== null || child.signalCode !== null || error?.code)) {
        this.browserChild = null;
      }
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeState = "error";
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      this.runtime.bridgeLastError = error?.code
        ? `Chat Bridge browser failed to start${code}.`
        : "Chat Bridge browser did not expose a debugging endpoint.";
      throw Object.assign(new Error(this.runtime.bridgeLastError), { code: "bridge_browser_spawn_failed" });
    }
    this.runtime.bridgeBrowser = "online";
    this.runtime.bridgeLastError = null;
    return { port, version };
  }

  async openLoginBrowser() {
    const { version } = await this.ensureBrowser({ openHome: true });
    const cdp = this.cdpFactory(version.webSocketDebuggerUrl);
    try {
      await cdp.open();
      const { target, sessionId } = await cdpPage(cdp, "https://chatgpt.com/");
      await cdp.send("Page.navigate", { url: "https://chatgpt.com/" }, sessionId);
      await restoreAndActivate(cdp, target.targetId);
      this.runtime.bridgeState = normalizeBridgeChatUrl(this.getConfig().chatBridgeChatUrl ?? "") ? "uninitialized" : "unbound";
      this.runtime.bridgeLastError = null;
      return this.status();
    } finally {
      cdp.close();
    }
  }

  /**
   * Read-only health probe for the Chat Bridge bootstrap loop.
   *
   * It may start or reuse the CDP browser (that is the whole point of the
   * bootstrap), but it must never move the browser: no `Page.navigate`, no
   * `Target.createTarget`, no focus/activate and no input on any session page.
   * The only page it ever reads is the neutral ChatGPT home page, so an existing
   * tab that happens to hold an unrelated conversation is never inspected,
   * focused or navigated.
   *
   * `state` is a tri-state and `ok` is true only for `ready`:
   *   - `unavailable`: no CDP browser could be reached or launched.
   *   - `needs-login`: a ChatGPT page already shows the login wall.
   *   - `ready`: the browser/CDP capability is usable to *attempt* a delivery.
   *     This is deliberately NOT a claim that the account is logged in or that
   *     the target composer exists; `sendMessage` still verifies the target
   *     conversation, the login state and the composer before typing anything,
   *     and it fails closed when it cannot confirm them.
   *
   * An aborted signal is cancellation rather than a health result, so it rejects
   * with the abort reason instead of reporting a state.
   */
  async probeBrowserHealth({ allowLaunch = true, signal } = {}) {
    let cdp;
    let closeOnAbort;
    try {
      if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");
      const { version } = await this.ensureBrowser({ openHome: false, allowLaunch, signal });
      this.runtime.bridgeBrowser = "online";
      cdp = this.cdpFactory(version.webSocketDebuggerUrl);
      closeOnAbort = () => cdp.close();
      signal?.addEventListener("abort", closeOnAbort, { once: true });
      const send = cdp.send.bind(cdp);
      cdp.send = (...args) => withAbort(() => send(...args), signal);
      await withAbort(() => cdp.open(10_000, signal), signal);

      const { targetInfos = [] } = await cdp.send("Target.getTargets");
      const pages = targetInfos.filter((info) => info.type === "page");

      // An already-open login wall is a confirmed negative. Report it without
      // attaching to anything.
      if (pages.some((info) => isChatLoginUrl(info.url))) {
        this.runtime.bridgeState = "needs-login";
        this.runtime.bridgeLastError = loginRequiredError().message;
        return { ok: false, state: "needs-login", browserOnline: true };
      }

      // The neutral home page is the only page this probe may read: a
      // conversation tab may belong to an unrelated chat and must not be
      // inspected, focused or moved.
      const neutral = pages.find((info) => chatPageUrl(info.url) && conversationIdentity(info.url) === "path:/");
      if (neutral) {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: neutral.targetId, flatten: true });
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        const state = await evaluate(cdp, sessionId, loginStateScript());
        if (state?.authRequired) {
          this.runtime.bridgeState = "needs-login";
          this.runtime.bridgeLastError = loginRequiredError().message;
          return { ok: false, state: "needs-login", browserOnline: true };
        }
      }

      // Login could not be confirmed either way. Keep it unknown: never report
      // it as logged in, and let sendMessage fail closed later if it is not.
      this.runtime.bridgeState = "ready";
      this.runtime.bridgeLastError = null;
      return { ok: true, state: "ready", browserOnline: true };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeLastError = error instanceof Error ? error.message : String(error);
      return { ok: false, state: "unavailable", browserOnline: false };
    } finally {
      if (closeOnAbort && signal) signal.removeEventListener("abort", closeOnAbort);
      cdp?.close();
    }
  }

  async testBridge({ allowLaunch = true, signal } = {}) {
    const chatUrl = normalizeBridgeChatUrl(this.getConfig().chatBridgeChatUrl ?? "");
    if (!chatUrl) throw new Error("Chat Bridge 尚未绑定 ChatGPT 对话。");
    this.runtime.bridgeState = "checking";
    this.runtime.bridgeLastError = null;
    let cdp;
    let closeOnAbort;
    try {
      if (signal?.aborted) throw signal.reason || new Error("Chat Bridge operation was interrupted");
      const { version } = await this.ensureBrowser({ openHome: false, allowLaunch, signal });
      cdp = this.cdpFactory(version.webSocketDebuggerUrl);
      closeOnAbort = () => cdp.close();
      signal?.addEventListener("abort", closeOnAbort, { once: true });
      const send = cdp.send.bind(cdp);
      cdp.send = (...args) => withAbort(() => send(...args), signal);
      await withAbort(() => cdp.open(10_000, signal), signal);
      const { target, sessionId } = await cdpPage(cdp, chatUrl, { preferUrl: chatUrl });
      await restoreAndActivate(cdp, target.targetId);
      const deadline = Date.now() + 20_000;
      let actualUrl = await currentTargetUrl(cdp, target);
      if (!samePageConversation(actualUrl, chatUrl)) {
        try {
          await cdp.send("Page.navigate", { url: chatUrl }, sessionId);
        } catch {
          throw navigationUnstableError(chatUrl, await currentTargetUrl(cdp, target));
        }
      }
      actualUrl = await waitForBoundTarget(cdp, target, chatUrl, deadline);

      let probe = null;
      while (Date.now() < deadline) {
        probe = await evaluateWithRetry(cdp, sessionId, pageProbeScript(), { deadline, expectedUrl: chatUrl, target });
        if (probe?.readyState !== "loading") {
          if (samePageConversation(probe?.href, chatUrl) || isChatLoginUrl(probe?.href)) break;
          actualUrl = await currentTargetUrl(cdp, target);
          if (!samePageConversation(actualUrl, chatUrl)) throw inaccessibleConversationError(chatUrl, actualUrl);
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) await delay(Math.min(100, remaining));
      }
      if (!probe || probe.readyState === "loading" || (!samePageConversation(probe.href, chatUrl) && !isChatLoginUrl(probe.href))) {
        throw navigationUnstableError(chatUrl, await currentTargetUrl(cdp, target));
      }

      const page = await evaluateWithRetry(cdp, sessionId, loginStateScript(), { deadline, expectedUrl: chatUrl, target });
      if (page?.authRequired) {
        this.runtime.bridgeState = "needs-login";
        throw loginRequiredError();
      }
      if (!samePageConversation(page?.href, chatUrl)) {
        actualUrl = await currentTargetUrl(cdp, target);
        if (!samePageConversation(actualUrl, chatUrl)) throw inaccessibleConversationError(chatUrl, actualUrl);
        throw navigationUnstableError(chatUrl, actualUrl);
      }

      await waitForComposer(cdp, sessionId, { deadline, expectedUrl: chatUrl, target });
      this.runtime.bridgeState = "ready";
      this.runtime.bridgeLastError = null;
      return { ok: true, ...this.status() };
    } catch (error) {
      if (signal?.aborted) {
        this.runtime.bridgeState = "uninitialized";
        this.runtime.bridgeLastError = null;
        throw signal.reason || error;
      }
      if (error?.code === "bridge_login_required") {
        this.runtime.bridgeState = "needs-login";
        this.runtime.bridgeLastError = error.message;
      } else {
        this.runtime.bridgeState = "error";
        this.runtime.bridgeLastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (closeOnAbort && signal) signal.removeEventListener("abort", closeOnAbort);
      cdp?.close();
    }
  }

  async sendEnvelope(rawEnvelope) {
    const envelope = normalizeBridgeEnvelope(rawEnvelope);
    const message = buildCloudBridgeControlMessage(rawEnvelope);
    return this.sendMessage(envelope, message, envelope.wakeTarget, envelope.legacyBinding);
  }

  async sendLocalWake(delivery) {
    const { buildLocalWakeMessage } = await import("./bridge-outbox.mjs");
    const message = buildLocalWakeMessage(delivery);
    const envelope = {
      projectId: delivery.project_id,
      taskId: delivery.task_id,
      messageKey: delivery.message_key,
      wakeTarget: normalizeWakeTarget(delivery.wake_target),
    };
    return this.sendMessage(envelope, message, envelope.wakeTarget, delivery.legacy_binding === true);
  }

  /**
   * Read-only verification of an uncertain delivery.
   *
   * Reconcile must never navigate, never insert text, never click and never
   * discard the draft that may still be sitting in the composer: its only job is
   * to observe. When the target conversation is not already open it stops with
   * `target_missing` and reports why, instead of moving the browser to look for
   * the conversation and risking a lost or duplicated wake.
   */
  async reconcileDelivery(delivery) {
    const config = this.getConfig();
    const target = delivery.wake_target ? normalizeWakeTarget(delivery.wake_target) : null;
    // wake_target always outranks the global configured conversation.
    const chatUrl = target?.url || (delivery.legacy_binding === true ? normalizeBridgeChatUrl(config.chatBridgeChatUrl ?? "") : null);
    if (!chatUrl) return { state: "uncertain", stage: "target_location", reason: "target_unbound", diagnostic: {} };
    let cdp;
    try {
      const { version } = await this.ensureBrowser({ allowLaunch: false });
      cdp = this.cdpFactory(version.webSocketDebuggerUrl);
      await cdp.open();
      const listed = await cdp.send("Target.getTargets");
      const chatPages = (listed.targetInfos || []).filter((info) => info.type === "page" && conversationIdentity(info.url) !== null);
      const page = chatPages
        .filter((info) => sameConversationUrl(info.url, chatUrl))
        .sort((a, b) => a.targetId.localeCompare(b.targetId))[0];
      if (!page) {
        return {
          state: "uncertain",
          stage: "target_location",
          reason: "target_missing",
          diagnostic: { targetFound: false, readOnly: true, chatPageCount: chatPages.length },
        };
      }
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      const actualUrl = await currentTargetUrl(cdp, page);
      const frameTree = await cdp.send("Page.getFrameTree", {}, sessionId);
      const frameId = frameTree?.frameTree?.frame?.id || null;
      if (!sameConversationUrl(actualUrl, chatUrl) || !frameId) {
        return { state: "uncertain", stage: "frame_validation", reason: "target_or_frame_mismatch", diagnostic: { targetFound: true, frameConfirmed: false, readOnly: true, chatPageCount: chatPages.length } };
      }
      let visibleCheckSucceeded = true;
      const visible = Boolean(await evaluate(cdp, sessionId, messageVisibleScript(delivery.project_id, delivery.task_id, delivery.message_key)).catch(() => {
        visibleCheckSucceeded = false;
        return false;
      }));
      if (visible) {
        if (this.runtime.bridgeUncertainMessageKey === delivery.message_key) this.runtime.bridgeUncertainMessageKey = null;
        return { state: "delivered", stage: "page_confirmation", diagnostic: { targetFound: true, frameConfirmed: true, messageVisible: true, readOnly: true, chatPageCount: chatPages.length } };
      }
      let pageStateCheckSucceeded = true;
      const pageState = await evaluate(cdp, sessionId, composerSendStateScript(delivery.message_key)).catch(() => {
        pageStateCheckSucceeded = false;
        return null;
      });
      const diagnostic = {
        targetFound: true,
        frameConfirmed: true,
        messageVisible: false,
        readOnly: true,
        chatPageCount: chatPages.length,
        composerFound: pageState?.composerFound === true,
        composerEmpty: pageState?.composerEmpty === true,
        composerHasMessageKey: pageState?.composerHasMessageKey === true,
        sendEnabled: pageState?.sendEnabled === true,
        sendControlFound: pageState?.sendControlFound === true,
        sendControlDisabled: pageState?.sendControlDisabled === true,
        submitting: pageState?.submitting === true,
        staleStopControl: pageState?.staleStopControl === true,
        visibleErrors: Number.isInteger(pageState?.visibleErrors) ? pageState.visibleErrors : null,
      };
      if (visibleCheckSucceeded && pageStateCheckSucceeded && pageState?.composerHasMessageKey && pageState.sendEnabled && !pageState.submitting && !pageState.staleStopControl && pageState.visibleErrors === 0) {
        if (this.runtime.bridgeUncertainMessageKey === delivery.message_key) this.runtime.bridgeUncertainMessageKey = null;
        return { state: "safe_draft", stage: "submission_state", diagnostic };
      }
      return {
        state: "uncertain",
        stage: pageStateCheckSucceeded ? "page_confirmation" : "submission_state",
        reason: !visibleCheckSucceeded ? "message_visibility_check_failed" : !pageStateCheckSucceeded ? "composer_state_check_failed" : pageState?.submitting ? "generating" : pageState?.staleStopControl ? "stale_stop_control" : pageState?.visibleErrors ? "visible_error" : pageState?.composerHasMessageKey && !pageState?.sendEnabled ? "draft_present_send_control_unavailable" : "message_not_visible_or_composer_mismatch",
        diagnostic,
      };
    } finally {
      cdp?.close();
    }
  }

  async sendMessage(envelope, message, wakeTarget = null, legacyBinding = false) {
    const config = this.getConfig();
    const target = wakeTarget == null ? null : normalizeWakeTarget(wakeTarget);
    const boundUrl = legacyBinding === true ? normalizeBridgeChatUrl(config.chatBridgeChatUrl ?? "") : null;
    const chatUrl = target?.url || boundUrl;
    if (!chatUrl) {
      // Refuse to guess. A delivery without an explicit conversation target may
      // only use the configured binding when the Site marked it as legacy.
      throw Object.assign(new Error("Chat Bridge has no wake target for this delivery: the Site did not provide a navigable ChatGPT conversation URL and this delivery is not an explicit legacy binding."), { code: "bridge_wake_target_required" });
    }
    if (this.runtime.bridgeLastMessageKey === envelope.messageKey && this.runtime.bridgeLastSentAt) {
      return { ok: true, deduplicated: true, ...this.status() };
    }
    if (this.runtime.bridgeUncertainMessageKey === envelope.messageKey) {
      throw Object.assign(new Error("Chat Bridge is holding this MESSAGE_KEY for manual confirmation after an ambiguous submit state."), { code: "bridge_send_uncertain" });
    }

    this.runtime.bridgeState = "sending";
    this.runtime.bridgeLastError = null;
    let cdp;
    let submissionAttempted = false;
    let messageConfirmed = false;
    let clicked = false;
    const submitDiagnostic = {
      stage: "target_location",
      draftRetained: false,
      draftInsertions: 0,
      composerHasMessageKey: false,
      sendControlFound: false,
      sendControlEnabled: false,
      submitAttempted: false,
      messageVisible: false,
      manualInterventionRequired: false,
    };
    try {
      const { version } = await this.ensureBrowser({ allowLaunch: false });
      cdp = this.cdpFactory(version.webSocketDebuggerUrl);
      await cdp.open();

      const targets = await cdp.send("Target.getTargets");
      const pageTargets = (targets.targetInfos || []).filter((info) => info.type === "page");
      const chatTargets = pageTargets.filter((info) => chatPageUrl(info.url));
      // Reuse only a tab that already IS this conversation. Anything else — an
      // unrelated chat, the ChatGPT home page, a blank tab — must never be
      // adopted and never be navigated: another conversation's tab may hold an
      // unsent draft the user typed, and the old "single tab" / "home page"
      // fallback silently destroyed exactly that. Instead we open one new tab
      // for the delivery, so every other tab is left exactly as it was.
      let target = chatTargets
        .filter((info) => sameTargetConversation(info.url, chatUrl))
        .sort((a, b) => a.targetId.localeCompare(b.targetId))[0];
      let createdTarget = false;
      if (!target) {
        const created = await cdp.send("Target.createTarget", { url: chatUrl });
        target = { targetId: created.targetId, url: chatUrl, type: "page" };
        createdTarget = true;
      }
      const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);

      // Strict target validation, fail closed. A reused tab already matched, but
      // it may have navigated since we listed it; a created tab has to commit to
      // the conversation while its SPA loads. Either way the tab we are about to
      // type into must report the requested conversation id/group on the allowed
      // HTTPS host, or the ChatGPT login wall (which the composer wait below
      // turns into `bridge_login_required`).
      const targetBindDeadline = Date.now() + TARGET_BIND_WAIT_MS;
      await waitForConversationTarget(cdp, target, chatUrl, targetBindDeadline);
      const initialFrameTree = await cdp.send("Page.getFrameTree", {}, sessionId);
      const mainFrameId = initialFrameTree?.frameTree?.frame?.id || null;

      const alreadyVisible = Boolean(await evaluate(
        cdp,
        sessionId,
        messageVisibleScript(envelope.projectId, envelope.taskId, envelope.messageKey),
      ).catch(() => false));
      if (alreadyVisible) {
        this.runtime.bridgeState = "sent";
        this.runtime.bridgeLastEventId = envelope.eventId || null;
        this.runtime.bridgeLastMessageKey = envelope.messageKey;
        this.runtime.bridgeLastSentAt = new Date().toISOString();
        this.runtime.bridgeLastError = null;
        return { ok: true, deduplicated: true, ...this.status() };
      }

      const deadline = Date.now() + 20_000;
      await waitForComposer(cdp, sessionId, { deadline, expectedUrl: chatUrl, target });
      this.logger?.debug?.("deepseek-worker chat bridge: target_reused=%s target_created=%s", !createdTarget, createdTarget);

      // Somebody else's unsent draft must survive this delivery untouched. If the
      // composer holds text that is not this delivery's MESSAGE_KEY, we never
      // clear it, never overwrite it and never submit it: the delivery fails
      // closed with the draft retained. A single read can catch the editor
      // mid-re-render, so the condition has to hold for several reads before it
      // is treated as a real human draft.
      const draftPreflightDeadline = Date.now() + 3_000;
      let foreignDraftReads = 0;
      while (Date.now() < draftPreflightDeadline) {
        const preflight = await evaluate(cdp, sessionId, composerSendStateScript(envelope.messageKey)).catch(() => null);
        if (preflight?.composerFound !== true) {
          foreignDraftReads = 0;
        } else if (preflight.composerHasMessageKey === true || preflight.composerEmpty === true) {
          break;
        } else {
          foreignDraftReads += 1;
          if (foreignDraftReads >= FOREIGN_DRAFT_CONFIRMATIONS) {
            submitDiagnostic.stage = "composer_insertion";
            submitDiagnostic.draftRetained = true;
            this.logger?.warn?.("deepseek-worker chat bridge: composer already holds an unrelated draft; leaving it untouched and not submitting");
            throw withSubmitDiagnostic(Object.assign(new Error(
              "Chat Bridge found an existing unsent draft in the target composer; it was left untouched and nothing was submitted.",
            ), { code: "bridge_composer_draft_present" }), submitDiagnostic);
          }
        }
        await delay(FOREIGN_DRAFT_POLL_MS);
      }

      // The composer is present, but a freshly opened conversation keeps
      // hydrating after the first paint: React re-renders the editor, drops the
      // focus and re-mounts the toolbar. Wait for the composer rect to settle
      // before inserting, then keep re-verifying the draft while the toolbar
      // stabilizes. A draft that is dropped by a re-render is re-inserted, which
      // is safe because nothing has been submitted yet at this point.
      const controlDeadline = Date.now() + SEND_CONTROL_WAIT_MS;
      const controlFloor = Date.now() + SEND_CONTROL_MIN_WAIT_MS;
      let sendControl = null;
      let stableFingerprint = null;
      let stableCount = 0;
      let negativeFingerprint = null;
      let negativeCount = 0;
      let draftInsertions = 0;
      let composerHasKey = false;
      while (Date.now() < controlDeadline) {
        const contains = await evaluate(cdp, sessionId, composerContainsMessageScript(envelope.messageKey)).catch(() => null);
        composerHasKey = contains?.ok === true;
        if (!composerHasKey) {
          if (draftInsertions < MAX_DRAFT_INSERTIONS) {
            await evaluate(cdp, sessionId, composerFocusScript()).catch(() => null);
            await cdp.send("Input.insertText", { text: message }, sessionId);
            draftInsertions += 1;
            stableFingerprint = null;
            stableCount = 0;
            await delay(150);
            continue;
          }
          break;
        }
        sendControl = await evaluate(cdp, sessionId, sendButtonMetadataScript()).catch(() => null);
        const chosen = sendControl?.chosen;
        if (chosen && chosen.metadata?.disabled !== true && chosen.metadata?.hitMatchesButton === true) {
          // Never click while the conversation is still generating or while a
          // stale Stop control is on screen: the toolbar is in a transitional
          // state and the click could land on the wrong affordance.
          const state = await evaluate(cdp, sessionId, composerSendStateScript(envelope.messageKey)).catch(() => null);
          if (state?.submitting || state?.staleStopControl) {
            stableFingerprint = null;
            stableCount = 0;
            await delay(SEND_CONTROL_POLL_MS);
            continue;
          }
          const fingerprint = JSON.stringify({
            selector: chosen.selector,
            x: Math.round(chosen.x),
            y: Math.round(chosen.y),
            disabled: chosen.metadata?.disabled,
          });
          stableCount = fingerprint === stableFingerprint ? stableCount + 1 : 1;
          stableFingerprint = fingerprint;
          negativeFingerprint = null;
          negativeCount = 0;
          if (stableCount >= SEND_CONTROL_STABLE_READS) break;
        } else {
          stableFingerprint = null;
          stableCount = 0;
          const negative = JSON.stringify({
            buttonCount: sendControl?.buttonCount ?? null,
            composer: sendControl?.composerRect ?? null,
            candidates: (sendControl?.candidates || []).map((item) => [item.dataTestId, item.ariaLabel, item.disabled, item.visible, item.nearComposer, item.hitMatchesButton, item.forbidden]),
          });
          negativeCount = negative === negativeFingerprint ? negativeCount + 1 : 1;
          negativeFingerprint = negative;
          // Only stop early once the toolbar has been provably unchanged for
          // several reads past the floor; a page that is still hydrating keeps
          // changing its fingerprint and keeps us waiting.
          if (Date.now() >= controlFloor && negativeCount >= SEND_CONTROL_STABLE_NEGATIVE_READS) break;
        }
        await delay(SEND_CONTROL_POLL_MS);
      }
      if (sendControl && this.logger?.debug) {
        this.logger.debug("deepseek-worker chat bridge: safe send-control metadata %j", {
          buttonCount: sendControl.buttonCount,
          selectorMatches: sendControl.selectorMatches,
          candidates: sendControl.candidates,
        });
      }
      submitDiagnostic.composerHasMessageKey = composerHasKey;
      submitDiagnostic.draftInsertions = draftInsertions;
      submitDiagnostic.sendControlFound = Boolean(sendControl?.candidates?.length);
      submitDiagnostic.sendControlEnabled = Boolean(sendControl?.chosen);
      if (!composerHasKey) {
        submitDiagnostic.stage = "composer_insertion";
        submitDiagnostic.draftRetained = false;
        this.logger?.warn?.("deepseek-worker chat bridge: draft was not retained in the composer after %d insertions; nothing was submitted", draftInsertions);
        throw withSubmitDiagnostic(Object.assign(new Error(
          "Chat Bridge could not keep this delivery's MESSAGE_KEY in the composer, so nothing was submitted and the delivery can be retried safely.",
        ), { code: "bridge_draft_not_inserted" }), submitDiagnostic);
      }
      if (!sendControl?.chosen) {
        // No eligible control: keep the verified draft and stop. The previous
        // blind Enter fallback left the draft unsent anyway and made the outcome
        // ambiguous, so the delivery is now reported as a retained safe draft
        // and the Outbox performs at most one bounded, verified recovery.
        submitDiagnostic.stage = "submission_state";
        submitDiagnostic.draftRetained = true;
        this.logger?.warn?.("deepseek-worker chat bridge: no safe send control; draft retained without a blind Enter fallback; targetId=%s frameId=%s candidates=%d", target.targetId, mainFrameId || "(unknown)", sendControl?.candidates?.length || 0);
        throw withSubmitDiagnostic(Object.assign(new Error(
          "Chat Bridge found no safe, clickable send control; the verified MESSAGE_KEY draft was left untouched in the composer and no blind Enter fallback was used.",
        ), { code: "bridge_send_not_submitted" }), submitDiagnostic);
      }
      {
        const clickTargetUrl = await currentTargetUrl(cdp, target);
        const clickFrameTree = await cdp.send("Page.getFrameTree", {}, sessionId);
        const clickFrameId = clickFrameTree?.frameTree?.frame?.id || null;
        if (!sameConversationUrl(clickTargetUrl, chatUrl) || (mainFrameId && clickFrameId !== mainFrameId)) {
          throw Object.assign(new Error("Chat Bridge target or main frame changed before send; preserving the verified composer draft."), { code: "bridge_target_changed_before_send" });
        }
        const { x, y } = sendControl.chosen;
        try {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
          submissionAttempted = true;
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
          clicked = true;
        } catch (error) {
          this.logger?.debug?.("deepseek-worker chat bridge: CDP send-button click failed (%s)", error instanceof Error ? error.message : "unknown error");
          throw withSubmitDiagnostic(Object.assign(new Error(
            "Chat Bridge could not deliver the verified click to the send control; holding this MESSAGE_KEY instead of using an unverified fallback.",
          ), { code: "bridge_send_uncertain", cause: error }), submitDiagnostic);
        }
      }
      submitDiagnostic.submitAttempted = true;
      this.logger?.debug?.("deepseek-worker chat bridge: target_url_matched=true composer_found=true composer_focused=true insert_succeeded=true composer_contains_message_key=true send_button_appeared=%s send_button_enabled=%s cdp_mouse_click_executed=%s", Boolean(sendControl?.candidates?.length), Boolean(sendControl?.chosen), clicked);

      let visible = false;
      let sendState = null;
      for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
        await delay(CONFIRMATION_INTERVAL_MS);
        visible = Boolean(await evaluate(cdp, sessionId, messageVisibleScript(envelope.projectId, envelope.taskId, envelope.messageKey)).catch(() => false));
        if (visible) break;
        sendState = await evaluate(cdp, sessionId, composerSendStateScript(envelope.messageKey)).catch(() => null);
        if (sendState?.submitting || !sendState?.composerHasMessageKey) break;
      }
      submitDiagnostic.messageVisible = visible;
      if (!visible) {
        // Confirmation timed out. Never submit again here: an empty composer or a
        // live Stop control means the wake may already be in flight, so the
        // MESSAGE_KEY is held for read-only reconciliation instead.
        const uncertain = Boolean(sendState?.submitting || !sendState?.composerHasMessageKey || !sendState?.sendEnabled);
        if (uncertain) {
          this.runtime.bridgeUncertainMessageKey = envelope.messageKey;
          submitDiagnostic.stage = "page_confirmation";
          submitDiagnostic.draftRetained = sendState?.composerHasMessageKey === true;
          submitDiagnostic.manualInterventionRequired = true;
          this.logger?.warn?.("deepseek-worker chat bridge: send outcome uncertain; targetId=%s frameId=%s composerHasMessageKey=%s sendEnabled=%s submitting=%s", target.targetId, mainFrameId || "(unknown)", Boolean(sendState?.composerHasMessageKey), Boolean(sendState?.sendEnabled), Boolean(sendState?.submitting));
          throw withSubmitDiagnostic(Object.assign(new Error("Chat Bridge could not confirm the sent message and the page state may indicate submission; holding this MESSAGE_KEY to prevent a duplicate."), { code: "bridge_send_uncertain" }), submitDiagnostic);
        }
        submitDiagnostic.stage = "submission_state";
        submitDiagnostic.draftRetained = true;
        this.logger?.warn?.("deepseek-worker chat bridge: safe draft retained; targetId=%s frameId=%s composerHasMessageKey=true sendEnabled=true submitting=false", target.targetId, mainFrameId || "(unknown)");
        throw withSubmitDiagnostic(Object.assign(new Error("Chat Bridge did not confirm submission; the MESSAGE_KEY remains in a ready composer as an unsent draft."), { code: "bridge_send_not_submitted" }), submitDiagnostic);
      }
      messageConfirmed = true;
      this.logger?.debug?.("deepseek-worker chat bridge: sent_message_confirmed=true");

      this.runtime.bridgeState = "sent";
      this.runtime.bridgeLastEventId = envelope.eventId || null;
      this.runtime.bridgeLastMessageKey = envelope.messageKey;
      this.runtime.bridgeUncertainMessageKey = null;
      this.runtime.bridgeLastSentAt = new Date().toISOString();
      this.runtime.bridgeLastError = null;
      submitDiagnostic.stage = "page_confirmation";
      submitDiagnostic.messageVisible = true;
      submitDiagnostic.manualInterventionRequired = false;
      this.runtime.bridgeLastSubmitDiagnostic = Object.freeze({ ...submitDiagnostic });
      return { ok: true, deduplicated: false, ...this.status() };
    } catch (error) {
      let failure = error;
      if (submissionAttempted && !messageConfirmed && failure?.code !== "bridge_send_uncertain" && failure?.code !== "bridge_send_not_submitted") {
        failure = Object.assign(new Error("Chat Bridge lost a reliable result after the submit action; holding MESSAGE_KEY for reconciliation to prevent duplicate delivery."), { code: "bridge_send_uncertain" });
      }
      if (failure?.code === "bridge_send_uncertain") submitDiagnostic.manualInterventionRequired = true;
      failure = withSubmitDiagnostic(failure, submitDiagnostic);
      this.runtime.bridgeLastSubmitDiagnostic = Object.freeze({ ...submitDiagnostic });
      this.runtime.bridgeState = failure?.code === "bridge_login_required" ? "needs-login" : failure?.code === "bridge_send_uncertain" ? "uncertain" : "error";
      if (failure?.code === "bridge_send_uncertain") this.runtime.bridgeUncertainMessageKey = envelope.messageKey;
      this.runtime.bridgeLastError = failure instanceof Error ? failure.message : String(failure);
      this.logger?.warn?.("deepseek-worker chat bridge: %s", this.runtime.bridgeLastError);
      throw failure;
    } finally {
      cdp?.close();
    }
  }
}
