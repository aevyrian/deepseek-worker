import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const CLIENT = new URL("../client.js", import.meta.url);

/**
 * Load the prebuilt browser half and its descriptor contribution.
 *
 * The two task-notification Remote methods must be declared here, because the Gateway
 * client derives its call arity from `contribution.descriptors` and rejects a call whose
 * argument count differs from the declared parameter list.
 */
async function loadClientPlugin() {
  const source = await readFile(CLIENT, "utf8");
  let definition;
  const window = {
    __ModuleLoader__: { load(value) { definition = value; } },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.runInNewContext(source, { window, console, setInterval, clearInterval, URL });
  assert.ok(definition, "client.js must register its module through __ModuleLoader__");

  const primitives = {
    Button: marker("Button"),
    Checkbox: marker("Checkbox"),
    Input: marker("Input"),
    StateDot: marker("StateDot"),
    Switch: marker("Switch"),
  };
  const react = createReact();
  const exports = definition.factory((name) => {
    if (name === "react") return react.React;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require: ${name}`);
  });
  return { source, exports, primitives, react };
}

function marker(name) {
  const component = () => null;
  component.markerName = name;
  return component;
}

function createReact() {
  const states = [];
  const effects = [];
  let cursor = 0;
  return {
    states,
    effects,
    resetCursor() { cursor = 0; },
    React: {
      Fragment: Symbol("Fragment"),
      createElement(type, props, ...children) {
        const next = { ...(props || {}) };
        if (children.length === 1) next.children = children[0];
        else if (children.length > 1) next.children = children;
        return { args: [type, next, ...children] };
      },
      useEffect(effect, deps) { effects.push({ effect, deps }); },
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        }];
      },
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    },
  };
}

function recordingNamespace(overrides = {}) {
  const calls = new Map();
  const namespace = {};
  for (const method of [
    "status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing",
    "checkForUpdates", "forceUpdate", "openBridgeBrowser", "testBridge",
    "taskNotifications", "markTaskNotificationsRead",
  ]) {
    namespace[method] = async (...args) => {
      const list = calls.get(method) ?? [];
      list.push(args);
      calls.set(method, list);
      const handler = overrides[method];
      return handler ? handler(...args) : { ok: true, value: undefined };
    };
  }
  return { namespace, calls, count(method) { return (calls.get(method) ?? []).length; } };
}

async function mountClient({ remote, form, credentials } = {}) {
  const { exports, source, primitives, react } = await loadClientPlugin();
  const recorded = remote ?? recordingNamespace({
    status: async () => ({ ok: true, value: { execution: "native", pairing: "unpaired" } }),
    pairingStatus: async () => ({ ok: true, value: { ok: true, state: "unpaired" } }),
    taskNotifications: async () => ({ ok: true, value: { items: [], unreadCount: 0, activeTaskCount: 0 } }),
    markTaskNotificationsRead: async () => ({ ok: true, value: { ok: true, unreadCount: 0 } }),
  });

  let slotRenderer;
  let slotOptions;
  let contribution;
  const scope = {
    remote: {
      deepseekWorkerConnector: recorded.namespace,
      credentials: credentials ?? {
        async describe() {
          return { ok: true, value: { LOCAL_WORKER_TOKEN: { configured: true, source: "file", writable: true } } };
        },
        async set() { return { ok: true, value: undefined }; },
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: "ready",
          items: [{ workspaceId: "workspace-a", title: "Project", path: "E:/Project", sessionIds: [] }],
        }),
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
      async $mount(value) {
        contribution = value;
        return async () => {};
      },
    },
    inject(_deps, registerUi) {
      registerUi(scope);
      const fiber = Promise.resolve();
      fiber.dispose = async () => {};
      return fiber;
    },
  };

  const dispose = await exports.apply(root);
  const actions = slotOptions.inject().actions;
  let effectsRan = false;
  return {
    source,
    exports,
    actions,
    primitives,
    react,
    recorded,
    contribution,
    slotRenderer,
    async render({ form, t = (key) => key, actions: override } = {}) {
      const pageActions = override ?? actions;
      // The slot renders a lazy element, so the page body must be expanded once for its
      // hooks to register and its mount effects to queue.
      react.resetCursor();
      render(slotRenderer({ view: "config", t, form, actions: pageActions }), primitives);
      const queued = react.effects.splice(0);
      if (!effectsRan) {
        // Mount-time effects only: a re-render must not replay them, exactly as React
        // treats an effect with stable dependencies.
        effectsRan = true;
        for (const { effect } of queued) effect();
        await flush();
      }
      react.resetCursor();
      const element = slotRenderer({ view: "config", t, form, actions: pageActions });
      return render(element, primitives);
    },
    async dispose() { await dispose(); },
  };
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
};

/** The visible status line is the last message a handler wrote. */
function lastMessage(list) {
  return list.length === 0 ? undefined : list[list.length - 1];
}

/** Expand function components so the returned tree only holds host nodes and text. */
function render(node, primitives) {
  const components = new Set(Object.values(primitives));
  const walk = (value) => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (value === null || value === undefined || typeof value !== "object" || !Array.isArray(value.args)) {
      return [value];
    }
    const [type, props, ...children] = value.args;
    const rendered = children.flatMap(walk);
    if (typeof type === "function" && !components.has(type)) {
      return walk(type({ ...(props || {}), children: rendered.length === 1 ? rendered[0] : rendered }));
    }
    return [{ args: [type, props, ...rendered] }];
  };
  return walk(node);
}

function walk(tree, visit) {
  for (const node of tree) {
    if (node === null || typeof node !== "object" || !Array.isArray(node.args)) continue;
    visit(node);
    walk(node.args.slice(2), visit);
  }
}

function textOf(node) {
  return node.args.slice(2)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}

function allText(tree) {
  const parts = [];
  walk(tree, (node) => parts.push(textOf(node)));
  return parts;
}

function treeText(tree) {
  return allText(tree).join("\n");
}

function findNodes(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function componentsOf(tree, component) {
  return findNodes(tree, (node) => node.args[0] === component);
}

function buttonLabels(tree, primitives) {
  return componentsOf(tree, primitives.Button).map((node) => textOf(node));
}

/** The value cell of the label/value row whose label cell reads `label`. */
function rowValue(tree, label) {
  const rows = findNodes(tree, (node) => node.args.slice(2).length >= 2 && textOf(node.args[2]) === label);
  assert.equal(rows.length, 1, `expected exactly one status row labelled ${label}`);
  return textOf(rows[0].args[3]);
}

function sectionTitles(tree) {
  return findNodes(tree, (node) => node.args[0] === "section").map((node) => textOf(node.args[2]));
}

function localeBlock(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `locale block ${name} must exist`);
  const end = source.indexOf("\n    };", start);
  assert.ok(end > start, `locale block ${name} must be closed`);
  return source.slice(start, end);
}

function localeKeys(source, name) {
  return [...localeBlock(source, name).matchAll(/^ {6}([A-Za-z0-9_]+):/gmu)].map((match) => match[1]);
}

function localeValue(source, name, key) {
  const match = new RegExp(`^ {6}${key}: "((?:[^"\\\\]|\\\\.)*)",$`, "mu").exec(localeBlock(source, name));
  return match === null ? undefined : match[1].replace(/\\"/gu, '"');
}

function formSnapshot(overrides = {}) {
  return {
    revision: 7,
    writable: true,
    value: {
      endpoint: "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
      workerId: "deepseek-worker-windows",
      chatBridgeEnabled: true,
      chatBridgeChatUrl: "",
      chatBridgeDebugPort: 9223,
      ...overrides,
    },
  };
}

const NEW_LOCALE_KEYS = [
  "chatBridgeSaveBinding",
  "chatBridgeSavingBinding",
  "chatBridgeSaved",
  "chatBridgeSavedCleared",
  "chatBridgeVerifyFailed",
  "chatBridgeUnsaved",
  "chatBridgeDefaultSet",
  "chatBridgeDefaultUnset",
  "chatBridgeRoutingHint",
  "taskNotifications",
  "taskNotificationsHint",
  "taskNotificationsLoading",
  "taskNotificationsUnread",
  "taskNotificationsActive",
  "taskNotificationsActiveHint",
  "taskNotificationsEmpty",
  "taskNotificationsUnavailable",
  "taskNotificationsMarkAll",
  "taskNotificationsMarking",
  "taskNotificationsMarkedAll",
  "taskNotificationsMarkFailed",
  "taskNotificationsCompleted",
  "taskNotificationsFailed",
  "taskNotificationsLocalOnly",
];

test("Client declares both task-notification Remotes with one strict read parameter", async () => {
  const mounted = await mountClient();
  const methods = Array.from(mounted.contribution.descriptors, (descriptor) => descriptor.method);
  assert.deepEqual(methods, [
    "status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing",
    "checkForUpdates", "forceUpdate", "openBridgeBrowser", "testBridge",
    "taskNotifications", "markTaskNotificationsRead",
  ]);
  for (const descriptor of mounted.contribution.descriptors) {
    assert.equal(descriptor.service, "deepseekWorkerConnectorControl");
    assert.equal(descriptor.namespace, "deepseekWorkerConnector");
    assert.equal(descriptor.invocation.kind, "direct");
    assert.equal(descriptor.result.mode, "src-json");
  }

  const list = mounted.contribution.descriptors.find((descriptor) => descriptor.method === "taskNotifications");
  assert.deepEqual(Array.from(list.parameters), [], "taskNotifications takes no business argument");

  const read = mounted.contribution.descriptors.find((descriptor) => descriptor.method === "markTaskNotificationsRead");
  assert.equal(read.parameters.length, 1, "markTaskNotificationsRead declares exactly one business argument");
  const [parameter] = read.parameters;
  assert.equal(parameter.source, "json");
  // The Host derives this wire field from the service method's parameter name, so it must
  // stay `options` (`WorkerControlService.markTaskNotificationsRead(options = {})`).
  assert.equal(parameter.wire, "options");
  assert.equal(parameter.name, parameter.wire);
  assert.equal(parameter.lookup, undefined);
  assert.equal(parameter.codec.mode, "strict", "the Gateway client refuses a non-strict parameter codec");
  assert.equal(typeof parameter.codec.typeSymbol, "string");
  assert.ok(parameter.codec.typeSymbol.length > 0);
  assert.equal(typeof parameter.codec.create, "function");
  assert.equal(typeof parameter.codec.create().parse, "function");

  await mounted.dispose();
});

test("taskNotifications surfaces the Remote payload and never fabricates one", async () => {
  const payload = {
    items: [{ key: "task-a#completed", taskId: "task-a", terminalState: "completed", at: "2026-10-09T09:00:00.000Z", read: false, summary: "done" }],
    unreadCount: 1,
    activeTaskCount: 2,
  };
  const mounted = await mountClient({
    remote: recordingNamespace({ taskNotifications: async () => ({ ok: true, value: payload }) }),
  });
  assert.deepEqual(await mounted.actions.taskNotifications(), payload);
  assert.equal(mounted.recorded.count("taskNotifications"), 1);
  await mounted.dispose();

  const leaked = "do-not-display-this-server-text";
  const failing = await mountClient({
    remote: recordingNamespace({
      taskNotifications: async () => ({ ok: false, error: { code: "gateway/service-unavailable", message: leaked } }),
    }),
  });
  const error = await failing.actions.taskNotifications().catch((value) => value);
  assert.match(error.message, /Host Remote 不可用.*taskNotifications/u);
  assert.equal(error.message.includes(leaked), false);
  await failing.dispose();
});

test("markTaskNotificationsRead sends exactly one argument and omits keys for mark-all", async () => {
  const mounted = await mountClient({
    remote: recordingNamespace({
      markTaskNotificationsRead: async () => ({ ok: true, value: { ok: true, unreadCount: 0 } }),
    }),
  });

  const marked = await mounted.actions.markTaskNotificationsRead();
  assert.deepEqual(marked, { ok: true, unreadCount: 0 });
  const [noKeyArgs] = mounted.recorded.calls.get("markTaskNotificationsRead");
  assert.equal(noKeyArgs.length, 1, "the declared parameter count must match the call arity");
  assert.equal(noKeyArgs[0], undefined, "an absent key list must stay absent so the backend marks everything read");

  await mounted.actions.markTaskNotificationsRead(["key-a", "key-b"]);
  const [, keyedArgs] = mounted.recorded.calls.get("markTaskNotificationsRead");
  assert.equal(keyedArgs.length, 1);
  assert.deepEqual(Array.from(keyedArgs[0].keys), ["key-a", "key-b"]);

  await mounted.actions.markTaskNotificationsRead([]);
  const [, , emptyArgs] = mounted.recorded.calls.get("markTaskNotificationsRead");
  assert.equal(emptyArgs.length, 1);
  assert.equal(emptyArgs[0], undefined, "an empty key list must not send a partial read request");

  await mounted.dispose();

  const failing = await mountClient({
    remote: recordingNamespace({
      markTaskNotificationsRead: async () => ({
        ok: false,
        error: { code: "gateway/method-unavailable", message: "server detail" },
      }),
    }),
  });
  const error = await failing.actions.markTaskNotificationsRead().catch((value) => value);
  assert.match(error.message, /Gateway service unavailable.*markTaskNotificationsRead/u);
  assert.equal(error.message.includes("server detail"), false);
  await failing.dispose();
});

test("Every task-notification Remote call matches the declared descriptor arity", async () => {
  const mounted = await mountClient({
    remote: recordingNamespace({
      taskNotifications: async () => ({ ok: true, value: { items: [], unreadCount: 0, activeTaskCount: 0 } }),
      markTaskNotificationsRead: async () => ({ ok: true, value: { ok: true, unreadCount: 0 } }),
    }),
  });
  const declared = new Map(Array.from(mounted.contribution.descriptors, (descriptor) => [descriptor.method, descriptor.parameters.length]));
  assert.equal(declared.get("taskNotifications"), 0);
  assert.equal(declared.get("markTaskNotificationsRead"), 1);

  await mounted.actions.taskNotifications();
  await mounted.actions.markTaskNotificationsRead();
  await mounted.actions.markTaskNotificationsRead(["key-a"]);

  for (const [method, expected] of declared) {
    for (const args of mounted.recorded.calls.get(method) ?? []) {
      assert.equal(
        args.length,
        expected,
        `${method} must pass exactly ${String(expected)} argument(s): the Gateway rejects a mismatched arity`,
      );
    }
  }
  await mounted.dispose();
});

test("Save binding writes only the three local Chat Bridge fields and never touches the bridge browser", async () => {
  const calls = [];
  const mounted = await mountClient();
  const { source, exports } = await loadClientPlugin();
  const form = {
    state: { revision: 11, writable: true, value: formSnapshot().value },
    async mutate(operations, revision) {
      calls.push({ operations, revision });
      form.state.value = {
        ...form.state.value,
        chatBridgeEnabled: true,
        chatBridgeChatUrl: "https://chatgpt.com/c/default-chat",
        chatBridgeDebugPort: 9333,
      };
      return true;
    },
  };
  const message = [];
  const ok = await exports.__test.saveBridgeBinding({
    form,
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/default-chat", chatBridgeDebugPort: "9333" },
    setMessage: (value) => message.push(value),
    t: (key) => key,
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].revision, 11);
  assert.deepEqual(Array.from(calls[0].operations, (operation) => operation.path[0]), [
    "chatBridgeEnabled", "chatBridgeChatUrl", "chatBridgeDebugPort",
  ]);
  assert.deepEqual(Array.from(calls[0].operations, (operation) => operation.value), [
    true, "https://chatgpt.com/c/default-chat", 9333,
  ]);
  assert.equal(message[0], "", "a previous status message must be cleared before the attempt");
  assert.equal(lastMessage(message), "chatBridgeSaved");
  assert.equal(mounted.recorded.count("openBridgeBrowser"), 0);
  assert.equal(mounted.recorded.count("testBridge"), 0);
  assert.equal(mounted.recorded.count("taskNotifications"), 0);

  assert.match(source, /async function saveBridgeBinding/u);
  assert.doesNotMatch(source, /saveBridgeBinding[\s\S]{0,400}openBridgeBrowser/u);
  await mounted.dispose();
});

test("Save binding reports a cleared default address without pretending a binding exists", async () => {
  const { exports } = await loadClientPlugin();
  const operations = [];
  const message = [];
  const form = {
    state: { revision: 2, writable: true, value: formSnapshot({ chatBridgeChatUrl: "" }).value },
    async mutate(next) { operations.push(...next); return true; },
  };
  const ok = await exports.__test.saveBridgeBinding({
    form,
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "   ", chatBridgeDebugPort: "9223" },
    setMessage: (value) => message.push(value),
    t: (key) => key,
  });
  assert.equal(ok, true);
  assert.equal(operations.length, 3);
  assert.equal(operations[1].value, "");
  assert.equal(lastMessage(message), "chatBridgeSavedCleared");
});

