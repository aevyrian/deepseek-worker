import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WorkerControlService, { processLease } from "../../index.js";
import { TaskNotificationStore } from "../../lib/task-notifications.mjs";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

const directory = await mkdtemp(join(tmpdir(), "dsw-worker-notifications-"));
const notificationsPath = join(directory, "task-notifications.json");
process.env.DEEPSEEK_WORKER_TASK_NOTIFICATIONS_PATH = notificationsPath;

const originalFetch = globalThis.fetch;
const requests = [];
let resultRejected = 0;
let failureRejected = 0;

class HostContext {
  constructor() {
    this.reflect = { props: {} };
    this.services = new Map();
    this.cleanups = [];
    this.listeners = new Map();
    this.logger = { info() {}, warn() {}, error() {} };
    this.workspaceRegistry = {
      list: () => [{ id: "workspace-a", path: "E:\\Project", sessionIds: [] }],
      get: (id) => (id === "workspace-a" ? { id: "workspace-a", path: "E:\\Project", sessionIds: [] } : undefined),
    };
    this.credentials = {
      async resolve() { return undefined; },
      async describe() { return { configured: false, writable: true }; },
    };
    this.registerService("workspaceRegistry", this.workspaceRegistry);
    this.registerService("credentials", this.credentials);
  }

  registerService(key, value) {
    this.reflect.props[key] = { type: "service" };
    this.services.set(key, value);
  }

  get(key) {
    return this.services.get(key);
  }

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args);
  }

  effect(setup) {
    const cleanup = setup();
    if (typeof cleanup === "function") this.cleanups.push(cleanup);
    return cleanup;
  }

  async dispose() {
    for (const cleanup of this.cleanups.reverse()) await cleanup();
  }
}

function gatewayDiscover(ctx, namespace, method) {
  const candidates = [];
  for (const [serviceKey, definition] of Object.entries(ctx.reflect.props)) {
    if (definition.type !== "service") continue;
    const receiver = ctx.get(serviceKey);
    if (receiver === undefined || receiver === null || typeof receiver !== "object") continue;
    const binding = receiver.typertRemote;
    if (!binding || binding.namespace !== namespace) continue;
    const marker = remoteMethods(receiver).find((candidate) => (candidate.exportName ?? candidate.method) === method);
    if (marker !== undefined) candidates.push({ serviceKey, receiver, marker, binding });
  }
  if (candidates.length !== 1) {
    throw new Error(`Gateway discovery expected one ${namespace}/${method} candidate, got ${candidates.length}`);
  }
  return candidates[0];
}

async function gatewayInvoke(ctx, namespace, method, ...args) {
  const found = gatewayDiscover(ctx, namespace, method);
  const implementation = found.marker.method;
  return await Reflect.apply(found.receiver[implementation], found.receiver, args);
}

function notificationCalls(ctx) {
  const remote = gatewayDiscover(ctx, "deepseekWorkerConnector", "taskNotifications");
  const mark = gatewayDiscover(ctx, "deepseekWorkerConnector", "markTaskNotificationsRead");
  return {
    read: () => Reflect.apply(remote.receiver[remote.marker.method], remote.receiver, []),
    markRead: (options) => Reflect.apply(mark.receiver[mark.marker.method], mark.receiver, [options]),
  };
}

const ctx = new HostContext();
let resultStatus = 200;
let failureStatus = 200;
let executionFails = false;
let assistantText = "done";

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const body = JSON.parse(String(init.body || "{}"));
  requests.push({ path: parsed.pathname, body });
  const status = parsed.pathname.endsWith("/result") ? resultStatus
    : parsed.pathname.endsWith("/failure") ? failureStatus : 200;
  if (status >= 400) {
    if (parsed.pathname.endsWith("/result")) resultRejected += 1;
    else if (parsed.pathname.endsWith("/failure")) failureRejected += 1;
  }
  return new Response(JSON.stringify({ ok: true, project_id: "project-1" }), {
    status,
    headers: { "content-type": "application/json" },
  });
};

const service = new WorkerControlService(ctx, {
  endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
  workerId: "worker-test",
  authorizedWorkspaceIds: ["workspace-a"],
  trustedWorkspaceMode: true,
  chatBridgeEnabled: false,
});

const config = {
  endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
  workerId: "worker-test",
  authorizedWorkspaceIds: ["workspace-a"],
  trustedWorkspaceMode: true,
  chatBridgeEnabled: false,
  leaseRenewIntervalMs: 5000,
  leaseWaitTimeoutMs: 1000,
};

function installSessionController() {
  const sessions = new Map();
  let counter = 0;
  ctx.registerService("sessionController", {
    async create() {
      if (executionFails) throw new Error("Native Session failed: C:\\Users\\Aevyr\\secret.txt token=abcdef0123456789");
      counter += 1;
      const sessionId = `session-${counter}`;
      sessions.set(sessionId, { session: { events: [], snapshotEvents() { return [...this.events]; } } });
      return { sessionId };
    },
    async resolveAgent(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return { error: new Error(`unknown session ${sessionId}`) };
      return { agent: { session: entry.session } };
    },
    async prompt(request) {
      const entry = sessions.get(request.sessionId);
      const assistant = { type: "assistant/message", seq: 1, data: { message: { content: [{ type: "text", text: assistantText }] } } };
      const turnEnd = { type: "turn/end", seq: 2, data: { reason: "completed" } };
      entry.session.events.push(assistant, turnEnd);
      queueMicrotask(() => ctx.emit("session/event", entry.session, turnEnd));
      return { accepted: true };
    },
  });
}

