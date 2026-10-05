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
      descriptors: ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing"].map((method) => ({
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
      summary: "绑定 Harness 原生 Workspace，并一键配对 DeepSeek Worker Cloud",
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
      tokenHint: "高级兼容模式：手动 Token 仅用于旧 Cloud 或诊断。0.3.0 正常配对不需要在 Site 后台配置 Secret。",
      tokenSiteHint: "手动 Token 不会上传到页面或 Git；正式配对请使用上方“连接 DeepSeek Worker”。",
      pairing: "设备配对",
      pairConnect: "连接 DeepSeek Worker",
      pairConnecting: "正在创建配对…",
      pairCheck: "检查配对状态",
      pairDisconnect: "断开配对",
      pairPending: "等待你确认配对",
      pairPaired: "已配对",
      pairUnpaired: "未配对",
      pairUnknown: "状态未知",
      pairCode: "配对码",
      pairOpen: "打开配对页面",
      pairHint: "首次连接会在本机自动生成独立 Worker 凭据并保存到 Harness Credentials。云端只保存凭据哈希，不需要共享全局 Site Secret。",
      legacyToken: "高级：手动 Token（兼容旧 Cloud / 诊断）",
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
      restrictedHint: "关闭后进入受限模式。0.2.1 会暂停远程任务领取，而不是伪造一个并不存在的半权限沙箱。",
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
      pairing: "Device pairing",
      pairConnect: "Connect DeepSeek Worker",
      pairConnecting: "Starting pairing…",
      pairCheck: "Check pairing status",
      pairDisconnect: "Disconnect",
      pairPending: "Waiting for approval",
      pairPaired: "Paired",
      pairUnpaired: "Not paired",
      pairUnknown: "Unknown",
      pairCode: "Pairing code",
      pairOpen: "Open pairing page",
      pairHint: "First connection creates a unique local Worker credential automatically. The Cloud stores only its hash; no shared Site secret is required.",
      legacyToken: "Advanced: manual Token (legacy Cloud / diagnostics)",
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

    function remoteCode(error) {
      return typeof error?.code === "string" && error.code ? error.code : "unknown";
    }

    function hostRemoteFailure(error, operation) {
      const code = remoteCode(error);
      if (["gateway/service-unavailable", "gateway/invocation-unavailable"].includes(code)) {
        return `Host Remote 不可用（${code}，${operation}）`;
      }
      if (["gateway/definition-unavailable", "gateway/method-unavailable"].includes(code)) {
        return `Gateway service unavailable（${code}，${operation}）`;
      }
      if (code.startsWith("gateway/")) {
        return `Host Remote 调用失败（${code}，${operation}）`;
      }
      return `Host Remote 调用失败（${code}，${operation}）`;
    }

    function credentialFailure(error, operation) {
      const code = remoteCode(error);
      if (code === "credential/rejected") {
        return operation === "set"
          ? "Token 保存失败：Credential provider 拒绝写入（credential/rejected）"
          : "Credential provider 拒绝读取（credential/rejected）";
      }
      if (["gateway/service-unavailable", "gateway/invocation-unavailable", "gateway/method-unavailable"].includes(code)) {
        return `Credential Remote 不可用（${code}）`;
      }
      if (code === "gateway/internal") {
        return operation === "set"
          ? "Credential provider 不可写或不可用（gateway/internal）"
          : "Credential provider 不可用（gateway/internal）";
      }
      return operation === "set"
        ? `Token 保存失败（${code}）`
        : `Credential 读取失败（${code}）`;
    }

    function stateDot(value) {
      if (["loaded", "configured", "online", "native", "paired"].includes(value)) return "done";
      if (["detecting", "pending"].includes(value)) return "ongoing";
      if (["paused", "headless", "untested", "unknown", "unpaired"].includes(value)) return "warning";
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
      const [statusMessage, setStatusMessage] = useState("");
      const [tokenInput, setTokenInput] = useState("");
      const [generatedToken, setGeneratedToken] = useState("");
      const [tokenMessage, setTokenMessage] = useState("");
      const [pairing, setPairing] = useState(undefined);
      const [pairingBusy, setPairingBusy] = useState(false);
      const [pairingMessage, setPairingMessage] = useState("");
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
        try {
          setCredential(await actions.describeCredential());
        } catch (error) {
          setCredential(undefined);
          setTokenMessage(error instanceof Error ? error.message : "Credential 读取失败");
        }
      };
      const refreshStatus = async () => {
        try {
          setStatus(await actions.status());
          setStatusFailed(false);
          setStatusMessage("");
        } catch (error) {
          setStatus(undefined);
          setStatusFailed(true);
          setStatusMessage(error instanceof Error ? error.message : "Host Remote 不可用");
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
        if (credential?.writable === false) {
          setTokenMessage("Credential provider 不可写。");
          return;
        }
        try {
          await actions.storeCredential(value);
          setTokenInput("");
          setGeneratedToken("");
          await refreshCredential();
          await refreshStatus();
        } catch (error) {
          setTokenMessage(error instanceof Error ? error.message : "Token 保存失败");
        }
      };

      const generate = async () => {
        setTokenMessage("");
        try {
          const value = await actions.generateToken();
          setGeneratedToken(value);
          setTokenInput("");
        } catch (error) {
          setTokenMessage(error instanceof Error ? error.message : "Host Remote 不可用");
        }
      };

      const connectPairing = async () => {
        setPairingBusy(true);
        setPairingMessage("");
        try {
          const saved = await saveConfig();
          if (!saved) return;
          const result = await actions.beginPairing();
          setPairing(result);
          if (!result.ok) { setPairingMessage(result.message || "配对失败"); return; }
          if (result.approvalUrl) window.open(result.approvalUrl, "_blank", "noopener,noreferrer");
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "配对失败");
        } finally { setPairingBusy(false); }
      };

      const checkPairing = async () => {
        setPairingMessage("");
        try {
          const result = await actions.pairingStatus();
          setPairing(result);
          if (!result.ok) setPairingMessage(result.message || "无法检查配对状态");
          if (result.state === "paired") await refreshStatus();
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "无法检查配对状态");
        }
      };

      const disconnectPairing = async () => {
        setPairingBusy(true);
        setPairingMessage("");
        try {
          const result = await actions.disconnectPairing();
          setPairing(result);
          if (!result.ok) setPairingMessage(result.message || "断开配对失败");
          await refreshCredential();
          await refreshStatus();
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "断开配对失败");
        } finally { setPairingBusy(false); }
      };

      useEffect(() => {
        if (pairing?.state !== "pending") return undefined;
        const timer = window.setInterval(() => { void checkPairing(); }, 3000);
        return () => window.clearInterval(timer);
      }, [pairing?.state]);

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
            h("strong", null, t("pairing")),
            h("p", { style: mutedStyle }, t("pairHint")),
            h("div", { style: rowStyle },
              h(StateDot, { state: stateDot(pairing?.state || status?.pairing || "unpaired") }),
              h("span", null,
                (pairing?.state || status?.pairing) === "paired" ? t("pairPaired")
                  : (pairing?.state || status?.pairing) === "pending" ? t("pairPending")
                    : (pairing?.state || status?.pairing) === "unpaired" ? t("pairUnpaired") : t("pairUnknown")),
            ),
            (pairing?.pairingCode || status?.pairingCode)
              ? h("div", { style: gridStyle },
                  h("span", null, t("pairCode")),
                  h("code", { style: { fontSize: 18, userSelect: "all" } }, pairing?.pairingCode || status?.pairingCode),
                ) : null,
            h("div", { style: rowStyle },
              (pairing?.state || status?.pairing) === "paired"
                ? h(Button, { variant: "outline", disabled: pairingBusy, onClick: () => void disconnectPairing() }, t("pairDisconnect"))
                : h(Button, { variant: "primary", disabled: pairingBusy || !canWrite || !endpointValid, onClick: () => void connectPairing() }, pairingBusy ? t("pairConnecting") : t("pairConnect")),
              (pairing?.state || status?.pairing) === "pending"
                ? h(Button, { variant: "outline", onClick: () => void checkPairing() }, t("pairCheck")) : null,
              (pairing?.approvalUrl || status?.approvalUrl)
                ? h(Button, { variant: "outline", onClick: () => window.open(pairing?.approvalUrl || status?.approvalUrl, "_blank", "noopener,noreferrer") }, t("pairOpen")) : null,
            ),
            pairingMessage ? h("p", { role: "status", style: mutedStyle }, pairingMessage) : null,
          ),
          h("details", null,
            h("summary", { style: { cursor: "pointer" } }, t("legacyToken")),
            h("div", { style: { ...gridStyle, marginTop: 12 } },
              h("div", { style: rowStyle },
                h(StateDot, { state: credential?.configured ? "done" : "warning" }),
                h("span", null, credential?.configured ? t("configured") : t("unconfigured")),
              ),
              h("div", { style: rowStyle },
                h(Input, {
                  type: "password", value: tokenInput,
                  onChange: (event) => setTokenInput(event.target.value),
                  placeholder: t("setToken"), autoComplete: "new-password",
                  style: { minWidth: 320 },
                }),
                h(Button, { variant: "outline", disabled: !credential?.writable || !tokenInput, onClick: () => void storeToken(tokenInput) }, t("saveToken")),
                h(Button, { variant: "outline", onClick: () => void generate() }, t("generateToken")),
              ),
              generatedToken ? h("div", { style: gridStyle },
                h("code", { style: { overflowWrap: "anywhere", userSelect: "all" } }, generatedToken),
                h("p", { style: mutedStyle }, t("tokenSiteHint")),
              ) : null,
              h("p", { style: mutedStyle }, t("tokenHint")),
              tokenMessage ? h("p", { role: "status", style: mutedStyle }, tokenMessage) : null,
            ),
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
            label: t("pairing"),
            value: status?.pairing || "unpaired",
            display: status?.pairing === "paired" ? t("pairPaired") : status?.pairing === "pending" ? t("pairPending") : status?.pairing === "unpaired" ? t("pairUnpaired") : t("pairUnknown"),
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
          statusMessage ? h("p", { role: "alert", style: mutedStyle }, statusMessage) : null,
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
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "status"));
          return response.value;
        },
        async test() {
          const response = await ctx.remote.deepseekWorkerConnector.test();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "test"));
          return response.value;
        },
        async beginPairing() {
          const response = await ctx.remote.deepseekWorkerConnector.beginPairing();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "beginPairing"));
          return response.value;
        },
        async pairingStatus() {
          const response = await ctx.remote.deepseekWorkerConnector.pairingStatus();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "pairingStatus"));
          return response.value;
        },
        async disconnectPairing() {
          const response = await ctx.remote.deepseekWorkerConnector.disconnectPairing();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "disconnectPairing"));
          return response.value;
        },
        async generateToken() {
          const response = await ctx.remote.deepseekWorkerConnector.generateToken();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "generateToken"));
          return response.value.token;
        },
        async describeCredential() {
          const response = await ctx.remote.credentials.describe([TOKEN_REF]);
          if (!response.ok) throw new Error(credentialFailure(response.error, "describe"));
          return response.value[TOKEN_REF] || { configured: false, writable: false };
        },
        async storeCredential(value) {
          const response = await ctx.remote.credentials.set(TOKEN_REF, value);
          if (!response.ok) throw new Error(credentialFailure(response.error, "set"));
          return true;
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