test("Save binding rejects every non-conversation or dangerous target without writing", async () => {
  const { exports } = await loadClientPlugin();
  const rejected = [
    "http://chatgpt.com/c/abc",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://chatgpt.com/auth/login",
    "https://chatgpt.com/backend-api/conversation/abc",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/abc/def",
    "https://chatgpt.com/g/g-abc/other/xyz",
    "https://chatgpt.com.evil.test/c/abc",
    "https://evil.test/c/abc",
    "https://user:pass@chatgpt.com/c/abc",
    "https://chatgpt.com/#settings",
    "file:///c:/windows/system32/",
  ];
  for (const value of rejected) {
    assert.equal(exports.__test.isBindableChatUrl(value), false, `${value} must not be bindable`);
    let mutated = 0;
    const message = [];
    const ok = await exports.__test.saveBridgeBinding({
      form: {
        state: { revision: 1, writable: true, value: formSnapshot().value },
        async mutate() { mutated += 1; return true; },
      },
      draft: { chatBridgeEnabled: true, chatBridgeChatUrl: value, chatBridgeDebugPort: "9223" },
      setMessage: (entry) => message.push(entry),
      t: (key) => key,
    });
    assert.equal(ok, false, `${value} must be refused`);
    assert.equal(mutated, 0, `${value} must not reach the form`);
    assert.equal(lastMessage(message), "chatBridgeInvalidUrl");
  }

  for (const value of [
    "https://chatgpt.com/c/abc-123",
    "https://www.chatgpt.com/c/68f0c1ab?model=auto",
    "https://chatgpt.com/g/g-abc123/c/xyz",
    "https://chatgpt.com/g/g-abc123/c/xyz#tail",
    "  https://chatgpt.com/c/padded  ",
  ]) {
    assert.equal(exports.__test.isBindableChatUrl(value), true, `${value} must be bindable`);
  }
});

