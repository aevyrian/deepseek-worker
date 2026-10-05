import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadClientPlugin() {
  const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
  let definition;
  const window = {
    __ModuleLoader__: {
      load(value) { definition = value; },
    },
  };
  vm.runInNewContext(source, { window, console, setInterval, clearInterval });
  assert.ok(definition);
  const React = {
    createElement: (...args) => ({ args }),
    useEffect() {},
    useState(value) { return [typeof value === "function" ? value() : value, () => {}]; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const primitive = () => null;
  const exports = definition.factory((name) => {
    if (name === "react") return React;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      return { Button: primitive, Checkbox: primitive, Input: primitive, StateDot: primitive, Switch: primitive };
    }
    throw new Error(`unexpected require: ${name}`);
  });
  return { source, exports };
}

async function mountClient({ remoteNamespace, credentials }) {
  const { exports } = await loadClientPlugin();
  let mounted = false;
  let remoteDisposed = false;
  let uiDisposed = false;
  let injected = [];
  let slotRenderer;
  let slotOptions;

  const workspaceSnapshot = {
    phase: "ready",
    items: [{ workspaceId: "workspace-a", title: "Project", path: "E:/Project", sessionIds: [] }],
  };
  const scope = {
    remote: { deepseekWorkerConnector: remoteNamespace, credentials },
    workspaces: {
      list: {
        getSnapshot: () => workspaceSnapshot,
        subscribe: () => () => {},
      },
    },
    locale: { register: () => () => {} },
    effect(effect) { return effect(); },
    slots: {
      inject(name, register) {
        assert.equal(name, "plugins.row.config");
        return register();
      },
      register(options, renderer) {
        slotOptions = options;
        slotRenderer = renderer;
        return () => {};
      },
    },
  };

  const root = {
    remote: {
      async $mount(contribution) {
        assert.equal(contribution.package, "deepseek-worker-connector");
        assert.deepEqual(
          Array.from(contribution.descriptors, (descriptor) => descriptor.method),
          ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing"],
        );
        mounted = true;
        return async () => { remoteDisposed = true; mounted = false; };
      },
    },
    inject(deps, registerUi) {
      injected = [...deps];
      assert.equal(mounted, true);
      assert.ok(deps.includes("remote.deepseekWorkerConnector"));
      assert.ok(deps.includes("remote.credentials"));
      assert.ok(deps.includes("workspaces"));
      registerUi(scope);
      const fiber = Promise.resolve();
      fiber.dispose = async () => { uiDisposed = true; };
      return fiber;
    },
  };

  const dispose = await exports.apply(root);
  return {
    actions: slotOptions.inject().actions,
    injected,
    slotOptions,
    slotRenderer,
    workspaceSnapshot,
    async dispose() {
      await dispose();
      return { mounted, remoteDisposed, uiDisposed };
    },
  };
}

test("Client mounts Remote first, then injects its namespace into the UI fiber", async () => {
  const mounted = await mountClient({
    remoteNamespace: {
      async status() { return { ok: true, value: { execution: "native" } }; },
      async generateToken() { return { ok: true, value: { token: "generated-once" } }; },
      async test() { return { ok: true, value: { ok: true, message: "connected" } }; },
    },
    credentials: {
      async describe() {
        return { ok: true, value: { LOCAL_WORKER_TOKEN: { configured: true, writable: true } } };
      },
      async set() { return { ok: true, value: undefined }; },
    },
  });

  assert.ok(mounted.injected.includes("remote.deepseekWorkerConnector"));
  assert.equal(mounted.slotOptions.key, "deepseek-worker-connector#deepseek-worker-connector");
  assert.equal((await mounted.actions.status()).execution, "native");
  assert.equal(await mounted.actions.generateToken(), "generated-once");
  assert.equal((await mounted.actions.test()).ok, true);
  assert.equal((await mounted.actions.describeCredential()).configured, true);
  assert.equal(await mounted.actions.storeCredential("local-test-token"), true);
  assert.equal(mounted.actions.getWorkspacesSnapshot().items[0].workspaceId, "workspace-a");
  assert.equal(typeof mounted.slotRenderer, "function");

  const disposed = await mounted.dispose();
  assert.equal(disposed.uiDisposed, true);
  assert.equal(disposed.remoteDisposed, true);
  assert.equal(disposed.mounted, false);
});

test("Host Remote failures are actionable and never echo an arbitrary server message", async () => {
  const leaked = "do-not-display-this-server-text";
  const mounted = await mountClient({
    remoteNamespace: {
      async status() {
        return { ok: false, error: { code: "gateway/service-unavailable", message: leaked } };
      },
      async generateToken() {
        return { ok: false, error: { code: "gateway/invocation-unavailable", message: leaked } };
      },
      async test() {
        return { ok: false, error: { code: "gateway/method-unavailable", message: leaked } };
      },
    },
    credentials: {
      async describe() {
        return { ok: true, value: { LOCAL_WORKER_TOKEN: { configured: false, writable: true } } };
      },
      async set() { return { ok: true, value: undefined }; },
    },
  });

  await assert.rejects(() => mounted.actions.status(), /Host Remote 不可用.*gateway\/service-unavailable/);
  await assert.rejects(() => mounted.actions.generateToken(), /Host Remote 不可用.*gateway\/invocation-unavailable/);
  await assert.rejects(() => mounted.actions.test(), /Gateway service unavailable.*gateway\/method-unavailable/);

  for (const action of [
    mounted.actions.status(),
    mounted.actions.generateToken(),
    mounted.actions.test(),
  ]) {
    const error = await action.catch((value) => value);
    assert.equal(String(error?.message || error).includes(leaked), false);
  }

  await mounted.dispose();
});

test("Credential describe/set errors are differentiated and never echo the Token", async () => {
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const mounted = await mountClient({
    remoteNamespace: {
      async status() { return { ok: true, value: { execution: "native" } }; },
      async generateToken() { return { ok: true, value: { token: "generated-once" } }; },
      async test() { return { ok: true, value: { ok: true, message: "connected" } }; },
    },
    credentials: {
      async describe() {
        return { ok: false, error: { code: "gateway/internal", message: "provider absent" } };
      },
      async set() {
        return { ok: false, error: { code: "credential/rejected", message: `refused ${token}` } };
      },
    },
  });

  await assert.rejects(
    () => mounted.actions.describeCredential(),
    /Credential provider 不可用.*gateway\/internal/,
  );
  const failure = await mounted.actions.storeCredential(token).catch((error) => error);
  assert.match(failure.message, /Token 保存失败.*credential\/rejected/);
  assert.equal(failure.message.includes(token), false);

  await mounted.dispose();
});

test("status failure renders Unknown/Detecting logic instead of defaulting to Headless", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /statusFailed \? "unknown" : "detecting"/);
  assert.doesNotMatch(source, /status\?\.execution \|\| "headless"/);
});

test("Browser persistence contains WorkspaceIds, not a local path editor", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /authorizedWorkspaceIds/);
  assert.match(source, /ctx\.workspaces\.list\.getSnapshot/);
  assert.doesNotMatch(source, /workspaceAllowlist/);
  assert.doesNotMatch(source, /localPath/);
});

test("Token UI no longer maps Host Remote failures to generic config-save failure", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /Host Remote 不可用/);
  assert.match(source, /Credential provider 不可写/);
  assert.match(source, /Token 保存失败/);
  assert.doesNotMatch(source, /catch \{\s*setTokenMessage\(t\("saveFailed"\)\)/);
});


test("0.3.0 exposes one-click pairing without requiring a Site Secret in the normal UI", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /连接 DeepSeek Worker/);
  assert.match(source, /beginPairing/);
  assert.match(source, /pairingStatus/);
  assert.match(source, /disconnectPairing/);
  assert.match(source, /Site 后台配置 Secret/);
  assert.doesNotMatch(source, /同步更新 Site Secret LOCAL_WORKER_TOKEN/);
});
