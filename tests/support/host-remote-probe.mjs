import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WorkerControlService, { processLease } from "../../index.js";
import { BridgeWakeOutbox } from "../../lib/bridge-outbox.mjs";
import { WakeCoordinator } from "../../lib/wake-coordinator.mjs";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

class HostContext {
  constructor() {
    this.reflect = { props: {} };
    this.services = new Map();
    this.cleanups = [];
    this.listeners = new Map();
    this.logger = { warn() {}, error() {} };
    this.workspaceRegistry = {
      list: () => [{ id: "workspace-a", path: "E:\\Project", sessionIds: [] }],
      get: (id) => id === "workspace-a"
        ? { id: "workspace-a", path: "E:\\Project", sessionIds: [] }
        : undefined,
    };

    let storedToken;
    this.credentials = {
      async resolve(ref) {
        assert.equal(ref, "LOCAL_WORKER_TOKEN");
        return storedToken === undefined ? undefined : { value: storedToken, source: "file" };
      },
      async describe(ref) {
        assert.equal(ref, "LOCAL_WORKER_TOKEN");
        return { configured: storedToken !== undefined, ...(storedToken === undefined ? {} : { source: "file" }), writable: true };
      },
      async set(ref, value) {
        assert.equal(ref, "LOCAL_WORKER_TOKEN");
        assert.equal(typeof value, "string");
        assert.match(value, /^[0-9a-f]{64}$/);
        storedToken = value;
      },
      async unset(ref) {
        assert.equal(ref, "LOCAL_WORKER_TOKEN");
        storedToken = undefined;
      },
      peek() { return storedToken; },
    };

    this.registerService("workspaceRegistry", this.workspaceRegistry);
    this.registerService("credentials", this.credentials);
    this.registerService("sessionController", {});
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
    for (const listener of this.listeners.get(name) ?? []) listener(...args);
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
    const marker = remoteMethods(receiver)
      .find((candidate) => (candidate.exportName ?? candidate.method) === method);
    if (marker !== undefined) candidates.push({ serviceKey, receiver, marker, binding });
  }
  if (candidates.length !== 1) {
    throw new Error(`Gateway discovery expected one ${namespace}/${method} candidate, got ${candidates.length}`);
  }
  return candidates[0];
}

async function gatewayInvoke(ctx, namespace, method) {
  const found = gatewayDiscover(ctx, namespace, method);
  const implementation = found.marker.method;
  return await Reflect.apply(found.receiver[implementation], found.receiver, []);
}