test("Save binding refuses an out-of-range bridge debug port before any write", async () => {
  const { exports } = await loadClientPlugin();
  for (const port of ["80", "1023", "65536", "abc", "", "9223.5"]) {
    let mutated = 0;
    const message = [];
    const ok = await exports.__test.saveBridgeBinding({
      form: {
        state: { revision: 1, writable: true, value: formSnapshot().value },
        async mutate() { mutated += 1; return true; },
      },
      draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "", chatBridgeDebugPort: port },
      setMessage: (entry) => message.push(entry),
      t: (key) => key,
    });
    assert.equal(ok, false, `port ${port} must be refused`);
    assert.equal(mutated, 0);
    assert.equal(lastMessage(message), "chatBridgeInvalidPort");
  }
});

test("Save binding verifies the form snapshot instead of trusting the React draft", async () => {
  const { exports } = await loadClientPlugin();
  const stale = {
    state: { revision: 4, writable: true, value: formSnapshot({ chatBridgeChatUrl: "" }).value },
    async mutate() { return true; },
  };
  const message = [];
  const ok = await exports.__test.saveBridgeBinding({
    form: stale,
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/wanted", chatBridgeDebugPort: "9223" },
    setMessage: (value) => message.push(value),
    t: (key) => key,
  });
  assert.equal(ok, false);
  assert.equal(lastMessage(message), "chatBridgeVerifyFailed");

  const persisted = {
    state: {
      revision: 5,
      writable: true,
      value: formSnapshot({ chatBridgeChatUrl: "https://chatgpt.com/c/wanted" }).value,
    },
    async mutate() { return true; },
  };
  const second = [];
  assert.equal(await exports.__test.saveBridgeBinding({
    form: persisted,
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "https://chatgpt.com/c/wanted", chatBridgeDebugPort: "9223" },
    setMessage: (value) => second.push(value),
    t: (key) => key,
  }), true);
  assert.equal(lastMessage(second), "chatBridgeSaved");

  const withoutSnapshot = {
    state: { revision: 6, writable: true },
    async mutate() { return true; },
  };
  const third = [];
  assert.equal(await exports.__test.saveBridgeBinding({
    form: withoutSnapshot,
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "", chatBridgeDebugPort: "9223" },
    setMessage: (value) => third.push(value),
    t: (key) => key,
  }), true, "an absent snapshot must not be reported as a failed save");
  assert.equal(lastMessage(third), "chatBridgeSavedCleared");
});

