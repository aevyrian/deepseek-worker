import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DEBUG_PORT = 9223;
const MAX_MESSAGE_BYTES = 900;
const CHAT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);
const ALLOWED_EVENT_NAMES = new Set(["task.completed", "task.failed"]);

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
  return Object.freeze({
    enabled: config.chatBridgeEnabled !== false,
    bound: Boolean(chatUrl),
    browser: runtime.bridgeBrowser || "unknown",
    state: bindingError ? "invalid-binding" : (runtime.bridgeState || (chatUrl ? "idle" : "unbound")),
    lastEventId: runtime.bridgeLastEventId || null,
    lastMessageKey: runtime.bridgeLastMessageKey || null,
    lastSentAt: runtime.bridgeLastSentAt || null,
    lastError: bindingError || runtime.bridgeLastError || null,
  });
}

export function bridgeReady(runtime = {}, config = {}) {
  const state = bridgePublicState(runtime, config);
  return state.enabled && state.bound && state.browser !== "unavailable";
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

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open(timeoutMs = 10_000) {
    if (typeof WebSocket !== "function") throw new Error("Node WebSocket runtime is unavailable");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
      }),
      delay(timeoutMs).then(() => { throw new Error("CDP WebSocket connection timed out"); }),
    ]);
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

async function fetchJson(url, timeoutMs = 2500) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Browser debugging endpoint returned HTTP ${response.status}`);
  return response.json();
}

async function waitForDebugEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (typeof version?.webSocketDebuggerUrl === "string") return version;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error("Chat Bridge browser did not expose a debugging endpoint");
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (result?.exceptionDetails) throw new Error("Chat Bridge page script failed");
  return result?.result?.value;
}

function composerFocusScript() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const selectors = [
      '#prompt-textarea',
      'textarea[data-testid*="prompt"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="消息"]',
      'main [contenteditable="true"]',
      '[contenteditable="true"][data-lexical-editor="true"]'
    ];
    let el = null;
    for (const selector of selectors) {
      el = [...document.querySelectorAll(selector)].filter(visible).at(-1);
      if (el) break;
    }
    if (!el) return { ok: false, reason: 'composer_not_found', href: location.href };
    el.focus();
    return { ok: true, tag: el.tagName, href: location.href };
  })()`;
}

