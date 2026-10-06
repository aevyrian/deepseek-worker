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
      descriptors: ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates", "openBridgeBrowser", "testBridge"].map((method) => ({
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
      summary: "连接 ChatGPT，并授权 Harness Workspace",
      deviceConnection: "设备连接",
      connectionUnpaired: "未连接",
      connectionConnecting: "正在连接",
      connectionPending: "等待确认",
      connectionPaired: "已连接",
      connectionFailed: "连接失败",
      installConnect: "安装并连接 ChatGPT",
      reconnect: "重新连接 ChatGPT",
      openConnection: "打开连接页面",
      checkStatus: "检查状态",
      openChatGPT: "在 ChatGPT 中打开",
      disconnect: "断开连接",
      connecting: "正在连接…",
      connectionHint: "Connector 会自动创建本机凭据、打开 Cloud 连接页面，并等待 ChatGPT 端确认。",
      cloudStatus: "Cloud",
      harness: "Harness",
      workspacesAuthorized: "授权 Workspace",
      heartbeat: "最后心跳",
      native: "Native Harness",
      headless: "Headless fallback",
      detecting: "检测中",
      unknown: "未知",
      online: "在线",
      offline: "离线",
      unauthenticated: "未认证",
      untested: "未测试",
      noHeartbeat: "--",
      workspaces: "授权 Workspace",
      workspaceHint: "选择允许 ChatGPT 任务使用的 Harness Workspace。",
      workspaceLoading: "正在读取 Harness Workspace…",
      noWorkspaces: "Harness 当前没有 Workspace。请先在左侧“工作区”创建项目。",
      removedMissing: "已移除 Harness 中不存在的 Workspace；请保存配置。",
      trustedMode: "受信任工作区模式",
      trustedHint: "已授权 Workspace 内不额外收紧 Harness 权限；实际能力仍由 Harness Profile、工具审批和操作系统决定。",
      restrictedHint: "关闭后暂停远程任务领取。",
      chatBridge: "免费 Chat Bridge",
      chatBridgeHint: "备用免费通道：任务完成后把一条很短的 [DSW] 控制消息发回你绑定的 ChatGPT 对话；真实结果仍由 ChatGPT 通过 MCP 读取。",
      chatBridgeEnabled: "启用 Chat Bridge",
      chatBridgeChatUrl: "绑定的 ChatGPT 对话 URL",
      chatBridgeUrlHint: "复制你希望作为总控的 ChatGPT 对话地址（chatgpt.com）。只保存在本机 Connector 配置中。",
      chatBridgeOpen: "打开桥接浏览器 / 登录 ChatGPT",
      chatBridgeTest: "测试桥接浏览器",
      chatBridgeBound: "已绑定",
      chatBridgeUnbound: "未绑定",
      chatBridgeReady: "可用",
      chatBridgeNeedsLogin: "需要登录",
      advanced: "高级 / 诊断",
      endpoint: "Cloud Endpoint",
      workerId: "Worker ID",
      token: "手动 Worker Token",
      configured: "已配置",
      unconfigured: "未配置",
      setToken: "输入兼容 Token",
      generateToken: "生成随机 Token",
      saveToken: "保存 Token",
      generatedToken: "刚生成的 Token",
      tokenHint: "仅用于旧 Cloud、开发、诊断或恢复。普通连接流程不需要查看或复制 Token。",
      pairingCode: "配对码",
      connector: "Connector",
      credential: "Credential",
      worker: "Worker",
      activeTasks: "活动任务",
      concurrency: "外层并发任务数",
      concurrencyHint: "允许 Connector 同时运行多个独立 Native Session。默认 24；Harness 自身的子智能体限制仍独立生效。",
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
      test: "测试连接",
      testing: "测试中…",
      workspaceRequired: "请先选择至少一个 Harness Workspace。",
      version: "版本",
      runningVersion: "当前运行版本",
      installedVersion: "磁盘已安装版本",
      installedRestartHint: "已安装新版本，重启 Harness 后切换到该版本。",
      autoUpdate: "自动更新",
      updateChannel: "更新通道",
      updateStatus: "更新状态",
      enabled: "开启",
      disabled: "关闭",
      stable: "正式版",
      preview: "测试版",
      updateIdle: "等待自动检查",
      updateChecking: "正在检查更新",
      updateCurrent: "已是最新版本",
      updateAvailable: "发现新版本",
      updateWaitingIdle: "等待当前任务完成",
      updateInstalling: "正在安装更新",
      updateRestart: "更新已安装，重启 Harness 后生效",
      updateFailed: "自动更新失败。当前版本仍可继续使用。",
      retryUpdate: "重试",
      latestVersion: "最新版本",
      lastChecked: "上次检查",
    };

    const en = {
      ...zh,
      summary: "Connect ChatGPT and authorize Harness Workspaces",
      deviceConnection: "Device connection",
      connectionUnpaired: "Not connected",
      connectionConnecting: "Connecting",
      connectionPending: "Waiting for approval",
      connectionPaired: "Connected",
      connectionFailed: "Connection failed",
      installConnect: "Install and connect ChatGPT",
      reconnect: "Reconnect ChatGPT",
      openConnection: "Open connection page",
      checkStatus: "Check status",
      openChatGPT: "Open in ChatGPT",
      disconnect: "Disconnect",
      connecting: "Connecting…",
      connectionHint: "The Connector creates a local credential, opens the Cloud setup page, and waits for ChatGPT approval.",
      cloudStatus: "Cloud",
      harness: "Harness",
      workspacesAuthorized: "Authorized Workspaces",
      heartbeat: "Last heartbeat",
      workspaces: "Authorized Workspaces",
      workspaceHint: "Choose which Harness Workspaces ChatGPT tasks may use.",
      workspaceLoading: "Loading Harness Workspaces…",
      noWorkspaces: "No Harness Workspace exists yet.",
      trustedMode: "Trusted Workspace mode",
      trustedHint: "Inside selected Workspaces the Connector adds no second permission layer; Harness and OS permissions still apply.",
      restrictedHint: "Disables remote task claiming.",
      chatBridge: "Free Chat Bridge",
      chatBridgeHint: "Free fallback: injects a tiny [DSW] control message into the bound ChatGPT chat; ChatGPT still reads real results through MCP.",
      chatBridgeEnabled: "Enable Chat Bridge",
      chatBridgeChatUrl: "Bound ChatGPT chat URL",
      chatBridgeUrlHint: "Paste the chatgpt.com conversation URL used as the root orchestrator. Stored only in local Connector config.",
      chatBridgeOpen: "Open bridge browser / sign in",
      chatBridgeTest: "Test bridge browser",
      chatBridgeBound: "Bound",
      chatBridgeUnbound: "Not bound",
      chatBridgeReady: "Ready",
      chatBridgeNeedsLogin: "Sign-in required",
      advanced: "Advanced / Diagnostics",
      token: "Manual Worker Token",
      setToken: "Enter compatibility Token",
      tokenHint: "For legacy Cloud, development, diagnostics, or recovery only.",
      pairingCode: "Pairing code",
      workspaceRequired: "Select at least one Harness Workspace first.",
      activeTasks: "Active tasks",
      concurrency: "Outer concurrent tasks",
      concurrencyHint: "Allows the Connector to run multiple independent Native Sessions concurrently. Defaults to 24; Harness subagent limits still apply separately.",
      version: "Version",
      runningVersion: "Running version",
      installedVersion: "Installed version",
      installedRestartHint: "A newer build is installed on disk. Restart Harness to load it.",
      autoUpdate: "Automatic updates",
      updateChannel: "Update channel",
      updateStatus: "Update status",
      enabled: "On",
      disabled: "Off",
      stable: "stable",
      preview: "preview",
      updateIdle: "Waiting for automatic check",
      updateChecking: "Checking for updates",
      updateCurrent: "Up to date",
      updateAvailable: "Update available",
      updateWaitingIdle: "Waiting for current task to finish",
      updateInstalling: "Installing update",
      updateRestart: "Update installed. Restart Harness to apply it.",
      updateFailed: "Automatic update failed. The current version can keep running.",
      retryUpdate: "Retry",
      latestVersion: "Latest version",
      lastChecked: "Last checked",
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

    function cloudSetupUrl(endpoint, pairingCode) {
      try {
        const url = new URL(endpoint);
        if (url.protocol !== "https:" || url.username || url.password) return null;
        const path = url.pathname.replace(/\/+$/u, "");
        if (!path.endsWith("/api/worker")) return null;
        url.pathname = `${path.slice(0, -"/api/worker".length) || ""}/setup`;
        url.search = "";
        url.hash = "";
        if (pairingCode) url.searchParams.set("pair", pairingCode);
        return url.href;
      } catch {
        return null;
      }
    }

    function safeApprovalUrl(value) {
      if (typeof value !== "string" || !value) return null;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) return null;
        return url.href;
      } catch {
        return null;
      }
    }

    function connectionUrl(pairing, status, endpoint) {
      const approval = safeApprovalUrl(pairing?.approvalUrl || status?.approvalUrl);
      if (approval) return approval;
      const code = pairing?.pairingCode || status?.pairingCode || null;
      return cloudSetupUrl(endpoint, code);
    }

    function isTerminalPairingState(state) {
      return ["paired", "expired", "revoked", "error"].includes(state);
    }

    function createPairingPoller(check, onResult, onError, timers, intervalMs = 3000) {
      let stopped = false;
      let running = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        timers.clearInterval(timer);
      };
      const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
          const result = await check();
          if (stopped) return;
          onResult(result);
          if (isTerminalPairingState(result?.state)) stop();
        } catch (error) {
          if (!stopped) onError(error);
        } finally {
          running = false;
        }
      };
      const timer = timers.setInterval(() => { void tick(); }, intervalMs);
      return { tick, stop };
    }

    async function restorePairingConnection(actions) {
      const credential = await actions.describeCredential();
      if (!credential.configured) {
        return { credential, pairing: { ok: true, state: "unpaired" } };
      }
      const pairing = await actions.pairingStatus();
      return { credential, pairing };
    }

    function stateDot(value) {
      if (["loaded", "configured", "online", "native", "paired", "up-to-date", "restart-required"].includes(value)) return "done";
      if (["detecting", "connecting", "pending", "checking", "available", "waiting-idle", "installing"].includes(value)) return "ongoing";
      if (["paused", "headless", "untested", "unknown", "unpaired"].includes(value)) return "warning";
      if (["offline", "unauthenticated", "unconfigured", "error", "expired", "revoked", "failed"].includes(value)) return "error";
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
        maxConcurrentTasks: String(initial.maxConcurrentTasks ?? 24),
        heartbeatIntervalMs: String(initial.heartbeatIntervalMs ?? 20000),
        leaseRenewIntervalMs: String(initial.leaseRenewIntervalMs ?? 20000),
        leaseWaitTimeoutMs: String(initial.leaseWaitTimeoutMs ?? 1800000),
        trustedWorkspaceMode: initial.trustedWorkspaceMode !== false,
        enableHeadlessFallback: initial.enableHeadlessFallback !== false,
        autoUpdate: initial.autoUpdate !== false,
        updateChannel: initial.updateChannel === "preview" ? "preview" : "stable",
        chatBridgeEnabled: initial.chatBridgeEnabled !== false,
        chatBridgeChatUrl: initial.chatBridgeChatUrl || "",
        chatBridgeDebugPort: String(initial.chatBridgeDebugPort ?? 9223),
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
          maxConcurrentTasks: String(value.maxConcurrentTasks ?? 24),
          heartbeatIntervalMs: String(value.heartbeatIntervalMs ?? 20000),
          leaseRenewIntervalMs: String(value.leaseRenewIntervalMs ?? 20000),
          leaseWaitTimeoutMs: String(value.leaseWaitTimeoutMs ?? 1800000),
          trustedWorkspaceMode: value.trustedWorkspaceMode !== false,
          enableHeadlessFallback: value.enableHeadlessFallback !== false,
          autoUpdate: value.autoUpdate !== false,
          updateChannel: value.updateChannel === "preview" ? "preview" : "stable",
          chatBridgeEnabled: value.chatBridgeEnabled !== false,
          chatBridgeChatUrl: value.chatBridgeChatUrl || "",
          chatBridgeDebugPort: String(value.chatBridgeDebugPort ?? 9223),
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

      const refreshCredential = async () => {
        try {
          const next = await actions.describeCredential();
          setCredential(next);
          return next;
        } catch (error) {
          setCredential(undefined);
          setTokenMessage(error instanceof Error ? error.message : "Credential 读取失败");
          throw error;
        }
      };

      const restoreConnection = async () => {
        try {
          const restored = await restorePairingConnection(actions);
          setCredential(restored.credential);
          setPairing(restored.pairing);
          if (!restored.pairing.ok && restored.pairing.state !== "unpaired") {
            setPairingMessage(restored.pairing.message || "无法恢复连接状态");
          }
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "无法恢复连接状态");
        }
      };

      useEffect(() => {
        void refreshStatus();
        void restoreConnection();
        const timer = window.setInterval(() => { void refreshStatus(); }, 5000);
        return () => window.clearInterval(timer);
      }, []);

      const endpointValid = /^https:\/\//u.test(draft.endpoint.trim());
      const canWrite = Boolean(form?.state?.writable);

      const saveConfig = async () => {
        setSaveMessage("");
        if (!endpointValid) {
          setSaveMessage(t("invalidEndpoint"));
          return false;
        }
        const number = (value) => Number.parseInt(value, 10);
        const operations = [
          ["endpoint", draft.endpoint.trim()],
          ["workerId", draft.workerId.trim()],
          ["pollIntervalMs", number(draft.pollIntervalMs)],
          ["maxConcurrentTasks", number(draft.maxConcurrentTasks)],
          ["heartbeatIntervalMs", number(draft.heartbeatIntervalMs)],
          ["leaseRenewIntervalMs", number(draft.leaseRenewIntervalMs)],
          ["leaseWaitTimeoutMs", number(draft.leaseWaitTimeoutMs)],
          ["authorizedWorkspaceIds", [...authorizedWorkspaceIds]],
          ["trustedWorkspaceMode", draft.trustedWorkspaceMode],
          ["enableHeadlessFallback", draft.enableHeadlessFallback],
          ["autoUpdate", draft.autoUpdate],
          ["updateChannel", draft.updateChannel],
          ["chatBridgeEnabled", draft.chatBridgeEnabled],
          ["chatBridgeChatUrl", draft.chatBridgeChatUrl.trim()],
          ["chatBridgeDebugPort", number(draft.chatBridgeDebugPort)],
        ].map(([field, value]) => ({ op: "set", path: [field], value }));

        setSaving(true);
        try {
          const ok = await form.mutate(operations, form.state.revision);
          setSaveMessage(ok ? t("saved") : t("saveFailed"));
          if (ok) await refreshStatus();
          return ok;
        } catch {
          setSaveMessage(t("saveFailed"));
          return false;
        } finally {
          setSaving(false);
        }
      };

      const saveUpdateSettings = async (autoUpdate, updateChannel) => {
        const channel = updateChannel === "preview" ? "preview" : "stable";
        try {
          const ok = await form.mutate([
            { op: "set", path: ["autoUpdate"], value: autoUpdate },
            { op: "set", path: ["updateChannel"], value: channel },
          ], form.state.revision);
          if (!ok) {
            setStatusMessage(t("saveFailed"));
            return false;
          }
          setDraft((value) => ({ ...value, autoUpdate, updateChannel: channel }));
          setStatusMessage("");
          if (autoUpdate) {
            await actions.checkForUpdates();
            await refreshStatus();
          }
          return true;
        } catch {
          setStatusMessage(t("saveFailed"));
          return false;
        }
      };

      const retryUpdate = async () => {
        try {
          await actions.checkForUpdates();
          await refreshStatus();
        } catch (error) {
          setStatusMessage(error instanceof Error ? error.message : t("updateFailed"));
        }
      };

      const openConnectionPage = () => {
        const target = connectionUrl(pairing, status, draft.endpoint.trim());
        if (!target) {
          setPairingMessage("Cloud 未提供可用的 HTTPS 连接页面。");
          return false;
        }
        window.open(target, "_blank", "noopener,noreferrer");
        return true;
      };

      const connectPairing = async () => {
        setPairingBusy(true);
        setPairingMessage("");
        try {
          if (authorizedWorkspaceIds.length === 0) {
            setPairingMessage(t("workspaceRequired"));
            return;
          }
          const saved = await saveConfig();
          if (!saved) return;
          const result = await actions.beginPairing();
          setPairing(result);
          if (!result.ok) {
            setPairingMessage(result.message || "连接失败");
            return;
          }
          if (result.state === "paired") {
            await refreshStatus();
            return;
          }
          const target = connectionUrl(result, status, draft.endpoint.trim());
          if (!target) {
            setPairingMessage("Cloud 未提供可用的 HTTPS 连接页面。");
            return;
          }
          window.open(target, "_blank", "noopener,noreferrer");
        } catch (error) {
          setPairing({ ok: false, state: "error" });
          setPairingMessage(error instanceof Error ? error.message : "连接失败");
        } finally {
          setPairingBusy(false);
        }
      };

      const checkPairing = async () => {
        setPairingMessage("");
        try {
          const result = await actions.pairingStatus();
          setPairing(result);
          if (!result.ok) setPairingMessage(result.message || "无法检查连接状态");
          if (result.state === "paired") await refreshStatus();
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "无法检查连接状态");
        }
      };

      const disconnectPairing = async () => {
        setPairingBusy(true);
        setPairingMessage("");
        try {
          const result = await actions.disconnectPairing();
          setPairing(result);
          if (!result.ok) setPairingMessage(result.message || "断开连接失败");
          await refreshCredential().catch(() => undefined);
          await refreshStatus();
        } catch (error) {
          setPairingMessage(error instanceof Error ? error.message : "断开连接失败");
        } finally {
          setPairingBusy(false);
        }
      };

      useEffect(() => {
        if (pairing?.state !== "pending") return undefined;
        const poller = createPairingPoller(
          () => actions.pairingStatus(),
          (result) => {
            setPairing(result);
            if (!result.ok) setPairingMessage(result.message || "无法检查连接状态");
            if (result.state === "paired") void refreshStatus();
          },
          (error) => setPairingMessage(error instanceof Error ? error.message : "无法检查连接状态"),
          window,
          3000,
        );
        return () => poller.stop();
      }, [pairing?.state]);

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

      const updateState = status?.updateState || "idle";
      const updateDisplay = updateState === "checking" ? t("updateChecking")
        : updateState === "up-to-date" ? t("updateCurrent")
          : updateState === "available" ? t("updateAvailable")
            : updateState === "waiting-idle" ? t("updateWaitingIdle")
              : updateState === "installing" ? t("updateInstalling")
                : updateState === "restart-required" ? t("updateRestart")
                  : updateState === "failed" ? t("updateFailed") : t("updateIdle");

      const rawPairingState = pairing?.state || status?.pairing || "unpaired";
      const connectionState = pairingBusy
        ? "connecting"
        : rawPairingState === "paired" ? "paired"
          : rawPairingState === "pending" ? "pending"
            : rawPairingState === "unpaired" ? "unpaired" : "failed";
      const connectionLabel = connectionState === "paired"
        ? t("connectionPaired")
        : connectionState === "pending" ? t("connectionPending")
          : connectionState === "connecting" ? t("connectionConnecting")
            : connectionState === "failed" ? t("connectionFailed") : t("connectionUnpaired");

      return h("div", { style: { display: "grid", gap: 16, maxWidth: 920 } },
        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("deviceConnection")),
          h("p", { style: mutedStyle }, t("connectionHint")),
          h("div", { style: { ...rowStyle, fontSize: 16 } },
            h(StateDot, { state: stateDot(connectionState) }),
            h("strong", null, connectionLabel),
          ),
          h("div", { style: rowStyle },
            connectionState === "paired"
              ? h(React.Fragment, null,
                  h(Button, { variant: "primary", onClick: openConnectionPage }, t("openChatGPT")),
                  h(Button, { variant: "outline", disabled: pairingBusy, onClick: () => void disconnectPairing() }, t("disconnect")),
                )
              : connectionState === "pending"
                ? h(React.Fragment, null,
                    h(Button, { variant: "primary", onClick: openConnectionPage }, t("openConnection")),
                    h(Button, { variant: "outline", disabled: pairingBusy, onClick: () => void checkPairing() }, t("checkStatus")),
                  )
                : h(Button, {
                    variant: "primary",
                    disabled: pairingBusy || !canWrite || !endpointValid,
                    onClick: () => void connectPairing(),
                  }, pairingBusy ? t("connecting") : credential?.configured ? t("reconnect") : t("installConnect")),
          ),
          pairingMessage ? h("p", { role: "status", style: mutedStyle }, pairingMessage) : null,
          h("div", { style: gridStyle },
            h(StatusLine, {
              label: t("cloudStatus"),
              value: status?.cloud || "untested",
              display: t(status?.cloud || "untested"),
            }),
            h(StatusLine, {
              label: t("harness"),
              value: executionValue,
              display: executionDisplay,
            }),
            h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
              h("span", null, t("workspacesAuthorized")),
              h("strong", null, String(authorizedWorkspaceIds.length)),
            ),
            h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
              h("span", null, t("heartbeat")),
              h("span", null, status?.lastHeartbeat || t("noHeartbeat")),
            ),
          ),
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
          h("div", { style: rowStyle },
            h(Switch, {
              checked: draft.trustedWorkspaceMode,
              label: t("trustedMode"),
              onChange: (next) => setDraft((value) => ({ ...value, trustedWorkspaceMode: next })),
            }),
            h("strong", null, t("trustedMode")),
          ),
          h("p", { style: mutedStyle }, draft.trustedWorkspaceMode ? t("trustedHint") : t("restrictedHint")),
          workspaceMessage ? h("p", { role: "status", style: mutedStyle }, workspaceMessage) : null,
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("chatBridge")),
          h("p", { style: mutedStyle }, t("chatBridgeHint")),
          h("div", { style: rowStyle },
            h(Switch, {
              checked: draft.chatBridgeEnabled,
              label: t("chatBridgeEnabled"),
              onChange: (next) => setDraft((value) => ({ ...value, chatBridgeEnabled: next })),
            }),
            h("strong", null, draft.chatBridgeEnabled ? t("enabled") : t("disabled")),
          ),
          h(Field, { label: t("chatBridgeChatUrl") }, h(Input, {
            value: draft.chatBridgeChatUrl,
            onChange: (event) => setDraft((value) => ({ ...value, chatBridgeChatUrl: event.target.value })),
            placeholder: "https://chatgpt.com/c/…",
            spellCheck: false,
          })),
          h("p", { style: mutedStyle }, t("chatBridgeUrlHint")),
          h("div", { style: rowStyle },
            h(Button, {
              variant: "primary",
              onClick: async () => {
                const saved = await saveConfig();
                if (!saved) return;
                const result = await actions.openBridgeBrowser();
                setStatusMessage(result?.ok ? "" : (result?.message || "Chat Bridge unavailable"));
                await refreshStatus();
              },
            }, t("chatBridgeOpen")),
            h(Button, {
              variant: "outline",
              onClick: async () => {
                const saved = await saveConfig();
                if (!saved) return;
                const result = await actions.testBridge();
                setStatusMessage(result?.ok ? "" : (result?.message || "Chat Bridge unavailable"));
                await refreshStatus();
              },
            }, t("chatBridgeTest")),
          ),
          h("div", { style: gridStyle },
            h(StatusLine, {
              label: t("chatBridge"),
              value: status?.chatBridge?.state || "unknown",
              display: status?.chatBridge?.bound
                ? (status?.chatBridge?.state === "needs-login" ? t("chatBridgeNeedsLogin") : t("chatBridgeReady"))
                : t("chatBridgeUnbound"),
            }),
            status?.chatBridge?.lastSentAt
              ? h("p", { style: mutedStyle }, `Last sent: ${status.chatBridge.lastSentAt}`)
              : null,
            status?.chatBridge?.lastError
              ? h("p", { role: "status", style: mutedStyle }, status.chatBridge.lastError)
              : null,
          ),
        ),

        h("section", { style: sectionStyle },
          h("h3", { style: { margin: 0 } }, t("version")),
          h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
            h("span", null, t("runningVersion")),
            h("strong", null, status?.currentVersion || "0.7.0"),
          ),
          status?.installedVersion && status.installedVersion !== status.currentVersion
            ? h(React.Fragment, null,
                h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
                  h("span", null, t("installedVersion")),
                  h("strong", null, status.installedVersion),
                ),
                h("p", { style: mutedStyle }, t("installedRestartHint")),
              )
            : null,
          h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
            h("span", null, t("autoUpdate")),
            h("span", { style: rowStyle },
              h(Switch, {
                checked: draft.autoUpdate,
                label: t("autoUpdate"),
                onChange: (next) => { void saveUpdateSettings(next, draft.updateChannel); },
              }),
              h("span", null, draft.autoUpdate ? t("enabled") : t("disabled")),
            ),
          ),
          h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
            h("label", { htmlFor: "deepseek-worker-update-channel" }, t("updateChannel")),
            h("select", {
              id: "deepseek-worker-update-channel",
              value: draft.updateChannel,
              onChange: (event) => { void saveUpdateSettings(draft.autoUpdate, event.target.value); },
              style: { minWidth: 120, padding: "6px 8px", borderRadius: 8 },
            },
              h("option", { value: "stable" }, t("stable")),
              h("option", { value: "preview" }, t("preview")),
            ),
          ),
          h(StatusLine, { label: t("updateStatus"), value: updateState, display: updateDisplay }),
          status?.restartRequired
            ? h("p", { style: mutedStyle }, `↑ ${status.latestVersion || status.currentVersion || "0.7.0"} · ${t("updateRestart")}`)
            : null,
          updateState === "failed"
            ? h("div", { style: gridStyle },
                h("p", { style: mutedStyle }, t("updateFailed")),
                h(Button, { variant: "outline", onClick: () => void retryUpdate() }, t("retryUpdate")),
              )
            : null,
        ),

        h("details", { style: sectionStyle },
          h("summary", { style: { cursor: "pointer", fontWeight: 600 } }, t("advanced")),
          h("div", { style: { ...gridStyle, marginTop: 12 } },
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
              generatedToken ? h("div", { style: gridStyle },
                h("strong", null, t("generatedToken")),
                h("code", { style: { overflowWrap: "anywhere", userSelect: "all" } }, generatedToken),
                h(Button, {
                  variant: "outline",
                  disabled: !credential?.writable,
                  onClick: () => void storeToken(generatedToken),
                }, t("saveToken")),
              ) : null,
              h("p", { style: mutedStyle }, t("tokenHint")),
              tokenMessage ? h("p", { role: "status", style: mutedStyle }, tokenMessage) : null,
            ),

            (pairing?.pairingCode || status?.pairingCode)
              ? h("div", { style: gridStyle },
                  h("strong", null, t("pairingCode")),
                  h("code", null, pairing?.pairingCode || status?.pairingCode),
                ) : null,

            h(StatusLine, { label: t("connector"), value: status?.connector || "loaded", display: status?.connector || "loaded" }),
            h(StatusLine, {
              label: t("credential"),
              value: credential?.configured ? "configured" : "unconfigured",
              display: credential?.configured ? t("configured") : t("unconfigured"),
            }),
            h(StatusLine, { label: t("worker"), value: status?.worker || "paused", display: status?.worker || "paused" }),
            h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
              h("span", null, t("activeTasks")),
              h("strong", null, `${status?.activeTaskCount ?? 0} / ${status?.maxConcurrentTasks ?? 24}`),
            ),
            h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
              h("span", null, t("latestVersion")),
              h("span", null, status?.latestVersion || status?.currentVersion || "0.7.0"),
            ),
            h("div", { style: { ...rowStyle, justifyContent: "space-between" } },
              h("span", null, t("lastChecked")),
              h("span", null, status?.lastCheckedAt || "--"),
            ),
            status?.lastUpdateError ? h("p", { style: mutedStyle }, status.lastUpdateError) : null,

            h("div", { style: gridStyle },
              h(Field, { label: t("concurrency") }, h(Input, {
                type: "number", min: 1, max: 24, value: draft.maxConcurrentTasks,
                onChange: (event) => setDraft((value) => ({ ...value, maxConcurrentTasks: event.target.value })),
              })),
              h("p", { style: mutedStyle }, t("concurrencyHint")),
            ),
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
          ),
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
        async checkForUpdates() {
          const response = await ctx.remote.deepseekWorkerConnector.checkForUpdates();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "checkForUpdates"));
          return response.value;
        },
        async openBridgeBrowser() {
          const response = await ctx.remote.deepseekWorkerConnector.openBridgeBrowser();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "openBridgeBrowser"));
          return response.value;
        },
        async testBridge() {
          const response = await ctx.remote.deepseekWorkerConnector.testBridge();
          if (!response.ok) throw new Error(hostRemoteFailure(response.error, "testBridge"));
          return response.value;
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
      }, (slotProps) => slotProps.view === "summary" ? slotProps.t("summary") : h(ConfigPage, slotProps)));
    }

    return {
      inject: ["remote"],
      __test: {
        cloudSetupUrl,
        connectionUrl,
        createPairingPoller,
        restorePairingConnection,
      },
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