test("Save binding refuses a read-only form and never claims success", async () => {
  const { exports } = await loadClientPlugin();
  const message = [];
  const ok = await exports.__test.saveBridgeBinding({
    form: { state: { revision: 1, writable: false }, async mutate() { throw new Error("must not write"); } },
    draft: { chatBridgeEnabled: true, chatBridgeChatUrl: "", chatBridgeDebugPort: "9223" },
    setMessage: (value) => message.push(value),
    t: (key) => key,
  });
  assert.equal(ok, false);
  assert.equal(lastMessage(message), "saveFailed");
});

test("Chat Bridge renders Save binding / Open / Test in order and drops the old binding claim", async () => {
  const mounted = await mountClient();
  const form = { state: formSnapshot(), mutate: async () => true };
  const tree = await mounted.render({ form });
  const labels = buttonLabels(tree, mounted.primitives);
  const save = labels.indexOf("chatBridgeSaveBinding");
  const open = labels.indexOf("chatBridgeOpen");
  const test = labels.indexOf("chatBridgeTest");
  assert.ok(save >= 0 && open >= 0 && test >= 0, `missing bridge action button: ${labels.join(", ")}`);
  assert.ok(save < open && open < test, "Save binding must be the first Chat Bridge action");

  const text = treeText(tree);
  assert.ok(text.includes("chatBridgeChatUrl"));
  assert.ok(text.includes("chatBridgeUrlHint"));
  assert.ok(text.includes("chatBridgeRoutingHint"));
  assert.ok(text.includes("chatBridgeDefaultUnset"));
  assert.ok(text.includes("taskNotifications"));
  assert.equal(text.includes("已绑定"), false);
  assert.equal(text.includes("对话绑定"), false);
  assert.equal(mounted.source.includes("chatBridgeBound"), false, "the misleading Bound label must be gone");

  const saveButton = componentsOf(tree, mounted.primitives.Button)
    .find((node) => textOf(node) === "chatBridgeSaveBinding");
  assert.equal(saveButton.args[1].disabled, false);

  const readOnly = await mounted.render({ form: { state: { ...formSnapshot(), writable: false }, mutate: async () => true } });
  const disabledSave = componentsOf(readOnly, mounted.primitives.Button)
    .find((node) => textOf(node) === "chatBridgeSaveBinding");
  assert.equal(disabledSave.args[1].disabled, true, "a read-only form must disable Save binding");

  await mounted.dispose();
});

