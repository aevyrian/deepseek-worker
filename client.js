/** Prebuilt DeepSeek Harness browser half. Git installs can use it without a local build step. */
window.__ModuleLoader__.load({
  id: "deepseek-worker-connector",
  factory(require) {
    const React = require("react");
    const { Button, Checkbox, Input, StateDot, Switch } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useEffect, useState, useSyncExternalStore } = React;
    const TOKEN_REF = "LOCAL_WORKER_TOKEN";
    const ROW_KEY = "deepseek-worker-connector#deepseek-worker-connector";
    const NS = "deepseekWorkerConnector";

    const contribution = {
      package: "deepseek-worker-connector",
      descriptors: ["status", "generateToken", "test"].map((method) => ({
        id: `deepseek-worker-connector#deepseekWorkerConnector/${method}`,
        service: "deepseekWorkerConnectorControl",
        namespace: "deepseekWorkerConnector",
        method,
        invocation: { kind: "direct" },
        parameters: [],
        result: { mode: "src-json" },
      })),
    };

    const zh = {
      summary: "绑定 Harness 原生 Workspace、配置 Worker Token 与运行状态",
      cloud: "云端连接",
      endpoint: "云端地址",
      workerId: "Worker ID",
      token: "Worker Token",
      configured: "已配置",
      unconfigured: "未配置",
      setToken: "设置 Token",
      generatedToken: "刚生成的 Token",
      generateToken: "生成随机 Token",
      saveToken: "保存到 Harness",
      copy: "复制",
      copied: "已复制",
      tokenHint: "Token 保存后无法再次查看。遗失时请重新生成，并同步更新 Site Secret LOCAL_WORKER_TOKEN。",
      tokenSiteHint: "请把同一个 Token 配置到 DeepSeek Worker Site Secret：LOCAL_WORKER_TOKEN。",
      status: "Harness 状态",
      connector: "Connector",
      harness: "Execution",
      credential: "Credential",
      cloudStatus: "Cloud",
      worker: "Worker",
      heartbeat: "最后心跳",
      loaded: "已加载",
      native: "Native Harness",
      headless: "Headless fallback",
      detecting: "检测中",
      unknown: "未知",
      online: "在线",
      offline: "离线",
      unauthenticated: "未认证",
      untested: "未测试",
      paused: "paused",
      error: "error",
      test: "测试连接",
      testing: "测试中…",
      workspaces: "Harness Workspaces",
      workspaceHint: "列表直接来自 Harness 官方 Workspace 服务。只保存 WorkspaceId，不保存本地路径副本。",
      workspaceLoading: "正在读取 Harness Workspace…",
      noWorkspaces: "Harness 当前没有 Workspace。请先在左侧“工作区”中创建项目。",
      removedMissing: "已从当前草稿移除 Harness 中不存在的 Workspace；请保存配置。",
      permissionMode: "权限模式",
      trustedMode: "受信任工作区模式",
      trustedHint: "在已授权 Workspace 内，Connector 不额外限制 Harness 的文件、Shell、Git、Build、Test 与其他工具能力；实际权限仍由 Harness Profile、工具审批和操作系统决定。",
      restrictedHint: "关闭后进入受限模式。beta.3 会暂停远程任务领取，而不是伪造一个并不存在的半权限沙箱。",
      advanced: "高级设置",
      poll: "Poll interval (ms)",
      heartbeatInterval: "Heartbeat interval (ms)",
      lease: "Lease renew interval (ms)",
      leaseWait: "Lease wait timeout (ms)",
      fallback: "允许 Headless fallback",
      saveConfig: "保存配置",
      saving: "保存中…",
      saved: "配置已保存并即时应用。",
      saveFailed: "配置保存失败，请刷新后重试。",
      invalidEndpoint: "云端地址必须是 HTTPS。",
      noHeartbeat: "--",
      workspaceMissingStatus: "部分授权 Workspace 已不存在，请重新选择。",
    };
    const en = {
      ...zh,
      summary: "Bind native Harness Workspaces and configure Worker connectivity",
      cloud: "Cloud connection",
      endpoint: "Endpoint",
      workerId: "Worker ID",
      token: "Worker Token",
      configured: "Configured",
      unconfigured: "Not configured",
      setToken: "Set Token",
      generatedToken: "Newly generated Token",
      generateToken: "Generate random Token",
      saveToken: "Save to Harness",
      copy: "Copy",
      copied: "Copied",
      status: "Harness status",
      connector: "Connector",
      harness: "Execution",
      credential: "Credential",
      cloudStatus: "Cloud",
      worker: "Worker",
      heartbeat: "Last heartbeat",
      loaded: "Loaded",
      native: "Native Harness",
      headless: "Headless fallback",
      detecting: "Detecting",
      unknown: "Unknown",
      online: "Online",
      offline: "Offline",
      unauthenticated: "Unauthenticated",
      untested: "Untested",
      test: "Test connection",
      testing: "Testing…",
      workspaces: "Harness Workspaces",
      workspaceLoading: "Loading Harness Workspaces…",
      noWorkspaces: "No Harness Workspace exists yet.",
      permissionMode: "Permission mode",
      trustedMode: "Trusted Workspace mode",
      advanced: "Advanced",
      fallback: "Allow Headless fallback",
      saveConfig: "Save configuration",
      saving: "Saving…",
      saved: "Configuration saved and applied live.",
      saveFailed: "Could not save configuration. Refresh and retry.",
    };

    const sectionStyle = {
      border: "1px solid var(--dsw-color-border-secondary, rgba(127,127,127,.2))",
      borderRadius: 12,
      padding: 16,
      display: "grid",
      gap: 12,
    };
    const gridStyle = { display: "grid", gap: 10 };
    const rowStyle = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
    const fieldStyle = { display: "grid", gap: 6, minWidth: 220, flex: "1 1 260px" };
    const mutedStyle = { opacity: 0.72, fontSize: 13, lineHeight: 1.5, margin: 0 };

    function stateDot(value) {
      if (["loaded", "configured", "online", "native"].includes(value)) return "done";
      if (value === "detecting") return "ongoing";
      if (["paused", "headless", "untested", "unknown"].includes(value)) return "warning";
      if (["offline", "unauthenticated", "unconfigured", "error"].includes(value)) return "error";
      return "idle";
    }

    function StatusLine({ label, value, display }) {
      return h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
        h("span", null, label),
        h("span", { style: rowStyle }, h(StateDot, { state: stateDot(value) }), h("span", null, display ?? value)),
      );
    }

    function Field({ label, children }) {
      return h("label", { style: fieldStyle }, h("span", null, label), children);
    }

    function ConfigPage(props) {
      const { t, form, actions } = props;
      const initial = form?.state?.value || {};
      const [draft, setDraft] = useState(() => ({
        endpoint: initial.endpoint || "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
        workerId: initial.workerId || "deepseek-worker-windows",
        pollIntervalMs: String(initial.pollIntervalMs ?? 4000),
        heartbeatIntervalMs: String(initial.heartbeatIntervalMs ?? 20000),
        leaseRenewIntervalMs: String(initial.leaseRenewIntervalMs ?? 20000),
        leaseWaitTimeoutMs: String(initial.leaseWaitTimeoutMs ?? 1800000),
        trustedWorkspaceMode: initial.trustedWorkspaceMode !== false,
        enableHeadlessFallback: initial.enableHeadlessFallback !== false,
      }));
      const [authorizedWorkspaceIds, setAuthorizedWorkspaceIds] = useState(() => (
        Array.isArray(initial.authorizedWorkspaceIds) ? [...new Set(initial.authorizedWorkspaceIds.map(String))] : []
      ));
      const [credential, setCredential] = useState(undefined);
      const [status, setStatus] = useState(undefined);
      const [statusFailed, setStatusFailed] = useState(false);
      const [tokenInput, setTokenInput] = useState("");
      const [generatedToken, setGeneratedToken] = useState("");
      const [tokenMessage, setTokenMessage] = useState("");
      const [testResult, setTestResult] = useState(undefined);
      const [testing, setTesting] = useState(false);
      const [saving, setSaving] = useState(false);
      const [saveMessage, setSaveMessage] = useState("");
      const [workspaceMessage, setWorkspaceMessage] = useState("");

      const workspaceSnapshot = useSyncExternalStore(
        actions.subscribeWorkspaces,
        actions.getWorkspacesSnapshot,
        actions.getWorkspacesSnapshot,
      );
      const workspaces = workspaceSnapshot?.items || [];

      useEffect(() => {
        const value = form?.state?.value;
        if (!value) return;
        setDraft({
          endpoint: value.endpoint || "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker",
          workerId: value.workerId || "deepseek-worker-windows",
          pollIntervalMs: String(value.pollIntervalMs ?? 4000),
          heartbeatIntervalMs: String(value.heartbeatIntervalMs ?? 20000),
          leaseRenewIntervalMs: String(value.leaseRenewIntervalMs ?? 20000),
          leaseWaitTimeoutMs: String(value.leaseWaitTimeoutMs ?? 1800000),
          trustedWorkspaceMode: value.trustedWorkspaceMode !== false,
          enableHeadlessFallback: value.enableHeadlessFallback !== false,
        });
        setAuthorizedWorkspaceIds(Array.isArray(value.authorizedWorkspaceIds)
          ? [...new Set(value.authorizedWorkspaceIds.map(String))] : []);
      }, [form?.state?.revision]);

      const workspaceKey = workspaces.map((workspace) => String(workspace.workspaceId)).join("|");
      useEffect(() => {
        if (workspaceSnapshot?.phase !== "ready") return;
        const available = new Set(workspaces.map((workspace) => String(workspace.workspaceId)));
        setAuthorizedWorkspaceIds((current) => {
          const next = current.filter((id) => available.has(id));
          if (next.length !== current.length) setWorkspaceMessage(t("removedMissing"));
          return next;
        });
      }, [workspaceSnapshot?.phase, workspaceKey]);

      const refreshCredential = async () => {
        try { setCredential(await actions.describeCredential()); }
        catch { setCredential(undefined); }
      };
      const refreshStatus = async () => {
        try {
          setStatus(await actions.status());
          setStatusFailed(false);
        } catch {
          setStatus(undefined);
          setStatusFailed(true);
        }
      };
      useEffect(() => {
        void refreshCredential();
        void refreshStatus();
        const timer = window.setInterval(() => { void refreshStatus(); }, 5000);
        return () => window.clearInterval(timer);
      }, []);

      const endpointValid = /^https:\/\//u.test(draft.endpoint.trim());
      const canWrite = Boolean(form?.state?.writable);

      const saveConfig = async () => {
        setSaveMessage("");
        if (!endpointValid) { setSaveMessage(t("invalidEndpoint")); return false; }
        const number = (value) => Number.parseInt(value, 10);
        const operations = [
          ["endpoint", draft.endpoint.trim()],
          ["workerId", draft.workerId.trim()],
          ["pollIntervalMs", number(draft.pollIntervalMs)],
          ["heartbeatIntervalMs", number(draft.heartbeatIntervalMs)],
          ["leaseRenewIntervalMs", number(draft.leaseRenewIntervalMs)],
          ["leaseWaitTimeoutMs", number(draft.leaseWaitTimeoutMs)],
          ["authorizedWorkspaceIds", [...authorizedWorkspaceIds]],
          ["trustedWorkspaceMode", draft.trustedWorkspaceMode],
          ["enableHeadlessFallback", draft.enableHeadlessFallback],
        ].map(([field, value]) => ({ op: "set", path: [field], value }));
        setSaving(true);
        try {
          const ok = await form.mutate(operations, form.state.revision);
          setSaveMessage(ok ? t("saved") : t("saveFailed"));
          if (ok) await refreshStatus();
          return ok;
        } finally {
          setSaving(false);
        }
      };

      const storeToken = async (value) => {
        if (!value) return;
        setTokenMessage("");
        try {
          const ok = await actions.storeCredential(value);
          if (!ok) { setTokenMessage(t("saveFailed")); return; }
          setTokenInput("");
          setGeneratedToken("");
          await refreshCredential();
          await refreshStatus();
        } catch {
          setTokenMessage(t("saveFailed"));
        }
      };

      const generate = async () => {
        setTokenMessage("");
        try {
          const value = await actions.generateToken();
          setGeneratedToken(value);
          setTokenInput("");
        } catch {
          setTokenMessage(t("saveFailed"));
        }
      };

      const test = async () => {
        setTesting(true);
        setTestResult(undefined);
        try {
          const saved = await saveConfig();
          if (!saved) return;
          setTestResult(await actions.test());
          await refreshStatus();
        } catch (error) {
          setTestResult({ ok: false, message: String(error?.message || error) });
        } finally {
          setTesting(false);
        }
      };

      const toggleWorkspace = (workspaceId, checked) => {
        setWorkspaceMessage("");
        setAuthorizedWorkspaceIds((current) => checked
          ? [...new Set([...current, workspaceId])]
          : current.filter((id) => id !== workspaceId));
      };

      const executionValue = status
        ? status.execution || "unknown"
        : statusFailed ? "unknown" : "detecting";
      const executionDisplay = executionValue === "native"
        ? t("native")
        : executionValue === "headless" ? t("headless")
          : executionValue === "detecting" ? t("detecting") : t("unknown");

      return h("div", { style: { display: "grid", gap: 16, maxWidth: 920 } },
        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("cloud")),
          h("div", { style: rowStyle },
            h(Field, { label: t("endpoint") }, h(Input, {
              value: draft.endpoint,
              onChange: (event) => setDraft((value) => ({ ...value, endpoint: event.target.value })),
              spellCheck: false,
            })),
            h(Field, { label: t("workerId") }, h(Input, {
              value: draft.workerId,
              onChange: (event) => setDraft((value) => ({ ...value, workerId: event.target.value })),
              spellCheck: false,
            })),
          ),
          h("div", { style: gridStyle },
            h("strong", null, t("token")),
            h("div", { style: rowStyle },
              h(StateDot, { state: credential?.configured ? "done" : "warning" }),
              h("span", null, credential?.configured ? t("configured") : t("unconfigured")),
            ),
            h("div", { style: rowStyle },
              h(Input, {
                type: "password",
                value: tokenInput,
                onChange: (event) => setTokenInput(event.target.value),
                placeholder: t("setToken"),
                autoComplete: "new-password",
                style: { minWidth: 320 },
              }),
              h(Button, {
                variant: "outline",
                disabled: !credential?.writable || !tokenInput,
                onClick: () => void storeToken(tokenInput),
              }, t("saveToken")),
              h(Button, { variant: "outline", onClick: () => void generate() }, t("generateToken")),
            ),
            generatedToken ? h("div", {
              style: {
                ...gridStyle,
                padding: 12,
                borderRadius: 8,
                background: "var(--dsw-color-bg-secondary, rgba(127,127,127,.08))",
              },
            },
              h("strong", null, t("generatedToken")),
              h("code", { style: { overflowWrap: "anywhere", userSelect: "all" } }, generatedToken),
              h("p", { style: mutedStyle }, t("tokenSiteHint")),
              h("div", { style: rowStyle },
                h(Button, {
                  variant: "outline",
                  onClick: async () => {
                    await navigator.clipboard.writeText(generatedToken);
                    setTokenMessage(t("copied"));
                  },
                }, t("copy")),
                h(Button, {
                  variant: "primary",
                  disabled: !credential?.writable,
                  onClick: () => void storeToken(generatedToken),
                }, t("saveToken")),
              ),
            ) : null,
            h("p", { style: mutedStyle }, t("tokenHint")),
            tokenMessage ? h("p", { role: "status", style: mutedStyle }, tokenMessage) : null,
          ),
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("status")),
          h(StatusLine, { label: t("connector"), value: status?.connector || "loaded", display: t("loaded") }),
          h(StatusLine, { label: t("harness"), value: executionValue, display: executionDisplay }),
          h(StatusLine, {
            label: t("credential"),
            value: credential?.configured ? "configured" : "unconfigured",
            display: credential?.configured ? t("configured") : t("unconfigured"),
          }),
          h(StatusLine, {
            label: t("cloudStatus"),
            value: status?.cloud || "untested",
            display: t(status?.cloud || "untested"),
          }),
          h(StatusLine, {
            label: t("worker"),
            value: status?.worker || "paused",
            display: status?.worker || t("paused"),
          }),
          h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
            h("span", null, t("heartbeat")),
            h("span", null, status?.lastHeartbeat || t("noHeartbeat")),
          ),
          status?.missingWorkspaceIds?.length
            ? h("p", { role: "alert", style: mutedStyle }, t("workspaceMissingStatus")) : null,
          status?.lastError ? h("p", { style: mutedStyle }, status.lastError) : null,
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("workspaces")),
          h("p", { style: mutedStyle }, t("workspaceHint")),
          workspaceSnapshot?.phase !== "ready"
            ? h("p", { style: mutedStyle }, t("workspaceLoading"))
            : workspaces.length === 0
              ? h("p", { style: mutedStyle }, t("noWorkspaces"))
              : h("div", { style: gridStyle },
                  ...workspaces.map((workspace) => {
                    const id = String(workspace.workspaceId);
                    return h("div", {
                      key: id,
                      style: {
                        display: "grid",
                        gap: 4,
                        padding: 10,
                        borderRadius: 8,
                        background: "var(--dsw-color-bg-secondary, rgba(127,127,127,.06))",
                      },
                    },
                      h(Checkbox, {
                        checked: authorizedWorkspaceIds.includes(id),
                        onChange: (checked) => toggleWorkspace(id, checked),
                        label: workspace.title || id,
                      }),
                      h("code", { style: { opacity: 0.72, fontSize: 12 } }, id),
                    );
                  }),
                ),
          workspaceMessage ? h("p", { role: "status", style: mutedStyle }, workspaceMessage) : null,
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("permissionMode")),
          h("div", { style: rowStyle },
            h(Switch, {
              checked: draft.trustedWorkspaceMode,
              label: t("trustedMode"),
              onChange: (next) => setDraft((value) => ({ ...value, trustedWorkspaceMode: next })),
            }),
            h("strong", null, t("trustedMode")),
          ),
          h("p", { style: mutedStyle }, draft.trustedWorkspaceMode ? t("trustedHint") : t("restrictedHint")),
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("advanced")),
          h("div", { style: rowStyle },
            h(Field, { label: t("poll") }, h(Input, {
              type: "number", min: 1000, max: 60000, value: draft.pollIntervalMs,
              onChange: (event) => setDraft((value) => ({ ...value, pollIntervalMs: event.target.value })),
            })),
            h(Field, { label: t("heartbeatInterval") }, h(Input, {
              type: "number", min: 5000, max: 300000, value: draft.heartbeatIntervalMs,
              onChange: (event) => setDraft((value) => ({ ...value, heartbeatIntervalMs: event.target.value })),
            })),
            h(Field, { label: t("lease") }, h(Input, {
              type: "number", min: 5000, max: 55000, value: draft.leaseRenewIntervalMs,
              onChange: (event) => setDraft((value) => ({ ...value, leaseRenewIntervalMs: event.target.value })),
            })),
            h(Field, { label: t("leaseWait") }, h(Input, {
              type: "number", min: 10000, max: 86400000, value: draft.leaseWaitTimeoutMs,
              onChange: (event) => setDraft((value) => ({ ...value, leaseWaitTimeoutMs: event.target.value })),
            })),
          ),
          h("div", { style: rowStyle },
            h(Switch, {
              checked: draft.enableHeadlessFallback,
              label: t("fallback"),
              onChange: (next) => setDraft((value) => ({ ...value, enableHeadlessFallback: next })),
            }),
            h("span", null, t("fallback")),
          ),
        ),

        h("div", { style: rowStyle },
          h(Button, {
            variant: "primary",
            disabled: saving || !canWrite || !endpointValid,
            onClick: () => void saveConfig(),
          }, saving ? t("saving") : t("saveConfig")),
          h(Button, {
            variant: "outline",
            disabled: testing || saving || !canWrite || !endpointValid,
            onClick: () => void test(),
          }, testing ? t("testing") : t("test")),
          saveMessage ? h("span", { role: "status", style: mutedStyle }, saveMessage) : null,
          testResult ? h("span", { role: "status", style: mutedStyle },
            `${testResult.ok ? "✓" : "⚠"} ${testResult.message}`) : null,
        ),
      );
    }

    function registerUi(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "deepseek-worker-connector: locale");
      const actions = {
        getWorkspacesSnapshot: () => ctx.workspaces.list.getSnapshot(),
        subscribeWorkspaces: (listener) => ctx.workspaces.list.subscribe(listener),
        async status() {
          const response = await ctx.remote.deepseekWorkerConnector.status();
          if (!response.ok) throw response.error;
          return response.value;
        },
        async test() {
          const response = await ctx.remote.deepseekWorkerConnector.test();
          if (!response.ok) throw response.error;
          return response.value;
        },
        async generateToken() {
          const response = await ctx.remote.deepseekWorkerConnector.generateToken();
          if (!response.ok) throw response.error;
          return response.value.token;
        },
        async describeCredential() {
          const response = await ctx.remote.credentials.describe([TOKEN_REF]);
          if (!response.ok) throw response.error;
          return response.value[TOKEN_REF] || { configured: false, writable: false };
        },
        async storeCredential(value) {
          const response = await ctx.remote.credentials.set(TOKEN_REF, value);
          return response.ok;
        },
      };

      ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
        name: "plugins.row.config",
        key: ROW_KEY,
        locale: NS,
        inject: () => ({ actions }),
      }, (props) => props.view === "summary" ? props.t("summary") : h(ConfigPage, props)));
    }

    return {
      inject: ["remote"],
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(contribution);
        const ui = ctx.inject([
          "remote",
          "remote.deepseekWorkerConnector",
          "remote.credentials",
          "workspaces",
          "slots",
          "locale",
        ], registerUi);
        try {
          await ui;
        } catch (error) {
          await ui.dispose();
          await disposeRemote();
          throw error;
        }
        return async () => {
          await ui.dispose();
          await disposeRemote();
        };
      },
    };
  },
});
