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
  vm.runInNewContext(source, { window, console, setInterval, clearInterval, URL });
  assert.ok(definition);
  const React = {
    Fragment: Symbol("Fragment"),
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

function goodRemoteNamespace() {
  return {
    async status() { return { ok: true, value: { execution: "native", pairing: "unpaired" } }; },
    async generateToken() { return { ok: true, value: { token: "generated-once" } }; },
    async test() { return { ok: true, value: { ok: true, message: "connected" } }; },
    async beginPairing() {
      return {
        ok: true,
        value: {
          ok: true,
          state: "pending",
          pairingCode: "PAIR-1234",
          approvalUrl: "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234",
        },
      };
    },
    async pairingStatus() { return { ok: true, value: { ok: true, state: "pending" } }; },
    async disconnectPairing() { return { ok: true, value: { ok: true, state: "unpaired" } }; },
    async checkForUpdates() {
      return {
        ok: true,
        value: {
          currentVersion: "0.3.2",
          latestVersion: "0.3.2",
          updateState: "up-to-date",
          restartRequired: false,
        },
      };
    },
    async forceUpdate() {
      return { ok: true, value: { updateState: "restart-required", restartRequired: true } };
    },
    async openBridgeBrowser() { return { ok: true, value: { ok: true, bound: true, state: "idle" } }; },
    async testBridge() { return { ok: true, value: { ok: true, bound: true, state: "idle" } }; },
  };
}

async function mountClient({
  remoteNamespace = goodRemoteNamespace(),
  credentials = {
    async describe() {
      return { ok: true, value: { LOCAL_WORKER_TOKEN: { configured: true, source: "file", writable: true } } };
    },
    async set() { return { ok: true, value: undefined }; },
  },
} = {}) {
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
          ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates", "forceUpdate", "openBridgeBrowser", "testBridge", "taskNotifications", "markTaskNotificationsRead"],
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
    exports,
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

test("Client mounts all Connector Remotes and keeps manual Token compatibility", async () => {
  const mounted = await mountClient();

  assert.ok(mounted.injected.includes("remote.deepseekWorkerConnector"));
  assert.equal(mounted.slotOptions.key, "deepseek-worker-connector#deepseek-worker-connector");
  assert.equal((await mounted.actions.status()).execution, "native");
  assert.equal(await mounted.actions.generateToken(), "generated-once");
  assert.equal((await mounted.actions.test()).ok, true);
  assert.equal((await mounted.actions.beginPairing()).state, "pending");
  assert.equal((await mounted.actions.pairingStatus()).state, "pending");
  assert.equal((await mounted.actions.disconnectPairing()).state, "unpaired");
  assert.equal((await mounted.actions.checkForUpdates()).updateState, "up-to-date");
  assert.equal((await mounted.actions.forceUpdate()).updateState, "restart-required");
  assert.equal((await mounted.actions.openBridgeBrowser()).ok, true);
  assert.equal((await mounted.actions.testBridge()).ok, true);
  assert.equal((await mounted.actions.describeCredential()).configured, true);
  assert.equal(await mounted.actions.storeCredential("manual-compatibility-token"), true);
  assert.equal(mounted.actions.getWorkspacesSnapshot().items[0].workspaceId, "workspace-a");
  assert.equal(typeof mounted.slotRenderer, "function");

  const disposed = await mounted.dispose();
  assert.equal(disposed.uiDisposed, true);
  assert.equal(disposed.remoteDisposed, true);
  assert.equal(disposed.mounted, false);
});

test("Chat Bridge status labels distinguish binding, checking, login, ready and error", async () => {
  const { source, exports } = await loadClientPlugin();
  const label = exports.__test.chatBridgeStatusKey;
  assert.equal(label({ enabled: true, state: "idle", bound: true }), "chatBridgeIdle");
  assert.equal(label({ enabled: true, state: "checking", bound: true }), "chatBridgeChecking");
  assert.equal(label({ enabled: true, state: "needs-login", bound: true }), "chatBridgeNeedsLogin");
  assert.equal(label({ enabled: true, state: "ready", bound: true }), "chatBridgeReady");
  assert.equal(label({ enabled: true, state: "error", bound: true }), "chatBridgeError");
  assert.equal(label({ enabled: true, state: "sent", bound: true }), "chatBridgeReady");
  assert.equal(label({ enabled: false, state: "idle", bound: true }), "chatBridgeDisabled");
  assert.match(source, /label: t\("chatBridgeStatus"\)/u);
  assert.match(source, /label: t\("chatBridgeBinding"\)/u);
  assert.match(source, /bridgeMessage \? h\("p", \{ role: "status", style: mutedStyle \}/u);
  assert.doesNotMatch(source, /status\?\.chatBridge\?\.bound\s*\?[^:]+chatBridgeReady/u);
});

test("Bridge buttons persist only Bridge settings even when an unrelated endpoint is invalid", async () => {
  const { exports } = await loadClientPlugin();
  let operations;
  let actionCalls = 0;
  let visibleMessage = "old error";
  let refreshed = false;
  const form = {
    state: { revision: 17, writable: true },
    async mutate(nextOperations, revision) {
      operations = nextOperations;
      assert.equal(revision, 17);
      return true;
    },
  };
  const ok = await exports.__test.runBridgeAction({
    form,
    draft: {
      endpoint: "invalid unrelated endpoint",
      chatBridgeEnabled: true,
      chatBridgeChatUrl: "https://chatgpt.com/c/bound?model=auto",
      chatBridgeDebugPort: "9223",
    },
    async action() { actionCalls += 1; return { ok: true }; },
    setMessage(value) { visibleMessage = value; },
    async refreshStatus() { refreshed = true; },
    t: (key) => key,
  });
  assert.equal(ok, true);
  assert.deepEqual(Array.from(operations, ({ path: field }) => Array.from(field)), [
    ["chatBridgeEnabled"], ["chatBridgeChatUrl"], ["chatBridgeDebugPort"],
  ]);
  assert.equal(operations[2].value, 9223);
  assert.equal(actionCalls, 1);
  assert.equal(visibleMessage, "");
  assert.equal(refreshed, true);
});

test("Bridge save failure blocks the remote action and leaves a Bridge-local status message", async () => {
  const { source, exports } = await loadClientPlugin();
  let actionCalls = 0;
  let visibleMessage = "";
  const ok = await exports.__test.runBridgeAction({
    form: { state: { revision: 3, writable: true }, async mutate() { return false; } },
    draft: { endpoint: "https://invalid-for-bridge.example", chatBridgeEnabled: true, chatBridgeChatUrl: "", chatBridgeDebugPort: "9223" },
    async action() { actionCalls += 1; return { ok: true }; },
    setMessage(value) { visibleMessage = value; },
    async refreshStatus() {},
    t: (key) => key,
  });
  assert.equal(ok, false);
  assert.equal(actionCalls, 0);
  assert.equal(visibleMessage, "saveFailed");
  assert.match(source, /bridgeMessage \? h\("p", \{ role: "status"/u);
  assert.match(source, /onClick: \(\) => void performBridgeAction\(actions\.openBridgeBrowser\)/u);
  assert.match(source, /onClick: \(\) => void performBridgeAction\(actions\.testBridge\)/u);
});

test("Bridge validation failures are visible and never invoke the remote action", async () => {
  const { exports } = await loadClientPlugin();
  let actionCalls = 0;
  let message = "";
  const ok = await exports.__test.runBridgeAction({
    form: { state: { revision: 1, writable: true }, async mutate() { throw new Error("must not save"); } },
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "https://example.invalid/c/a", chatBridgeDebugPort: "9223" },
    async action() { actionCalls += 1; return { ok: true }; },
    setMessage(value) { message = value; },
    async refreshStatus() {},
    t: (key) => key,
  });
  assert.equal(ok, false);
  assert.equal(actionCalls, 0);
  assert.equal(message, "chatBridgeInvalidUrl");
});

test("Host Remote failures remain actionable for pairing methods", async () => {
  const leaked = "do-not-display-this-server-text";
  const failing = {};
  for (const method of ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates", "forceUpdate"]) {
    failing[method] = async () => ({
      ok: false,
      error: { code: "gateway/service-unavailable", message: leaked },
    });
  }
  const mounted = await mountClient({ remoteNamespace: failing });

  for (const [name, invoke] of [
    ["status", () => mounted.actions.status()],
    ["generateToken", () => mounted.actions.generateToken()],
    ["test", () => mounted.actions.test()],
    ["beginPairing", () => mounted.actions.beginPairing()],
    ["pairingStatus", () => mounted.actions.pairingStatus()],
    ["disconnectPairing", () => mounted.actions.disconnectPairing()],
    ["checkForUpdates", () => mounted.actions.checkForUpdates()],
    ["forceUpdate", () => mounted.actions.forceUpdate()],
  ]) {
    const error = await invoke().catch((value) => value);
    assert.match(error.message, new RegExp(`Host Remote 不可用.*${name}`));
    assert.equal(error.message.includes(leaked), false);
  }

  await mounted.dispose();
});

test("Credential describe/set errors are differentiated and never echo a Token", async () => {
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const mounted = await mountClient({
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

test("Browser pairing poller checks every 3 seconds and stops after pending becomes paired", async () => {
  const { exports } = await loadClientPlugin();
  const callbacks = [];
  let intervalMs;
  let cleared = false;
  const timers = {
    setInterval(callback, ms) {
      callbacks.push(callback);
      intervalMs = ms;
      return 41;
    },
    clearInterval(id) {
      assert.equal(id, 41);
      cleared = true;
    },
  };
  const states = [
    { ok: true, state: "pending" },
    { ok: true, state: "paired" },
  ];
  const seen = [];
  const poller = exports.__test.createPairingPoller(
    async () => states.shift(),
    (result) => seen.push(result.state),
    (error) => { throw error; },
    timers,
  );

  assert.equal(intervalMs, 3000);
  await poller.tick();
  assert.deepEqual(seen, ["pending"]);
  assert.equal(cleared, false);
  await poller.tick();
  assert.deepEqual(seen, ["pending", "paired"]);
  assert.equal(cleared, true);
});

test("page reopen restores pending pairing when a local Credential exists", async () => {
  const { exports } = await loadClientPlugin();
  let statusCalls = 0;
  const restored = await exports.__test.restorePairingConnection({
    async describeCredential() {
      return { configured: true, source: "file", writable: true };
    },
    async pairingStatus() {
      statusCalls += 1;
      return {
        ok: true,
        state: "pending",
        pairingCode: "PAIR-1234",
        approvalUrl: "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234",
      };
    },
  });

  assert.equal(statusCalls, 1);
  assert.equal(restored.credential.configured, true);
  assert.equal(restored.pairing.state, "pending");
});

test("page reopen recognizes an already paired device", async () => {
  const { exports } = await loadClientPlugin();
  const restored = await exports.__test.restorePairingConnection({
    async describeCredential() {
      return { configured: true, source: "file", writable: true };
    },
    async pairingStatus() {
      return { ok: true, state: "paired" };
    },
  });
  assert.equal(restored.pairing.state, "paired");
});

test("page reopen does not call pairingStatus when no Credential exists", async () => {
  const { exports } = await loadClientPlugin();
  let statusCalls = 0;
  const restored = await exports.__test.restorePairingConnection({
    async describeCredential() {
      return { configured: false, writable: true };
    },
    async pairingStatus() {
      statusCalls += 1;
      return { ok: true, state: "paired" };
    },
  });
  assert.equal(statusCalls, 0);
  assert.equal(restored.pairing.state, "unpaired");
});

test("connection URLs contain only Cloud setup/pairing data and never a Worker Token", async () => {
  const { exports } = await loadClientPlugin();
  const token = "f".repeat(64);
  const endpoint = "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker";
  const url = exports.__test.connectionUrl(
    { state: "pending", pairingCode: "PAIR-1234" },
    undefined,
    endpoint,
  );
  assert.equal(url, "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1234");
  assert.equal(url.includes(token), false);
  assert.equal(url.includes("LOCAL_WORKER_TOKEN"), false);
});

test("normal UI is connection-first; Token controls are inside Advanced diagnostics", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /设备连接/);
  assert.match(source, /安装并连接 ChatGPT/);
  assert.match(source, /打开连接页面/);
  assert.match(source, /在 ChatGPT 中打开/);
  assert.match(source, /高级 \/ 诊断/);
  assert.doesNotMatch(source, /Site Secret/);

  const advancedRender = source.indexOf('h("details", { style: sectionStyle }');
  const tokenRender = source.indexOf('h("strong", null, t("token"))');
  assert.ok(advancedRender >= 0);
  assert.ok(tokenRender > advancedRender);
});

test("Browser never persists Worker Token in local/session storage or appends it to URLs", async () => {
  const { source } = await loadClientPlugin();
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /sessionStorage/);
  assert.doesNotMatch(source, /searchParams\.set\(["']token/);
  assert.doesNotMatch(source, /searchParams\.set\(["']LOCAL_WORKER_TOKEN/);
});

test("status failure renders Unknown/Detecting instead of defaulting to Headless", async () => {
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

test("normal UI exposes simple automatic update status while package details stay hidden", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /自动更新/);
  assert.match(source, /更新状态/);
  assert.match(source, /已是最新版本/);
  assert.match(source, /重启 Harness 后生效/);
  assert.match(source, /stable/);
  assert.match(source, /preview/);
  assert.doesNotMatch(source, /pnpm add/);
  assert.doesNotMatch(source, /node_modules/);
});

test("Browser update controls never receive Credential values or package-manager commands", async () => {
  const { source } = await loadClientPlugin();
  assert.match(source, /checkForUpdates/);
  assert.match(source, /一键强制更新/);
  assert.match(source, /t\("checkUpdates"\)/);
  assert.match(source, /t\("forceUpdate"\)/);
  assert.doesNotMatch(source, /installBundle/);
  assert.doesNotMatch(source, /LOCAL_WORKER_TOKEN.*update/);
});