test("Chat Bridge reports the saved default address and announces an unsaved draft", async () => {
  const mounted = await mountClient();
  const saved = { state: formSnapshot({ chatBridgeChatUrl: "https://chatgpt.com/c/saved-default" }), mutate: async () => true };
  const tree = await mounted.render({ form: saved });
  const text = treeText(tree);
  assert.ok(text.includes("chatBridgeDefaultSet"));
  assert.equal(text.includes("chatBridgeDefaultUnset"), false);

  const dirty = {
    state: formSnapshot({ chatBridgeChatUrl: "https://chatgpt.com/c/saved-default" }),
    mutate: async () => true,
  };
  const dirtyTree = await mounted.render({ form: dirty, actions: mounted.actions });
  assert.equal(treeText(dirtyTree).includes("chatBridgeUnsaved"), false, "an unchanged draft is not dirty");

  // The draft starts from form.state.value; a page-local edit is what makes it dirty.
  const edited = {
    state: formSnapshot({ chatBridgeChatUrl: "https://chatgpt.com/c/saved-default" }),
    mutate: async () => true,
  };
  const mountedDirty = await mountClient();
  const page = await mountedDirty.render({ form: edited });
  const input = componentsOf(page, mountedDirty.primitives.Input)
    .find((node) => node.args[1].value === "https://chatgpt.com/c/saved-default");
  assert.ok(input, "the default chat URL input must render the persisted value");
  input.args[1].onChange({ target: { value: "https://chatgpt.com/c/edited" } });
  const afterEdit = await mountedDirty.render({ form: edited });
  assert.ok(treeText(afterEdit).includes("chatBridgeUnsaved"), "an edited draft must be announced");

  await mounted.dispose();
  await mountedDirty.dispose();
});

