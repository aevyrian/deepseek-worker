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

test("Client mounts Remote first, then injects its namespace into the UI fiber", async () => {
  const { exports } = await loadClientPlugin();
  let mounted = false;
  let remoteDisposed = false;
  let uiDisposed = false;
  let injected = [];
  let slotRenderer;
  let slotOptions;

  const remoteNamespace = {
    async status() { return { ok: true, value: { execution: "native" } }; },
    async generateToken() { return { ok: true, value: { token: "generated-once" } }; },
    async test() { return { ok: true, value: { ok: true, message: "connected" } }; },
  };
  const credentials = {
    async describe() { return { ok: true, value: { LOCAL_WORKER_TOKEN: { configured: true, writable: true } } }; },
    async set() { return { ok: true, value: undefined }; },
  };
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
        assert.deepEqual(Array.from(contribution.descriptors, (descriptor) => descriptor.method), ["status", "generateToken", "test"]);
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
  assert.ok(injected.includes("remote.deepseekWorkerConnector"));
  assert.equal(slotOptions.key, "deepseek-worker-connector#deepseek-worker-connector");
  const injectedFace = slotOptions.inject();
  assert.equal((await injectedFace.actions.status()).execution, "native");
  assert.equal(await injectedFace.actions.generateToken(), "generated-once");
  assert.equal((await injectedFace.actions.test()).ok, true);
  assert.equal((await injectedFace.actions.describeCredential()).configured, true);
  assert.equal(injectedFace.actions.getWorkspacesSnapshot().items[0].workspaceId, "workspace-a");
  assert.equal(typeof slotRenderer, "function");

  await dispose();
  assert.equal(uiDisposed, true);
  assert.equal(remoteDisposed, true);
  assert.equal(mounted, false);
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