function sendButtonScript() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && !el.disabled;
    };
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="发送"]'
    ];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)].filter(visible).at(-1);
      if (button) { button.click(); return true; }
    }
    return false;
  })()`;
}

export function messageVisibleScript(projectId, taskId, messageKey) {
  const project = JSON.stringify(projectId);
  const task = JSON.stringify(taskId);
  const key = JSON.stringify(messageKey);
  return `(() => {
    const text = document.body?.innerText || '';
    return text.includes('PROJECT_ID: ' + ${project}) && text.includes('TASK_ID: ' + ${task}) && text.includes('MESSAGE_KEY: ' + ${key});
  })()`;
}

function loginStateScript() {
  return `(() => {
    const href = location.href;
    const text = (document.body?.innerText || '').toLowerCase();
    const authPath = /\/auth\/(login|signin|sign-up|signup)(\/|$)/iu.test(location.pathname);
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

async function cdpPage(cdp, url) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  let target = targetInfos.find((info) => info.type === "page" && chatPageUrl(info.url));
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
  constructor({ runtime, getConfig, logger, cdpFactory } = {}) {
    this.runtime = runtime || {};
    this.getConfig = typeof getConfig === "function" ? getConfig : () => ({});
    this.logger = logger;
    this.cdpFactory = cdpFactory || ((url) => new CdpConnection(url));
    this.browserChild = null;
  }

  status() {
    return bridgePublicState(this.runtime, this.getConfig());
  }

  async ensureBrowser({ openHome = false } = {}) {
    const config = this.getConfig();
    if (config.chatBridgeEnabled === false) throw new Error("Chat Bridge is disabled");
    const port = Number(config.chatBridgeDebugPort ?? DEFAULT_DEBUG_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Chat Bridge debug port");

    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (version?.webSocketDebuggerUrl) {
        this.runtime.bridgeBrowser = "online";
        return { port, version };
      }
    } catch {}

    const executable = findChromiumExecutable();
    if (!executable) {
      this.runtime.bridgeBrowser = "unavailable";
      this.runtime.bridgeLastError = "未找到 Microsoft Edge / Google Chrome / Chromium。";
      throw new Error(this.runtime.bridgeLastError);
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${bridgeProfileDir()}`,
      "--no-first-run",
      "--no-default-browser-check",
      openHome ? "https://chatgpt.com/" : "about:blank",
    ];
    const child = spawn(executable, args, {
      detached: false,
      windowsHide: false,
      stdio: "ignore",
    });
    child.unref?.();
    this.browserChild = child;
    const version = await waitForDebugEndpoint(port);
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
      this.runtime.bridgeState = normalizeBridgeChatUrl(this.getConfig().chatBridgeChatUrl ?? "") ? "idle" : "unbound";
      this.runtime.bridgeLastError = null;
      return this.status();
    } finally {
      cdp.close();
    }
  }

  async testBridge() {
    const chatUrl = normalizeBridgeChatUrl(this.getConfig().chatBridgeChatUrl ?? "");
    if (!chatUrl) throw new Error("Chat Bridge 尚未绑定 ChatGPT 对话。");
    this.runtime.bridgeState = "checking";
    this.runtime.bridgeLastError = null;
    let cdp;
    try {
      const { version } = await this.ensureBrowser({ openHome: false });
      cdp = this.cdpFactory(version.webSocketDebuggerUrl);
      await cdp.open();
      const { target, sessionId } = await cdpPage(cdp, "https://chatgpt.com/");
      await restoreAndActivate(cdp, target.targetId);
      const deadline = Date.now() + 20_000;
      let page = await evaluate(cdp, sessionId, loginStateScript()).catch(() => null);
      if (page?.authRequired) {
        this.runtime.bridgeState = "needs-login";
        throw Object.assign(new Error("需要登录 ChatGPT：请在桥接浏览器中登录后重试。"), { code: "bridge_login_required" });
      }
      if (!page || !sameChatUrl(page.href, chatUrl)) {
        await cdp.send("Page.navigate", { url: chatUrl }, sessionId);
        while (Date.now() < deadline) {
          page = await evaluate(cdp, sessionId, loginStateScript()).catch(() => null);
          if (page?.authRequired) {
            this.runtime.bridgeState = "needs-login";
            throw Object.assign(new Error("需要登录 ChatGPT：请在桥接浏览器中登录后重试。"), { code: "bridge_login_required" });
          }
          if (page && sameChatUrl(page.href, chatUrl)) break;
          await delay(300);
        }
      }
      if (!page || !sameChatUrl(page.href, chatUrl)) throw new Error("绑定的 ChatGPT 对话无法访问。");

      let focus = null;
      while (Date.now() < deadline) {
        const auth = await evaluate(cdp, sessionId, loginStateScript()).catch(() => null);
        if (auth?.authRequired) {
          this.runtime.bridgeState = "needs-login";
          throw Object.assign(new Error("需要登录 ChatGPT：请在桥接浏览器中登录后重试。"), { code: "bridge_login_required" });
        }
        if (!auth || !sameChatUrl(auth.href, chatUrl)) {
          await delay(300);
          continue;
        }
        focus = await evaluate(cdp, sessionId, composerFocusScript()).catch(() => null);
        if (focus?.ok && sameChatUrl(focus.href, chatUrl)) break;
        await delay(300);
      }
      if (!focus?.ok) throw new Error("绑定对话已打开，但未找到可用的 ChatGPT 输入框。");
      if (!sameChatUrl(focus.href, chatUrl)) throw new Error("绑定的 ChatGPT 对话无法访问。");
      this.runtime.bridgeState = "ready";
      this.runtime.bridgeLastError = null;
      return { ok: true, ...this.status() };
    } catch (error) {
      if (error?.code !== "bridge_login_required") {
        this.runtime.bridgeState = "error";
        this.runtime.bridgeLastError = error instanceof Error ? error.message : String(error);
      } else {
        this.runtime.bridgeLastError = error.message;
      }
      throw error;
    } finally {
      cdp?.close();
    }
  }

  async sendEnvelope(rawEnvelope) {
    const envelope = normalizeBridgeEnvelope(rawEnvelope);
    const message = buildCloudBridgeControlMessage(rawEnvelope);
    return this.sendMessage(envelope, message);
  }

  async sendLocalWake(delivery) {
    const { buildLocalWakeMessage } = await import("./bridge-outbox.mjs");
    const message = buildLocalWakeMessage(delivery);
    const envelope = {
      projectId: delivery.project_id,
      taskId: delivery.task_id,
      messageKey: delivery.message_key,
    };
    return this.sendMessage(envelope, message);
  }

  async sendMessage(envelope, message) {
    const config = this.getConfig();
    const chatUrl = normalizeBridgeChatUrl(config.chatBridgeChatUrl ?? "");
    if (!chatUrl) throw new Error("Chat Bridge has no bound ChatGPT chat URL");
    if (this.runtime.bridgeLastMessageKey === envelope.messageKey && this.runtime.bridgeLastSentAt) {
      return { ok: true, deduplicated: true, ...this.status() };
    }

    this.runtime.bridgeState = "sending";
    this.runtime.bridgeLastError = null;
    let cdp;
    try {
      const { version } = await this.ensureBrowser();
      cdp = new CdpConnection(version.webSocketDebuggerUrl);
      await cdp.open();

      const targets = await cdp.send("Target.getTargets");
      let target = (targets.targetInfos || []).find((info) => (
        info.type === "page" && typeof info.url === "string" && CHAT_HOSTS.has((() => {
          try { return new URL(info.url).hostname.toLowerCase(); } catch { return ""; }
        })())
      ));
      if (!target) {
        const created = await cdp.send("Target.createTarget", { url: chatUrl });
        target = { targetId: created.targetId, url: chatUrl, type: "page" };
      }
      const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);

      if (target.url !== chatUrl) {
        await cdp.send("Page.navigate", { url: chatUrl }, sessionId);
        await delay(1200);
      }

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

      let focus = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        focus = await evaluate(cdp, sessionId, composerFocusScript()).catch(() => null);
        if (focus?.ok) break;
        await delay(500);
      }
      if (!focus?.ok) {
        this.runtime.bridgeState = "needs-login";
        throw new Error("ChatGPT 输入框不可用；请在桥接浏览器中登录 ChatGPT 并打开已绑定对话。");
      }

      await cdp.send("Input.insertText", { text: message }, sessionId);
      const clicked = await evaluate(cdp, sessionId, sendButtonScript()).catch(() => false);
      if (!clicked) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
      }

      let visible = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(250);
        visible = Boolean(await evaluate(cdp, sessionId, messageVisibleScript(envelope.projectId, envelope.taskId, envelope.messageKey)).catch(() => false));
        if (visible) break;
      }
      if (!visible) throw new Error("Chat Bridge 未确认控制消息已经出现在 ChatGPT 对话中。");

      this.runtime.bridgeState = "sent";
      this.runtime.bridgeLastEventId = envelope.eventId || null;
      this.runtime.bridgeLastMessageKey = envelope.messageKey;
      this.runtime.bridgeLastSentAt = new Date().toISOString();
      this.runtime.bridgeLastError = null;
      return { ok: true, deduplicated: false, ...this.status() };
    } catch (error) {
      this.runtime.bridgeState = this.runtime.bridgeState === "needs-login" ? "needs-login" : "error";
      this.runtime.bridgeLastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.("deepseek-worker chat bridge: %s", this.runtime.bridgeLastError);
      throw error;
    } finally {
      cdp?.close();
    }
  }
}