test("Task notification centre renders unread count, running tasks, terminal states and short ids", async () => {
  const payload = {
    items: [
      { key: "task-1#completed", taskId: "task-0123456789ab", terminalState: "completed", at: "2026-10-09T09:00:00.000Z", read: false, summary: "wrote 3 files" },
      { key: "task-2#failed", taskId: "task-abcdef012345", terminalState: "failed", at: "2026-10-09T09:05:00.000Z", read: true, summary: "tests failed" },
    ],
    unreadCount: 1,
    activeTaskCount: 3,
  };
  const mounted = await mountClient({
    remote: recordingNamespace({ taskNotifications: async () => ({ ok: true, value: payload }) }),
  });
  const tree = await mounted.render({ form: { state: formSnapshot(), mutate: async () => true } });
  const text = treeText(tree);

  assert.ok(text.includes("taskNotificationsCompleted"));
  assert.ok(text.includes("taskNotificationsFailed"));
  assert.ok(text.includes("taskNotificationsUnread"));
  assert.ok(text.includes("taskNotificationsLocalOnly"));
  assert.ok(text.includes("wrote 3 files"));
  assert.ok(text.includes("tests failed"));
  assert.ok(text.includes(mounted.exports.__test.shortTaskId("task-0123456789ab")));
  assert.ok(text.includes(mounted.exports.__test.shortTaskId("task-abcdef012345")));
  assert.ok(text.includes("2026"), "the notification time must be rendered");
  assert.equal(rowValue(tree, "taskNotificationsUnread"), "1");
  assert.equal(rowValue(tree, "taskNotificationsActive"), "3");

  const titles = sectionTitles(tree);
  assert.equal(titles.includes("taskNotifications"), true);
  assert.equal(
    titles.indexOf("taskNotifications"),
    titles.indexOf("chatBridge") + 1,
    "the task-notification centre must sit next to the Chat Bridge section",
  );

  const lines = text.split("\n").map((line) => line.trim());
  assert.equal(lines.includes("3 / 24"), false, "a running-task count is not a concurrency progress bar");
  assert.equal(lines.includes("1 / 3"), false, "a running-task count is not a completion ratio");
  assert.ok(text.includes("taskNotificationsActiveHint"));

  const markAll = componentsOf(tree, mounted.primitives.Button)
    .find((node) => textOf(node) === "taskNotificationsMarkAll");
  assert.ok(markAll, "the mark-all button must render");
  assert.equal(markAll.args[1].disabled, false);

  assert.equal(mounted.recorded.count("taskNotifications"), 1, "the page refreshes the local Remote exactly once per mount");
  await mounted.dispose();
});

