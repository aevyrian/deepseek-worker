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
      list: () => [],
      get: () => undefined,
    };
    this.registerService("workspaceRegistry", this.workspaceRegistry);
    this.registerService("credentials", {
      resolve: async () => undefined,
    });
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
const service = new WorkerControlService(ctx, { authorizedWorkspaceIds: [] });

try {
  assert.equal(
    ctx.get("deepseekWorkerConnectorControl"),
    service,
    "Loader/Host Context must expose the Remote owner under its Cordis service key",
  );
  assert.equal(service.typertRemote.serviceKey, "deepseekWorkerConnectorControl");
  assert.equal(service.typertRemote.namespace, "deepseekWorkerConnector");

  for (const method of ["status", "generateToken", "test"]) {
    const found = gatewayDiscover(ctx, "deepseekWorkerConnector", method);
    assert.equal(found.serviceKey, "deepseekWorkerConnectorControl");
    assert.equal(found.receiver, service);
  }

  const status = await gatewayInvoke(ctx, "deepseekWorkerConnector", "status");
  assert.equal(status.execution, "native");

  const generated = await gatewayInvoke(ctx, "deepseekWorkerConnector", "generateToken");
  assert.match(generated.token, /^[0-9a-f]{64}$/);
  assert.equal(generated.ref, "LOCAL_WORKER_TOKEN");

  const connectionTest = await gatewayInvoke(ctx, "deepseekWorkerConnector", "test");
  assert.equal(connectionTest.ok, false);
  assert.equal(connectionTest.code, "workspace_missing");
} finally {
  await ctx.dispose();
}