installSessionController();
const notifications = notificationCalls(ctx);
const results = {};

try {
  results.discovered = ["taskNotifications", "markTaskNotificationsRead"].map((method) => {
    const found = gatewayDiscover(ctx, "deepseekWorkerConnector", method);
    return { method, serviceKey: found.serviceKey, isService: found.receiver === service };
  });

  const initial = await notifications.read();
  results.initial = initial;

  assistantText = "Installed dependencies and ran the unit suite: 285 tests passed. See C:\\Users\\Aevyr\\AppData\\Local\\DeepSeekWorker\\report.json and https://chatgpt.com/c/6a1b2c3d-4e5f with Authorization: Bearer abcdef1234567890";
  await processLease(ctx, config, "worker-token", { id: "task-completed", workspace_id: "workspace-a", prompt: "run the suite" }, new AbortController().signal, null);

  const afterCompleted = await notifications.read();
  results.afterCompleted = afterCompleted;

  // Replay the same terminal upload: one row, still unread, unchanged timestamp.
  await processLease(ctx, config, "worker-token", { id: "task-completed", workspace_id: "workspace-a", prompt: "run the suite" }, new AbortController().signal, null);
  results.afterReplay = await notifications.read();

  executionFails = true;
  await processLease(ctx, config, "worker-token", { id: "task-failed", workspace_id: "workspace-a", prompt: "explode" }, new AbortController().signal, null);
  results.afterFailure = await notifications.read();

  // A failed Cloud upload must never masquerade as a local terminal.
  executionFails = false;
  resultStatus = 503;
  await processLease(ctx, config, "worker-token", { id: "task-result-upload-failed", workspace_id: "workspace-a", prompt: "upload fails" }, new AbortController().signal, null);
  resultStatus = 200;

  executionFails = true;
  failureStatus = 503;
  await processLease(ctx, config, "worker-token", { id: "task-failure-upload-failed", workspace_id: "workspace-a", prompt: "failure upload fails" }, new AbortController().signal, null);
  failureStatus = 200;
  executionFails = false;
  results.afterFailedUploads = await notifications.read();

  // Mark one key read, then everything else.
  const target = results.afterCompleted.items.find((item) => item.taskId === "task-completed");
  results.markOne = await notifications.markRead({ keys: [target.key] });
  results.afterMarkOne = await notifications.read();
  results.markInvalid = await notifications.markRead({ keys: ["../../etc/passwd", 7, null, "ntf-not-a-key"] });
  results.markAll = await notifications.markRead();
  results.afterMarkAll = await notifications.read();
  results.markAllAgain = await notifications.markRead();

  // Simulated restart: a second service instance reads the same durable file.
  const restarted = new TaskNotificationStore({ filePath: notificationsPath });
  await restarted.initialize();
  await restarted.recordTerminal({ taskId: "task-before-restart", terminalState: "completed", summary: "recorded before the Connector restarted", at: "2026-10-09T07:00:00.000Z" });
  const secondCtx = new HostContext();
  const secondService = new WorkerControlService(secondCtx, {
    endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
    workerId: "worker-test",
    authorizedWorkspaceIds: ["workspace-a"],
    trustedWorkspaceMode: true,
    chatBridgeEnabled: false,
  });
  results.afterRestart = await gatewayInvoke(secondCtx, "deepseekWorkerConnector", "taskNotifications");
  results.afterRestartMark = await gatewayInvoke(secondCtx, "deepseekWorkerConnector", "markTaskNotificationsRead", { keys: [] });
  await secondCtx.dispose();
  results.secondServiceAlive = secondService.name;

  const raw = await readFile(notificationsPath, "utf8");
  results.fileContainsPrompt = raw.includes("run the suite") || raw.includes("explode");
  results.fileContainsPath = raw.includes("C:\\Users\\Aevyr");
  results.fileContainsConversation = raw.includes("chatgpt.com/c/6a1b2c3d");
  results.fileContainsSecret = raw.includes("abcdef1234567890") || raw.includes("Bearer abcdef");
  results.fileContainsWorkspace = raw.includes("workspace-a");
  results.fileBytes = Buffer.byteLength(raw, "utf8");
  results.cloudResultUploads = requests.filter((request) => request.path.endsWith("/result")).length;
  results.cloudFailureUploads = requests.filter((request) => request.path.endsWith("/failure")).length;
  results.resultRejected = resultRejected;
  results.failureRejected = failureRejected;
  results.cloudPollingRoutes = requests.filter((request) => !/^\/(?:api\/worker\/)?(?:result|failure)$/u.test(request.path)).map((request) => request.path);
  results.rawSummary = JSON.parse(raw).items.find((item) => item.taskId === "task-completed")?.summary ?? null;
} finally {
  globalThis.fetch = originalFetch;
  await ctx.dispose();
  await rm(directory, { recursive: true, force: true });
  delete process.env.DEEPSEEK_WORKER_TASK_NOTIFICATIONS_PATH;
}

process.stdout.write(JSON.stringify(results));