test("Task notification centre disables mark-all when nothing is unread and degrades safely", async () => {
  const read = await mountClient({
    remote: recordingNamespace({
      taskNotifications: async () => ({
        ok: true,
        value: {
          items: [{ key: "task-1#completed", taskId: "task-1", terminalState: "completed", at: "2026-10-09T09:00:00.000Z", read: true, summary: "" }],
          unreadCount: 0,
          activeTaskCount: 0,
        },
      }),
    }),
  });
  const tree = await read.render({ form: { state: formSnapshot(), mutate: async () => true } });
  const markAll = componentsOf(tree, read.primitives.Button)
    .find((node) => textOf(node) === "taskNotificationsMarkAll");
  assert.equal(markAll.args[1].disabled, true);
  await read.dispose();

  const empty = await mountClient({
    remote: recordingNamespace({
      taskNotifications: async () => ({ ok: true, value: { items: [], unreadCount: 0, activeTaskCount: 0 } }),
    }),
  });
  const emptyTree = await empty.render({ form: { state: formSnapshot(), mutate: async () => true } });
  assert.ok(treeText(emptyTree).includes("taskNotificationsEmpty"));
  await empty.dispose();

  const failing = await mountClient({
    remote: recordingNamespace({
      taskNotifications: async () => ({ ok: false, error: { code: "gateway/service-unavailable", message: "server text" } }),
    }),
  });
  const failingTree = await failing.render({ form: { state: formSnapshot(), mutate: async () => true } });
  const failingText = treeText(failingTree);
  assert.ok(failingText.includes("Host Remote 不可用"), "an unavailable notification Remote must be visible");
  assert.equal(failingText.includes("server text"), false);
  assert.ok(failingText.includes("taskNotificationsEmpty") || failingText.includes("taskNotificationsLoading"));
  await failing.dispose();
});

test("Task notification centre works without a Project or chat URL and never polls Cloud", async () => {
  const mounted = await mountClient({
    remote: recordingNamespace({
      status: async () => ({ ok: true, value: { execution: "native", pairing: "unpaired", chatBridge: { state: "unbound" } } }),
      taskNotifications: async () => ({
        ok: true,
        value: { items: [], unreadCount: 0, activeTaskCount: 1 },
      }),
    }),
  });
  const form = {
    state: formSnapshot({ chatBridgeEnabled: false, chatBridgeChatUrl: "" }),
    mutate: async () => true,
  };
  const tree = await mounted.render({ form });
  assert.ok(treeText(tree).includes("taskNotifications"));
  assert.equal(mounted.recorded.count("taskNotifications"), 1);
  assert.equal(mounted.recorded.count("test"), 0, "opening the page must not probe Cloud");
  assert.equal(mounted.recorded.count("openBridgeBrowser"), 0);
  assert.equal(mounted.recorded.count("testBridge"), 0);
  assert.match(mounted.source, /window\.setInterval\(\(\) => \{ void refreshNotifications\(\); \}, 5000\)/u);
  await mounted.dispose();
});

test("Task notification summary preview is redacted and bounded before it reaches the DOM", async () => {
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const mounted = await mountClient();
  const { sanitizeNotificationSummary, shortTaskId, formatNotificationTime } = mounted.exports.__test;

  const redacted = sanitizeNotificationSummary(`finished with LOCAL_WORKER_TOKEN=${token} and Bearer sk-abcdefghijklmnop`);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes("sk-abcdefghijklmnop"), false);
  assert.ok(redacted.includes("[redacted]"));
  assert.equal(sanitizeNotificationSummary(undefined), "");
  assert.equal(sanitizeNotificationSummary("  \n\t "), "");
  assert.equal(sanitizeNotificationSummary("a\n\nb   c"), "a b c");

  const long = sanitizeNotificationSummary("x".repeat(900));
  assert.ok(long.length <= 200, `preview must stay short, got ${String(long.length)}`);
  assert.ok(long.endsWith("…"));
  assert.ok(sanitizeNotificationSummary("y".repeat(900), 900).length <= 500, "the hard cap is 500 characters");

  assert.equal(shortTaskId("task-0123456789ab"), "456789ab");
  assert.equal(shortTaskId("short"), "short");
  assert.equal(shortTaskId(undefined), "--");
  assert.equal(formatNotificationTime("2026-10-09T09:00:00.000Z").includes("2026"), true);
  assert.equal(formatNotificationTime("not-a-date"), "not-a-date");
  assert.equal(formatNotificationTime(undefined), "--");

  const payload = {
    items: [{ key: "k", taskId: "task-1", terminalState: "completed", at: "2026-10-09T09:00:00.000Z", read: false, summary: `token=${token}` }],
    unreadCount: 1,
    activeTaskCount: 0,
  };
  const live = await mountClient({
    remote: recordingNamespace({ taskNotifications: async () => ({ ok: true, value: payload }) }),
  });
  const tree = await live.render({ form: { state: formSnapshot(), mutate: async () => true } });
  const text = treeText(tree);
  assert.equal(text.includes(token), false, "no secret may be rendered in the notification centre");
  assert.ok(text.includes("[redacted]"));
  assert.equal(live.exports.__test.notificationUnreadCount({ items: payload.items }), 1, "unread falls back to the item flags");
  assert.deepEqual(Array.from(live.exports.__test.notificationItems({ items: [null, 5, { key: "ok" }] })), [{ key: "ok" }]);

  await mounted.dispose();
  await live.dispose();
});

