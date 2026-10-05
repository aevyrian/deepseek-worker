/** Prebuilt DeepSeek Harness browser half. Git installs can use it without a local build step. */
window.__ModuleLoader__.load({
  id: "deepseek-worker-connector",
  factory(require) {
    const React = require("react");
    const { Button, Input, StateDot, Switch } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;
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
      summary: "配置云端连接、Worker Token、Workspace 与运行状态",
      title: "DeepSeek Worker Connector",
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
      tokenHint: "Token 保存后无法再次查看。如果遗失，请重新生成并同时更新 Site Secret LOCAL_WORKER_TOKEN。",
      tokenSiteHint: "请把这个 Token 同时配置到 DeepSeek Worker Site Secret：LOCAL_WORKER_TOKEN。",
      status: "连接状态",
      connector: "Connector",
      harness: "Harness execution",
      credential: "Credential",
      cloudStatus: "Cloud",
      worker: "Worker",
      heartbeat: "最后心跳",
      loaded: "已加载",
      native: "Native Harness",
      headless: "Headless fallback",
      headlessHint: "当前 Harness profile 没有提供原生 Session Controller，任务会退回 headless 模式。",
      online: "在线",
      offline: "离线",
      unauthenticated: "未认证",
      untested: "未测试",
      paused: "paused",
      error: "error",
      test: "测试连接",
      testing: "测试中…",
      workspace: "Workspace",
      workspaceId: "Workspace ID",
      localPath: "本地目录",
      addWorkspace: "添加 Workspace",
      remove: "删除",
      workspaceHint: "Cloud 只会收到 workspace_id；本地绝对路径不会由 Cloud 指定。空白名单会 fail closed 并暂停 Worker。",
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
      invalidWorkspaceId: "Workspace ID 不能为空且不能重复。",
      invalidPath: "本地路径必须是 Windows 或 POSIX 绝对路径。",
      credentialReadFailed: "无法读取 Credential 状态。",
      tokenSaveFailed: "Token 保存失败。",
      generatedOnly: "仅在当前页面显示；保存或离开页面后无法重新读取。",
      noHeartbeat: "--",
    };
    const en = {
      ...zh,
      summary: "Configure cloud connection, Worker Token, workspaces, and runtime status",
      title: "DeepSeek Worker Connector",
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
      status: "Connection status",
      connector: "Connector",
      harness: "Harness execution",
      credential: "Credential",
      cloudStatus: "Cloud",
      worker: "Worker",
      heartbeat: "Last heartbeat",
      loaded: "Loaded",
      native: "Native Harness",
      headless: "Headless fallback",
      online: "Online",
      offline: "Offline",
      unauthenticated: "Unauthenticated",
      untested: "Untested",
      test: "Test connection",
      testing: "Testing…",
      workspace: "Workspace",
      workspaceId: "Workspace ID",
      localPath: "Local path",
      addWorkspace: "Add Workspace",
      remove: "Remove",
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

    function absolutePath(value) {
      return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value || "");
    }

    function workspaceDraft(value) {
      const allowlist = value && typeof value.workspaceAllowlist === "object" && value.workspaceAllowlist !== null
        ? value.workspaceAllowlist : {};
      return Object.entries(allowlist).map(([id, path]) => ({ id, path: String(path) }));
    }

    function statusDot(value) {
      if (["loaded", "configured", "online", "native"].includes(value)) return "done";
      if (["paused", "headless", "untested", "unknown"].includes(value)) return "warning";
      if (["offline", "unauthenticated", "unconfigured", "error"].includes(value)) return "error";
      return "idle";
    }

    function StatusLine({ label, value, display }) {
      return h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
        h("span", null, label),
        h("span", { style: rowStyle }, h(StateDot, { state: statusDot(value) }), h("span", null, display ?? value)),
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
        enableHeadlessFallback: initial.enableHeadlessFallback !== false,
      }));
      const [workspaces, setWorkspaces] = useState(() => workspaceDraft(initial));
      const [credential, setCredential] = useState(undefined);
      const [status, setStatus] = useState(undefined);
      const [tokenInput, setTokenInput] = useState("");
      const [generatedToken, setGeneratedToken] = useState("");
      const [tokenMessage, setTokenMessage] = useState("");
      const [testResult, setTestResult] = useState(undefined);
      const [testing, setTesting] = useState(false);
      const [saving, setSaving] = useState(false);
      const [saveMessage, setSaveMessage] = useState("");

      const revision = form?.state?.revision;
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
          enableHeadlessFallback: value.enableHeadlessFallback !== false,
        });
        setWorkspaces(workspaceDraft(value));
      }, [revision]);

      const refreshCredential = async () => {
        try { setCredential(await actions.describeCredential()); }
        catch { setCredential(undefined); }
      };
      const refreshStatus = async () => {
        try { setStatus(await actions.status()); } catch {}
      };
      useEffect(() => {
        void refreshCredential();
        void refreshStatus();
        const timer = window.setInterval(() => { void refreshStatus(); }, 5000);
        return () => window.clearInterval(timer);
      }, []);

      const workspaceValidation = useMemo(() => {
        const seen = new Set();
        for (const row of workspaces) {
          const id = row.id.trim();
          if (!id || seen.has(id)) return t("invalidWorkspaceId");
          seen.add(id);
          if (!absolutePath(row.path.trim())) return t("invalidPath");
        }
        return "";
      }, [workspaces, t]);

      const endpointValid = /^https:\/\//u.test(draft.endpoint.trim());
      const canWrite = Boolean(form?.state?.writable);

      const saveConfig = async () => {
        setSaveMessage("");
        if (!endpointValid) { setSaveMessage(t("invalidEndpoint")); return; }
        if (workspaceValidation) { setSaveMessage(workspaceValidation); return; }
        const allowlist = Object.fromEntries(workspaces.map((row) => [row.id.trim(), row.path.trim()]));
        const number = (value) => Number.parseInt(value, 10);
        const operations = [
          ["endpoint", draft.endpoint.trim()], ["workerId", draft.workerId.trim()],
          ["pollIntervalMs", number(draft.pollIntervalMs)], ["heartbeatIntervalMs", number(draft.heartbeatIntervalMs)],
          ["leaseRenewIntervalMs", number(draft.leaseRenewIntervalMs)], ["leaseWaitTimeoutMs", number(draft.leaseWaitTimeoutMs)],
          ["workspaceAllowlist", allowlist], ["enableHeadlessFallback", draft.enableHeadlessFallback],
        ].map(([field, value]) => ({ op: "set", path: [field], value }));
        setSaving(true);
        try {
          const ok = await form.mutate(operations, form.state.revision);
          setSaveMessage(ok ? t("saved") : t("saveFailed"));
          if (ok) await refreshStatus();
        } finally { setSaving(false); }
      };

      const storeToken = async (value) => {
        if (!value) return;
        setTokenMessage("");
        try {
          const ok = await actions.storeCredential(value);
          if (!ok) { setTokenMessage(t("tokenSaveFailed")); return; }
          setTokenInput("");
          setGeneratedToken("");
          await refreshCredential();
          await refreshStatus();
        } catch { setTokenMessage(t("tokenSaveFailed")); }
      };

      const generate = async () => {
        setTokenMessage("");
        try {
          const value = await actions.generateToken();
          setGeneratedToken(value);
          setTokenInput("");
        } catch { setTokenMessage(t("tokenSaveFailed")); }
      };

      const test = async () => {
        setTesting(true); setTestResult(undefined);
        try { setTestResult(await actions.test()); await refreshStatus(); }
        catch (error) { setTestResult({ ok: false, message: String(error?.message || error) }); }
        finally { setTesting(false); }
      };

      const updateWorkspace = (index, field, value) => setWorkspaces((rows) => rows.map((row, i) => i === index ? { ...row, [field]: value } : row));

      return h("div", { style: { display: "grid", gap: 16, maxWidth: 920 } },
        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("cloud")),
          h("div", { style: rowStyle },
            h(Field, { label: t("endpoint") }, h(Input, { value: draft.endpoint, onChange: (e) => setDraft((d) => ({ ...d, endpoint: e.target.value })), spellCheck: false })),
            h(Field, { label: t("workerId") }, h(Input, { value: draft.workerId, onChange: (e) => setDraft((d) => ({ ...d, workerId: e.target.value })), spellCheck: false })),
          ),
          h("div", { style: gridStyle },
            h("strong", null, t("token")),
            h("div", { style: rowStyle },
              h(StateDot, { state: credential?.configured ? "done" : "warning" }),
              h("span", null, credential?.configured ? t("configured") : t("unconfigured")),
            ),
            h("div", { style: rowStyle },
              h(Input, { type: "password", value: tokenInput, onChange: (e) => setTokenInput(e.target.value), placeholder: t("setToken"), autoComplete: "new-password", style: { minWidth: 320 } }),
              h(Button, { variant: "outline", disabled: !credential?.writable || !tokenInput, onClick: () => void storeToken(tokenInput) }, t("saveToken")),
              h(Button, { variant: "outline", onClick: () => void generate() }, t("generateToken")),
            ),
            generatedToken ? h("div", { style: { ...gridStyle, padding: 12, borderRadius: 8, background: "var(--dsw-color-bg-secondary, rgba(127,127,127,.08))" } },
              h("strong", null, t("generatedToken")),
              h("code", { style: { overflowWrap: "anywhere", userSelect: "all" } }, generatedToken),
              h("p", { style: mutedStyle }, t("tokenSiteHint")),
              h("p", { style: mutedStyle }, t("generatedOnly")),
              h("div", { style: rowStyle },
                h(Button, { variant: "outline", onClick: async () => { await navigator.clipboard.writeText(generatedToken); setTokenMessage(t("copied")); } }, t("copy")),
                h(Button, { variant: "primary", disabled: !credential?.writable, onClick: () => void storeToken(generatedToken) }, t("saveToken")),
              ),
            ) : null,
            h("p", { style: mutedStyle }, t("tokenHint")),
            tokenMessage ? h("p", { role: "status", style: mutedStyle }, tokenMessage) : null,
          ),
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("status")),
          h(StatusLine, { label: t("connector"), value: status?.connector || "loaded", display: t("loaded") }),
          h(StatusLine, { label: t("harness"), value: status?.execution || "headless", display: status?.execution === "native" ? t("native") : t("headless") }),
          status?.execution === "headless" ? h("p", { style: mutedStyle }, t("headlessHint")) : null,
          h(StatusLine, { label: t("credential"), value: credential?.configured ? "configured" : "unconfigured", display: credential?.configured ? t("configured") : t("unconfigured") }),
          h(StatusLine, { label: t("cloudStatus"), value: status?.cloud || "untested", display: t(status?.cloud || "untested") }),
          h(StatusLine, { label: t("worker"), value: status?.worker || "paused", display: status?.worker || t("paused") }),
          h("div", { style: { ...rowStyle, justifyContent: "space-between" } }, h("span", null, t("heartbeat")), h("span", null, status?.lastHeartbeat || t("noHeartbeat"))),
          status?.lastError ? h("p", { style: mutedStyle }, status.lastError) : null,
          h("div", { style: rowStyle }, h(Button, { variant: "primary", disabled: testing, onClick: () => void test() }, testing ? t("testing") : t("test"))),
          testResult ? h("p", { role: "status", style: { margin: 0 } }, `${testResult.ok ? "✓" : "⚠"} ${testResult.message}`) : null,
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("workspace")),
          h("p", { style: mutedStyle }, t("workspaceHint")),
          ...workspaces.map((row, index) => h("div", { key: `${index}`, style: rowStyle },
            h(Field, { label: t("workspaceId") }, h(Input, { value: row.id, onChange: (e) => updateWorkspace(index, "id", e.target.value), spellCheck: false })),
            h(Field, { label: t("localPath") }, h(Input, { value: row.path, onChange: (e) => updateWorkspace(index, "path", e.target.value), spellCheck: false })),
            h(Button, { variant: "outline", onClick: () => setWorkspaces((rows) => rows.filter((_, i) => i !== index)) }, t("remove")),
          )),
          h(Button, { variant: "outline", onClick: () => setWorkspaces((rows) => [...rows, { id: "", path: "" }]) }, t("addWorkspace")),
          workspaceValidation ? h("p", { role: "alert", style: mutedStyle }, workspaceValidation) : null,
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("advanced")),
          h("div", { style: rowStyle },
            h(Field, { label: t("poll") }, h(Input, { type: "number", min: 1000, max: 60000, value: draft.pollIntervalMs, onChange: (e) => setDraft((d) => ({ ...d, pollIntervalMs: e.target.value })) })),
            h(Field, { label: t("heartbeatInterval") }, h(Input, { type: "number", min: 5000, max: 300000, value: draft.heartbeatIntervalMs, onChange: (e) => setDraft((d) => ({ ...d, heartbeatIntervalMs: e.target.value })) })),
            h(Field, { label: t("lease") }, h(Input, { type: "number", min: 5000, max: 55000, value: draft.leaseRenewIntervalMs, onChange: (e) => setDraft((d) => ({ ...d, leaseRenewIntervalMs: e.target.value })) })),
            h(Field, { label: t("leaseWait") }, h(Input, { type: "number", min: 10000, max: 86400000, value: draft.leaseWaitTimeoutMs, onChange: (e) => setDraft((d) => ({ ...d, leaseWaitTimeoutMs: e.target.value })) })),
          ),
          h("div", { style: rowStyle },
            h(Switch, { checked: draft.enableHeadlessFallback, label: t("fallback"), onChange: (next) => setDraft((d) => ({ ...d, enableHeadlessFallback: next })) }),
            h("span", null, t("fallback")),
          ),
        ),

        h("div", { style: rowStyle },
          h(Button, { variant: "primary", disabled: saving || !canWrite || !endpointValid || Boolean(workspaceValidation), onClick: () => void saveConfig() }, saving ? t("saving") : t("saveConfig")),
          saveMessage ? h("span", { role: "status", style: mutedStyle }, saveMessage) : null,
        ),
      );
    }

    return {
      inject: ["slots", "locale", "remote", "remote.credentials"],
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(contribution);
        ctx.effect(() => disposeRemote, "deepseek-worker-connector: remote contribution");
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "deepseek-worker-connector: locale");

        const actions = {
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
      },
    };
  },
});
