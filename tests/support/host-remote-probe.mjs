import assert from "node:assert/strict";
import WorkerControlService from "../../index.js";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

class HostContext {
  constructor() {
    this.reflect = { props: {} };
    this.services = new Map();
    this.cleanups = [];
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
const requests = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const body = JSON.parse(String(init.body || "{}"));
  requests.push({ url: parsed.href, path: parsed.pathname, headers: { ...(init.headers || {}) }, body });

  if (parsed.pathname === "/api/pair/start") {
    if (startMode === "unavailable") {
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(init.headers.authorization, undefined);
    assert.match(body.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(body.client_version, "0.3.3-preview.1");
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
  assert.equal(status.currentVersion, "0.3.3-preview.1");
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

  pairingState = "paired";
  const paired = await gatewayInvoke(ctx, "deepseekWorkerConnector", "pairingStatus");
  assert.equal(paired.ok, true);
  assert.equal(paired.state, "paired");

  pairingState = "expired";
  const expired = await gatewayInvoke(ctx, "deepseekWorkerConnector", "pairingStatus");
  assert.equal(expired.ok, false);
  assert.equal(expired.state, "expired");
  assert.equal(expired.code, "pairing_expired");

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
} finally {
  globalThis.fetch = originalFetch;
  await ctx.dispose();
}