test("The declared read wire field matches the Host method parameter whenever index.js provides it", async () => {
  // The Host derives each wire field from the service method's own parameter names, so a
  // renamed backend parameter silently drops a `{ keys }` filter. This guard is inert
  // until the backend half of the RPC contract lands in index.js and then pins the name.
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const { exports } = await loadClientPlugin();

  const list = /async taskNotifications\(([^)]*)\)/u.exec(source);
  if (list !== null) {
    assert.equal(list[1].trim(), "", "taskNotifications must stay a zero-argument Host method");
    const descriptor = exports.__test.TASK_NOTIFICATIONS_READ_OPTIONS;
    assert.equal(typeof descriptor, "object");
  }

  const read = /async markTaskNotificationsRead\(([^)]*)\)/u.exec(source);
  if (read === null) return;
  const hostParameter = read[1].split(",")[0].split("=")[0].trim();
  assert.equal(
    exports.__test.TASK_NOTIFICATIONS_READ_OPTIONS.wire,
    hostParameter,
    "the declared wire field must equal the Host parameter name",
  );
});

test("New Chat Bridge and task-notification copy is aligned across zh and en", async () => {
  const { source } = await loadClientPlugin();
  const zhKeys = new Set(localeKeys(source, "zh"));
  const enKeys = new Set(localeKeys(source, "en"));
  for (const key of NEW_LOCALE_KEYS) {
    assert.ok(zhKeys.has(key), `zh is missing ${key}`);
    assert.ok(enKeys.has(key), `en is missing an explicit override for ${key}`);
    assert.notEqual(localeValue(source, "zh", key), localeValue(source, "en", key), `${key} must be translated, not copied`);
  }
  for (const key of enKeys) assert.ok(zhKeys.has(key), `en override ${key} has no zh base key`);
  assert.equal(localeValue(source, "zh", "chatBridgeChatUrl"), "默认聊天地址（仅历史 / 明确 legacy 任务使用）");
  assert.equal(localeValue(source, "en", "chatBridgeChatUrl"), "Default chat URL (history / explicit legacy tasks only)");
  assert.equal(localeValue(source, "zh", "chatBridgeSaveBinding"), "保存绑定");
  assert.equal(localeValue(source, "en", "chatBridgeSaveBinding"), "Save binding");
  assert.equal(localeValue(source, "zh", "chatBridgeSaved"), "已保存到本机 Connector");
  assert.equal(localeValue(source, "en", "chatBridgeSaved"), "Saved to this machine's Connector");
  assert.match(localeValue(source, "zh", "chatBridgeUrlHint"), /不会改变已存在 Project 的投递目标/u);
  assert.match(localeValue(source, "zh", "chatBridgeRoutingHint"), /新项目按任务自己的目标聊天投递/u);
  assert.match(localeValue(source, "en", "chatBridgeRoutingHint"), /new projects deliver to each task's own target chat/u);
  assert.match(localeValue(source, "zh", "taskNotificationsActiveHint"), /不代表进度比例/u);
  assert.match(localeValue(source, "en", "taskNotificationsActiveHint"), /not a progress ratio/u);
  assert.equal(localeValue(source, "zh", "taskNotificationsMarkAll"), "全部标记已读");
  assert.equal(localeValue(source, "en", "taskNotificationsMarkAll"), "Mark all read");
  assert.match(localeValue(source, "zh", "taskNotificationsLocalOnly"), /插件内置的通知中心/u);
  assert.match(localeValue(source, "en", "taskNotificationsLocalOnly"), /no OS-native notification/u);
  assert.equal(localeValue(source, "zh", "chatBridgeBound"), undefined);
});