const ctx = new HostContext();
let pairingState = "pending";
let startMode = "ok";
let failureUploadStatus = 200;
const requests = [];
const originalFetch = globalThis.fetch;
const outboxDirectory = await mkdtemp(join(tmpdir(), "dsw-host-probe-"));
process.env.DEEPSEEK_WORKER_BRIDGE_WAKE_OUTBOX_PATH = join(outboxDirectory, "service-outbox.json");

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const body = JSON.parse(String(init.body || "{}"));
  requests.push({ url: parsed.href, path: parsed.pathname, headers: { ...(init.headers || {}) }, body });

  if (parsed.pathname === "/api/pair/start") {
    if (typeof startMode === "number") {
      return new Response(JSON.stringify({ error: "test_failure" }), {
        status: startMode,
        headers: { "content-type": "application/json" },
      });
    }
    if (startMode === "network") throw new Error("fetch failed");
    if (startMode === "unavailable") {
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(init.headers.authorization, undefined);
    assert.match(body.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(body.client_version, "0.7.1");
    assert.deepEqual(body.workspace_allowlist, ["workspace-a"]);
    return new Response(JSON.stringify({
      state: "pending",
      code: "PAIR-1234",
      approval_url: "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234",
      expires_at: "2026-10-05T11:00:00Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (parsed.pathname === "/api/pair/status") {
    const token = ctx.credentials.peek();
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    if (pairingState === "expired") {
      return new Response(JSON.stringify({ code: "pair_expired" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      state: pairingState,
      ...(pairingState === "pending" ? {
        code: "PAIR-1234",
        approval_url: "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234",
        expires_at: "2026-10-05T11:00:00Z",
      } : {}),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (parsed.pathname === "/api/pair/disconnect") {
    const token = ctx.credentials.peek();
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    return new Response(JSON.stringify({ state: "revoked" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (parsed.pathname === "/api/worker/events" || parsed.pathname === "/api/worker/result" || parsed.pathname === "/api/worker/failure" || parsed.pathname === "/api/worker/lease/renew") {
    return new Response(JSON.stringify({ ok: true, ...(parsed.pathname === "/api/worker/result" || parsed.pathname === "/api/worker/failure" ? { project_id: "project-test" } : {}) }), {
      status: parsed.pathname === "/api/worker/failure" ? failureUploadStatus : 200,
      headers: { "content-type": "application/json" },
    });
  }

  throw new Error(`unexpected fetch ${parsed.href}`);
};

const service = new WorkerControlService(ctx, {
  endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
  workerId: "worker-test",
  authorizedWorkspaceIds: ["workspace-a"],
  trustedWorkspaceMode: false,
});

try {
  assert.equal(
    ctx.get("deepseekWorkerConnectorControl"),
    service,
    "Loader/Host Context must expose the Remote owner under its Cordis service key",
  );
  assert.equal(service.typertRemote.serviceKey, "deepseekWorkerConnectorControl");
  assert.equal(service.typertRemote.namespace, "deepseekWorkerConnector");

  for (const method of ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates"]) {
    const found = gatewayDiscover(ctx, "deepseekWorkerConnector", method);
    assert.equal(found.serviceKey, "deepseekWorkerConnectorControl");
    assert.equal(found.receiver, service);
  }

  const status = await gatewayInvoke(ctx, "deepseekWorkerConnector", "status");
  assert.equal(status.execution, "native");
  assert.equal(status.currentVersion, "0.7.1");
  assert.equal(status.updateState, "idle");

  const generated = await gatewayInvoke(ctx, "deepseekWorkerConnector", "generateToken");
  assert.match(generated.token, /^[0-9a-f]{64}$/);
  assert.equal(generated.ref, "LOCAL_WORKER_TOKEN");

  const started = await gatewayInvoke(ctx, "deepseekWorkerConnector", "beginPairing");
  assert.equal(started.ok, true);
  assert.equal(started.state, "pending");
  assert.equal(started.pairingCode, "PAIR-1234");
  assert.equal(
    started.approvalUrl,
    "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234",
  );
  const stored = await ctx.credentials.resolve("LOCAL_WORKER_TOKEN");
  assert.equal(stored.source, "file");
  assert.match(stored.value, /^[0-9a-f]{64}$/);
  const startRequest = requests.find((request) => request.path === "/api/pair/start");
  assert.equal(JSON.stringify(startRequest).includes(stored.value), false);
  assert.equal(startRequest.url.includes(stored.value), false);

  const pending = await gatewayInvoke(ctx, "deepseekWorkerConnector", "pairingStatus");
  assert.equal(pending.ok, true);
  assert.equal(pending.state, "pending");
  const pendingAgain = await gatewayInvoke(ctx, "deepseekWorkerConnector", "beginPairing");
  assert.equal(pendingAgain.state, "pending");
  assert.equal(requests.filter((request) => request.path === "/api/pair/start").length, 1);
  assert.equal(ctx.credentials.peek(), stored.value);

  pairingState = "paired";
  const paired = await gatewayInvoke(ctx, "deepseekWorkerConnector", "pairingStatus");
  assert.equal(paired.ok, true);
  assert.equal(paired.state, "paired");
  const pairedAgain = await gatewayInvoke(ctx, "deepseekWorkerConnector", "beginPairing");
  assert.equal(pairedAgain.state, "paired");
  assert.equal(requests.filter((request) => request.path === "/api/pair/start").length, 1);
  assert.equal(ctx.credentials.peek(), stored.value);

  pairingState = "expired";
  const expired = await gatewayInvoke(ctx, "deepseekWorkerConnector", "pairingStatus");
  assert.equal(expired.ok, false);
  assert.equal(expired.state, "expired");
  assert.equal(expired.code, "pairing_expired");

  for (const mode of [409, 429, 503, "network"]) {
    startMode = mode;
    const failed = await gatewayInvoke(ctx, "deepseekWorkerConnector", "beginPairing");
    assert.equal(failed.ok, false);
    assert.equal(ctx.credentials.peek(), stored.value, `Token changed after ${mode}`);
  }
  startMode = "ok";

  pairingState = "paired";
  const disconnected = await gatewayInvoke(ctx, "deepseekWorkerConnector", "disconnectPairing");
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.state, "unpaired");
  assert.equal(await ctx.credentials.resolve("LOCAL_WORKER_TOKEN"), undefined);

  startMode = "unavailable";
  const unavailable = await gatewayInvoke(ctx, "deepseekWorkerConnector", "beginPairing");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.state, "error");
  assert.equal(unavailable.code, "pairing_api_unavailable");

  await ctx.credentials.unset("LOCAL_WORKER_TOKEN");
  const connectionTest = await gatewayInvoke(ctx, "deepseekWorkerConnector", "test");
  assert.equal(connectionTest.ok, false);
  assert.equal(connectionTest.code, "token_missing");

  const nativeEvents = [];
  const nativeSession = {
    snapshotEvents: () => [...nativeEvents],
  };
  const nativeAgent = { session: nativeSession };
  let createCalls = 0;
  ctx.registerService("sessionController", {
    async create(request) {
      createCalls += 1;
      assert.deepEqual(request, { workspaceId: "workspace-a", agentPreset: "standard" });
      return { sessionId: "session-e2e" };
    },
    async resolveAgent(sessionId) {
      assert.equal(sessionId, "session-e2e");
      return { agent: nativeAgent };
    },
    async prompt(request) {
      assert.equal(request.sessionId, "session-e2e");
      assert.equal(request.content.length, 1);
      assert.equal(request.content[0].type, "text");
      assert.match(request.content[0].text, /local execution worker controlled by ChatGPT/);
      assert.match(request.content[0].text, /Task:\nRead OS/);
      const assistant = {
        type: "assistant/message", seq: 1,
        data: { message: { content: [{ type: "text", text: "Windows" }] } },
      };
      const turnEnd = { type: "turn/end", seq: 2, data: { reason: "completed" } };
      nativeEvents.push(assistant, turnEnd);
      queueMicrotask(() => ctx.emit("session/event", nativeSession, turnEnd));
      return { accepted: true };
    },
  });
  const workerConfig = {
    endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
    workerId: "worker-test",
    authorizedWorkspaceIds: ["workspace-a"],
    trustedWorkspaceMode: true,
    leaseRenewIntervalMs: 5000,
    leaseWaitTimeoutMs: 1000,
    chatBridgeEnabled: true,
  };
  const testOutbox = new BridgeWakeOutbox({ filePath: join(outboxDirectory, "pipeline-outbox.json") });
  await testOutbox.initialize();
  const testWakeCoordinator = new WakeCoordinator({ outbox: testOutbox, transport: { kick() {} } });
  const task = { id: "task-native", workspace_id: "workspace-a", prompt: "Read OS" };
  await processLease(ctx, workerConfig, "test-token", task, new AbortController().signal, testWakeCoordinator);
  assert.equal(createCalls, 1);
  const nativeRequests = requests.filter((request) => request.path.startsWith("/api/worker/"));
  assert.deepEqual(nativeRequests.map((request) => request.path), [
    "/api/worker/events", "/api/worker/result",
  ]);
  assert.equal(nativeRequests[0].body.event, "local_started");
  assert.equal(nativeRequests[1].body.result, "Windows");
  assert.equal(nativeRequests[1].body.session_id, "session-e2e");
  assert.equal(nativeRequests[1].body.metadata.executor, "harness-native");
  assert.equal(nativeRequests[1].body.metadata.workspace_id, "workspace-a");
  const completedWakes = await testOutbox.listPending();
  assert.equal(completedWakes.length, 1);
  assert.equal(completedWakes[0].terminal_state, "completed");

  requests.length = 0;
  ctx.registerService("sessionController", {
    async create() { throw new Error("Native Session failed"); },
  });
  await processLease(ctx, workerConfig, "test-token", { ...task, id: "task-native-fail" }, new AbortController().signal, testWakeCoordinator);
  const failureRequest = requests.find((request) => request.path === "/api/worker/failure");
  assert.ok(failureRequest, "Native Session exceptions must use the normal failure upload path");
  assert.match(failureRequest.body.error, /Native Session failed/);
  const wakesAfterFailure = await testOutbox.listPending();
  assert.equal(wakesAfterFailure.length, 2);
  assert.equal(wakesAfterFailure.find((wake) => wake.task_id === "task-native-fail")?.terminal_state, "failed");

  requests.length = 0;
  failureUploadStatus = 503;
  await processLease(ctx, workerConfig, "test-token", { ...task, id: "task-failure-upload-fail" }, new AbortController().signal, testWakeCoordinator);
  assert.equal(requests.filter((request) => request.path === "/api/worker/failure").length, 1);
  assert.equal((await testOutbox.listPending()).length, 2, "failed terminal upload must not create a wake");
  failureUploadStatus = 200;

  requests.length = 0;
} finally {
  globalThis.fetch = originalFetch;
  await ctx.dispose();
  await rm(outboxDirectory, { recursive: true, force: true });
  delete process.env.DEEPSEEK_WORKER_BRIDGE_WAKE_OUTBOX_PATH;
}