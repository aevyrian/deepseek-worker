import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import Schema from "@deepseek-ai/schemastery";
import { getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_WORKER_ID,
  TOKEN_REF,
  classifyConnectionError,
  executionMode,
  generateWorkerToken,
  missingAuthorizedWorkspaceIds,
  publicRuntimeStatus,
  redactSecret,
  snapshotConnectorInput,
} from "./lib/connector-config.mjs";
import {
  buildTaskPrompt,
  extractAssistantText,
  normalizeConfig,
  workerRequest,
  workspaceForTask,
} from "./lib/protocol.mjs";
import { authorizedWorkspaceState, workspaceHeartbeatPayload } from "./lib/workspaces.mjs";
import { executeNativeSession } from "./lib/native-session.mjs";
import { AsyncTaskPool, fillTaskPool } from "./lib/task-pool.mjs";
import { registerOrchestratorPreset } from "./lib/orchestrator-preset.mjs";
import { migrateLegacyOrchestratorBundles } from "./lib/migration.mjs";
import { migrateLegacyProfileArtifacts } from "./lib/profile-cleanup.mjs";
import {
  classifyPairingError,
  credentialInfo,
  credentialValue,
  hashWorkerToken,
  normalizeApprovalUrl,
  normalizePairingState,
  pairingRequest,
} from "./lib/pairing.mjs";
import { ChatBridgeController, bridgeReady } from "./lib/chat-bridge.mjs";
import { BridgeWakeOutbox } from "./lib/bridge-outbox.mjs";
import { WakeCoordinator } from "./lib/wake-coordinator.mjs";
import { WakeTransport } from "./lib/wake-transport.mjs";
import {
  AutoUpdateController,
  CONNECTOR_VERSION,
  createUpdateRuntime,
  isNewerVersion,
  publicUpdateStatus,
} from "./lib/update.mjs";

export const name = "deepseek-worker-connector";

export const Config = Schema.object({
  endpoint: Schema.string().pattern(/^https:\/\//u).default(DEFAULT_ENDPOINT).volatile(),
  workerId: Schema.string().pattern(/\S/u).default(DEFAULT_WORKER_ID).volatile(),
  pollIntervalMs: Schema.number().step(1).min(1000).max(60000).default(4000).volatile(),
  maxConcurrentTasks: Schema.number().step(1).min(1).max(24).default(24).volatile(),
  heartbeatIntervalMs: Schema.number().step(1).min(5000).max(300000).default(20000).volatile(),
  leaseRenewIntervalMs: Schema.number().step(1).min(5000).max(55000).default(20000).volatile(),
  leaseWaitTimeoutMs: Schema.number().step(1).min(10000).max(86400000).default(1800000).volatile(),
  authorizedWorkspaceIds: Schema.array(Schema.string().pattern(/\S/u)).default([]).volatile(),
  trustedWorkspaceMode: Schema.boolean().default(true).volatile(),
  enableHeadlessFallback: Schema.boolean().default(true).volatile(),
  autoUpdate: Schema.boolean().default(true).volatile(),
  updateChannel: Schema.union([Schema.const("stable"), Schema.const("preview")]).default("stable").volatile(),
  chatBridgeEnabled: Schema.boolean().default(true).volatile(),
  chatBridgeChatUrl: Schema.string().default("").volatile(),
  chatBridgeDebugPort: Schema.number().step(1).min(1024).max(65535).default(9223).volatile(),
  headlessCommand: Schema.string().pattern(/\S/u).default("dsh").volatile(),
  headlessArgs: Schema.array(Schema.string()).default(["--profile", "headless", "--json"]).volatile(),
});

function currentConfig(input) {
  return normalizeConfig(snapshotConnectorInput(input));
}

function optionalService(ctx, key) {
  try {
    return typeof ctx.get === "function" ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

function currentSessionController(ctx) {
  return optionalService(ctx, "sessionController");
}

function currentCredentials(ctx) {
  return optionalService(ctx, "credentials");
}

function currentPluginManager(ctx) {
  return optionalService(ctx, "pluginManager");
}

async function syncInstalledConnectorVersion(runtime, pluginManager) {
  if (!pluginManager || typeof pluginManager.listBundles !== "function") return;
  try {
    const bundles = await pluginManager.listBundles();
    const installed = Array.isArray(bundles)
      ? bundles.find((bundle) => bundle?.name === "deepseek-worker-connector")
      : undefined;
    const installedVersion = typeof installed?.version === "string" && installed.version.trim()
      ? installed.version.trim()
      : null;
    if (!installedVersion) return;

    runtime.installedVersion = installedVersion;
    const runningVersion = runtime.currentVersion || CONNECTOR_VERSION;
    if (isNewerVersion(installedVersion, runningVersion)) {
      runtime.latestVersion = installedVersion;
      runtime.updateState = "restart-required";
      runtime.restartRequired = true;
      runtime.lastUpdateError = null;
    }
  } catch {
    // Status must remain available even if Plugin Manager inventory is temporarily unavailable.
  }
}

async function describeWorkerCredential(credentials) {
  return credentialInfo(await credentials.describe(TOKEN_REF));
}

async function resolveWorkerToken(credentials) {
  return credentialValue(await credentials.resolve(TOKEN_REF));
}

async function saveWorkerToken(credentials, token) {
  await credentials.set(TOKEN_REF, token);
}

async function clearWorkerToken(credentials) {
  if (typeof credentials.unset === "function") await credentials.unset(TOKEN_REF);
}

function initialRuntime() {
  return {
    connector: "loaded",
    execution: "unknown",
    credential: "unknown",
    cloud: "untested",
    worker: "paused",
    lastHeartbeat: null,
    workerId: DEFAULT_WORKER_ID,
    workspaceCount: 0,
    pairing: "unpaired",
    pairingCode: null,
    approvalUrl: null,
    pairingExpiresAt: null,
    ...createUpdateRuntime(CONNECTOR_VERSION),
    workerBusy: false,
    activeTaskCount: 0,
    maxConcurrentTasks: 24,
    bridgeBrowser: "unknown",
    bridgeState: "unbound",
    bridgeLastEventId: null,
    bridgeLastMessageKey: null,
    bridgeLastSentAt: null,
    bridgeLastError: null,
    lastError: null,
  };
}

function workspaceState(config, registry) {
  return authorizedWorkspaceState(config.authorizedWorkspaceIds, registry.list());
}

export class WorkerControlService extends TypertRemoteService {
  static inject = ["workspaceRegistry"];
  static Config = Config;

  constructor(ctx, input = {}) {
    super(ctx, "deepseekWorkerConnectorControl", { namespace: "deepseekWorkerConnector" });
    this.input = input;
    this.runtime = initialRuntime();
    this.bridge = new ChatBridgeController({
      runtime: this.runtime,
      getConfig: () => currentConfig(this.input),
      logger: ctx.logger,
    });
    this.bridgeOutbox = new BridgeWakeOutbox();
    this.wakeTransport = new WakeTransport({
      outbox: this.bridgeOutbox,
      bridge: this.bridge,
      enabled: () => currentConfig(this.input).chatBridgeEnabled,
      logger: ctx.logger,
    });
    this.wakeCoordinator = new WakeCoordinator({
      outbox: this.bridgeOutbox,
      transport: this.wakeTransport,
      enabled: () => currentConfig(this.input).chatBridgeEnabled,
      logger: ctx.logger,
    });
    this.updater = new AutoUpdateController({
      runtime: this.runtime,
      getConfig: () => currentConfig(this.input),
      getPluginManager: () => currentPluginManager(this.ctx),
      getHarnessVersion: () => {
        try { return getDshRuntimeVersion(); } catch { return ""; }
      },
      isWorkerBusy: () => this.runtime.workerBusy === true,
      logger: ctx.logger,
    });

    ctx.effect(() => {
      let unregister = null;
      const ready = (async () => {
        const pluginManager = currentPluginManager(ctx);
        if (pluginManager !== undefined) {
          const migration = await migrateLegacyOrchestratorBundles(pluginManager, ctx.logger);
          if (migration.status === "restart-required") {
            ctx.logger.info("deepseek-worker: legacy total-control preset bundle disabled; restart Harness once to finish cleanup");
          } else if (migration.status === "failed") {
            ctx.logger.warn("deepseek-worker: legacy total-control preset cleanup was incomplete; Connector will continue with runtime preset registration");
          } else if (migration.removed.length > 0) {
            ctx.logger.info("deepseek-worker: removed legacy total-control preset bundle");
          }
          try {
            const cleanup = await migrateLegacyProfileArtifacts(pluginManager, ctx.logger);
            if (cleanup.patchChanged || cleanup.linkRemoved || cleanup.sourceRetired) {
              ctx.logger.info("deepseek-worker: legacy profile artifacts cleaned; restart Harness to reload profile patches");
            }
          } catch (error) {
            ctx.logger.warn("deepseek-worker: legacy profile artifact cleanup was skipped: %s", redactSecret(error));
          }
        }

        const registry = optionalService(ctx, "agentPresets");
        if (registry === undefined) {
          ctx.logger.warn("deepseek-worker: agent preset registry unavailable; total-control preset not registered");
          return;
        }
        unregister = await registerOrchestratorPreset(registry);
      })().catch((error) => {
        ctx.logger.warn("deepseek-worker: failed to prepare total-control preset: %s", redactSecret(error));
      });

      return async () => {
        await ready;
        if (typeof unregister === "function") await unregister();
      };
    }, "deepseek-worker-connector: orchestrator preset");

    ctx.effect(() => {
      const lifecycle = new AbortController();
      const transport = this.wakeTransport.run(lifecycle.signal).catch((error) => {
        if (!lifecycle.signal.aborted) ctx.logger.warn("deepseek-worker wake transport stopped: %s", redactSecret(error));
      });
      return async () => {
        lifecycle.abort(new Error("DeepSeek Worker Connector stopped"));
        await transport;
      };
    }, "deepseek-worker-connector: wake transport");

    ctx.effect(() => {
      const lifecycle = new AbortController();
      const worker = runWorker(ctx, input, this.runtime, lifecycle.signal, this.wakeCoordinator).catch((error) => {
        if (!lifecycle.signal.aborted) {
          ctx.logger.error("deepseek-worker connector stopped: %s", redactSecret(error));
        }
      });
      return async () => {
        lifecycle.abort(new Error("DeepSeek Worker Connector stopped"));
        await worker;
      };
    }, "deepseek-worker-connector: worker loop");

    ctx.effect(() => {
      const lifecycle = new AbortController();
      const updater = this.updater.runScheduler(lifecycle.signal).catch((error) => {
        if (!lifecycle.signal.aborted) {
          this.runtime.updateState = "failed";
          this.runtime.lastUpdateError = "自动更新失败。当前版本仍可继续使用。";
          ctx.logger.warn("deepseek-worker update scheduler stopped: %s", redactSecret(error));
        }
      });
      return async () => {
        lifecycle.abort(new Error("DeepSeek Worker Connector stopped"));
        await updater;
      };
    }, "deepseek-worker-connector: update scheduler");
  }

  async status() {
    const credentials = currentCredentials(this.ctx);
    let credentialConfigured = false;
    if (credentials !== undefined) {
      try {
        credentialConfigured = Boolean(await resolveWorkerToken(credentials));
      } catch {}
    }

    try {
      const config = currentConfig(this.input);
      const workspaces = workspaceState(config, this.ctx.workspaceRegistry);
      const controller = currentSessionController(this.ctx);
      await syncInstalledConnectorVersion(this.runtime, currentPluginManager(this.ctx));
      this.runtime.workerId = config.workerId;
      this.runtime.workspaceCount = workspaces.count;
      this.runtime.execution = executionMode(controller !== undefined);
      if (credentials === undefined) {
        this.runtime.credential = "unconfigured";
        if (this.runtime.worker !== "error") this.runtime.worker = "paused";
        this.runtime.lastError = "Harness Credential provider 不可用。";
      }
      return publicRuntimeStatus(this.runtime, {
        credentialConfigured,
        workerId: config.workerId,
        workspaceCount: workspaces.count,
        missingWorkspaceIds: workspaces.missing,
        trustedWorkspaceMode: config.trustedWorkspaceMode,
        chatBridge: this.bridge.status(),
      });
    } catch (error) {
      return publicRuntimeStatus(
        { ...this.runtime, execution: "unknown", worker: "error", lastError: redactSecret(error) },
        { credentialConfigured },
      );
    }
  }

  async beginPairing() {
    if (this.beginPairingInFlight) return this.beginPairingInFlight;
    this.beginPairingInFlight = this.startPairingOnce();
    try { return await this.beginPairingInFlight; }
    finally { this.beginPairingInFlight = null; }
  }

  async startPairingOnce() {
    let config;
    try {
      config = currentConfig(this.input);
    } catch (error) {
      return { ok: false, code: "config_invalid", state: "error", message: redactSecret(error) };
    }

    if (config.authorizedWorkspaceIds.length === 0) {
      return {
        ok: false,
        code: "workspace_missing",
        state: "error",
        message: "请先选择至少一个 Harness Workspace。",
      };
    }

    let workspaces;
    try {
      workspaces = workspaceState(config, this.ctx.workspaceRegistry);
    } catch (error) {
      return {
        ok: false,
        code: "workspace_registry_unavailable",
        state: "error",
        message: `读取 Harness Workspace 状态失败：${redactSecret(error)}`,
      };
    }
    if (workspaces.missing.length > 0) {
      return {
        ok: false,
        code: "workspace_not_found",
        state: "error",
        message: `以下授权 Workspace 已不存在：${workspaces.missing.join(", ")}。请重新选择。`,
      };
    }

    const credentials = currentCredentials(this.ctx);
    if (credentials === undefined) {
      return {
        ok: false,
        code: "credential_unavailable",
        state: "error",
        message: "Harness Credential provider 不可用。",
      };
    }

    let info;
    try {
      info = await describeWorkerCredential(credentials);
    } catch (error) {
      return {
        ok: false,
        code: "credential_describe_failed",
        state: "error",
        message: `读取 Harness Credential 状态失败：${redactSecret(error)}`,
      };
    }

    if (!info.writable) {
      return {
        ok: false,
        code: "credential_readonly",
        state: "error",
        message: "Harness Credential provider 当前不可写。",
      };
    }

    let existingToken;
    try {
      existingToken = await resolveWorkerToken(credentials);
    } catch (error) {
      return { ok: false, code: "credential_resolve_failed", state: "error", message: `读取 Harness Worker 凭据失败：${redactSecret(error)}` };
    }
    if (existingToken) {
      const current = await this.pairingStatus();
      if (current.ok && (current.state === "paired" || current.state === "pending")) return current;
      if (!["unpaired", "expired", "revoked"].includes(current.state)) return current;
    }

    const token = generateWorkerToken();

    try {
      const started = await pairingRequest(config, undefined, "start", {
        token_hash: hashWorkerToken(token),
        hostname: hostname(),
        ...workspaceHeartbeatPayload(workspaces),
        client_version: CONNECTOR_VERSION,
      }, AbortSignal.timeout(10000));

      const state = normalizePairingState(started.state || "pending");
      const pairingCode = started.code || started.pairing_code || null;
      const approvalUrl = normalizeApprovalUrl(started.approval_url || started.approvalUrl || null);
      const expiresAt = started.expires_at || started.expiresAt || null;

      if (!approvalUrl && state === "pending") {
        this.runtime.pairing = "error";
        this.runtime.lastError = "Cloud 未返回 approvalUrl。";
        return {
          ok: false,
          code: "pairing_response_invalid",
          state: "error",
          message: "Cloud 配对响应缺少连接页面地址。",
        };
      }

      try {
        await saveWorkerToken(credentials, token);
      } catch (error) {
        return { ok: false, code: "credential_write_failed", state: "error", message: `保存本机 Worker 凭据失败：${redactSecret(error, token)}` };
      }

      this.runtime.pairing = state;
      this.runtime.credential = "configured";
      this.runtime.worker = "paused";
      this.runtime.pairingCode = pairingCode;
      this.runtime.approvalUrl = approvalUrl;
      this.runtime.pairingExpiresAt = expiresAt;
      this.runtime.cloud = "online";
      this.runtime.lastError = null;

      return {
        ok: true,
        code: "pairing_started",
        state,
        pairingCode,
        approvalUrl,
        expiresAt,
      };
    } catch (error) {
      const mapped = classifyPairingError(error);
      this.runtime.pairing = mapped.state;
      this.runtime.lastError = mapped.message;
      return { ok: false, ...mapped };
    }
  }

  async pairingStatus() {
    let config;
    try {
      config = currentConfig(this.input);
    } catch (error) {
      return { ok: false, code: "config_invalid", state: "error", message: redactSecret(error) };
    }

    const credentials = currentCredentials(this.ctx);
    if (credentials === undefined) {
      return {
        ok: false,
        code: "credential_unavailable",
        state: "error",
        message: "Harness Credential provider 不可用。",
      };
    }

    let token;
    try {
      token = await resolveWorkerToken(credentials);
    } catch (error) {
      return {
        ok: false,
        code: "credential_resolve_failed",
        state: "error",
        message: `读取 Harness Worker 凭据失败：${redactSecret(error)}`,
      };
    }

    if (!token) {
      this.runtime.pairing = "unpaired";
      this.runtime.credential = "unconfigured";
      return { ok: false, code: "token_missing", state: "unpaired", message: "本机尚无 Worker 凭据。" };
    }

    try {
      const result = await pairingRequest(config, token, "status", {}, AbortSignal.timeout(10000));
      const state = normalizePairingState(result.state);
      const pairingCode = result.code || result.pairing_code || this.runtime.pairingCode || null;
      const rawApprovalUrl = result.approval_url || result.approvalUrl || this.runtime.approvalUrl || null;
      const approvalUrl = rawApprovalUrl ? normalizeApprovalUrl(rawApprovalUrl) : null;
      const expiresAt = result.expires_at || result.expiresAt || this.runtime.pairingExpiresAt || null;

      this.runtime.pairing = state;
      this.runtime.credential = "configured";
      this.runtime.cloud = "online";
      this.runtime.pairingCode = pairingCode;
      this.runtime.approvalUrl = approvalUrl;
      this.runtime.pairingExpiresAt = expiresAt;
      this.runtime.lastError = null;

      if (state === "paired") {
        this.runtime.worker = config.trustedWorkspaceMode ? "online" : "paused";
      } else {
        this.runtime.worker = "paused";
      }

      return {
        ok: true,
        state,
        pairingCode,
        approvalUrl,
        expiresAt,
      };
    } catch (error) {
      const mapped = classifyPairingError(error);
      this.runtime.pairing = mapped.state;
      this.runtime.worker = "paused";
      this.runtime.lastError = mapped.message;
      if (mapped.state === "unpaired") this.runtime.credential = "configured";
      return { ok: false, ...mapped };
    }
  }

  async disconnectPairing() {
    let config;
    try {
      config = currentConfig(this.input);
    } catch (error) {
      return { ok: false, code: "config_invalid", state: "error", message: redactSecret(error) };
    }

    const credentials = currentCredentials(this.ctx);
    if (credentials === undefined) {
      return {
        ok: false,
        code: "credential_unavailable",
        state: "error",
        message: "Harness Credential provider 不可用。",
      };
    }

    let token;
    try {
      token = await resolveWorkerToken(credentials);
    } catch (error) {
      return {
        ok: false,
        code: "credential_resolve_failed",
        state: "error",
        message: `读取 Harness Worker 凭据失败：${redactSecret(error)}`,
      };
    }

    if (!token) {
      this.runtime.pairing = "unpaired";
      this.runtime.credential = "unconfigured";
      return { ok: true, code: "already_disconnected", state: "unpaired" };
    }

    try {
      await pairingRequest(config, token, "disconnect", {}, AbortSignal.timeout(10000));
    } catch (error) {
      const mapped = classifyPairingError(error);
      this.runtime.pairing = mapped.state;
      this.runtime.lastError = mapped.message;
      return { ok: false, ...mapped };
    }

    try {
      await clearWorkerToken(credentials);
    } catch (error) {
      this.runtime.pairing = "revoked";
      this.runtime.worker = "paused";
      this.runtime.lastError = "Cloud 已断开，但本地 Credential 清理失败。";
      return {
        ok: false,
        code: "credential_cleanup_failed",
        state: "revoked",
        message: `Cloud 已断开，但本地 Credential 清理失败：${redactSecret(error, token)}`,
      };
    }

    this.runtime.pairing = "unpaired";
    this.runtime.credential = "unconfigured";
    this.runtime.worker = "paused";
    this.runtime.pairingCode = null;
    this.runtime.approvalUrl = null;
    this.runtime.pairingExpiresAt = null;
    this.runtime.lastError = null;
    return { ok: true, code: "disconnected", state: "unpaired" };
  }

  generateToken() {
    return { token: generateWorkerToken(), ref: TOKEN_REF };
  }

  checkForUpdates() {
    void this.updater.requestCheck({ force: true });
    return publicUpdateStatus(this.runtime);
  }

  async openBridgeBrowser() {
    try {
      return { ok: true, ...(await this.bridge.openLoginBrowser()) };
    } catch (error) {
      return { ok: false, code: "bridge_browser_failed", message: redactSecret(error), ...this.bridge.status() };
    }
  }

  async testBridge() {
    const config = currentConfig(this.input);
    const state = this.bridge.status();
    if (!config.chatBridgeEnabled) return { ok: false, code: "bridge_disabled", ...state };
    if (!config.chatBridgeChatUrl) return { ok: false, code: "bridge_unbound", ...state };
    try {
      return await this.bridge.testBridge();
    } catch (error) {
      const bridgeErrorCodes = new Set([
        "bridge_login_required",
        "bridge_conversation_unreachable",
        "bridge_navigation_unstable",
        "bridge_page_eval_failed",
        "bridge_page_script_exception",
        "bridge_composer_unavailable",
      ]);
      const code = bridgeErrorCodes.has(error?.code) ? error.code : "bridge_browser_failed";
      return {
        ok: false,
        code,
        message: redactSecret(error),
        state: code === "bridge_login_required" ? "needs-login" : this.bridge.status().state,
        ...this.bridge.status(),
      };
    }
  }

  async test() {
    let config;
    try {
      config = currentConfig(this.input);
    } catch (error) {
      return { ok: false, code: "config_invalid", message: redactSecret(error) };
    }
    if (config.authorizedWorkspaceIds.length === 0) {
      return { ok: false, code: "workspace_missing", message: "尚未授权任何 Harness Workspace。" };
    }
    const workspaces = workspaceState(config, this.ctx.workspaceRegistry);
    if (workspaces.missing.length > 0) {
      return {
        ok: false,
        code: "workspace_not_found",
        message: `以下授权 Workspace 已不存在：${workspaces.missing.join(", ")}。请在配置页重新选择。`,
      };
    }

    const credentials = currentCredentials(this.ctx);
    if (credentials === undefined) {
      return {
        ok: false,
        code: "credential_unavailable",
        message: "Harness Credential provider 不可用，无法读取 LOCAL_WORKER_TOKEN。",
      };
    }

    let token;
    try {
      token = await resolveWorkerToken(credentials);
    } catch (error) {
      return { ok: false, code: "credential_error", message: `读取 Harness Credentials 失败：${redactSecret(error)}` };
    }
    if (!token) return { ok: false, code: "token_missing", message: "Worker Token 未配置。" };

    try {
      await workerRequest(config, token, "register", {
        hostname: hostname(),
        ...workspaceHeartbeatPayload(workspaces),
        client_version: CONNECTOR_VERSION,
      }, AbortSignal.timeout(10000));
      this.runtime.credential = "configured";
      this.runtime.cloud = "online";
      this.runtime.worker = config.trustedWorkspaceMode ? "online" : "paused";
      this.runtime.pairing = "paired";
      this.runtime.lastError = config.trustedWorkspaceMode
        ? null
        : "当前为受限工作区模式；Connector 不领取远程执行任务。";
      this.runtime.workerId = config.workerId;
      this.runtime.workspaceCount = config.authorizedWorkspaceIds.length;
      return {
        ok: true,
        code: "connected",
        message: config.trustedWorkspaceMode
          ? "连接成功。授权 Harness Workspace 已报告给 Cloud。"
          : "连接成功；当前处于受限工作区模式，Connector 不领取远程执行任务。",
        workerId: config.workerId,
      };
    } catch (error) {
      const mapped = classifyConnectionError(error);
      this.runtime.cloud = mapped.cloud;
      this.runtime.worker = "error";
      this.runtime.lastError = mapped.message;
      return { ok: false, code: mapped.code, message: mapped.message };
    }
  }
}

function markRemoteMethod(prototype, methodName) {
  const initializers = [];
  Remote(prototype[methodName], {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    access: {
      has: (object) => methodName in object,
      get: (object) => object[methodName],
    },
    addInitializer(initializer) { initializers.push(initializer); },
  });
  const receiver = Object.create(prototype);
  for (const initializer of initializers) initializer.call(receiver);
}

for (const method of ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates", "openBridgeBrowser", "testBridge"]) {
  markRemoteMethod(WorkerControlService.prototype, method);
}

export default WorkerControlService;

async function runWorker(ctx, input, runtime, signal, wakeCoordinator) {
  let registeredToken;
  let registeredSignature = "";
  let lastHeartbeatAt = 0;
  let checkedToken;
  let checkedEndpoint;
  let checkedPairingState;

  const activeTasks = new AsyncTaskPool({
    limit: 24,
    onSizeChange: (size) => {
      runtime.activeTaskCount = size;
      runtime.workerBusy = size > 0;
    },
    onTaskError: (error, taskId) => {
      if (!signal.aborted) {
        ctx.logger.warn("deepseek-worker task %s failed outside lease handler: %s", taskId, redactSecret(error));
      }
    },
  });

  try {
    while (!signal.aborted) {
    let pollIntervalMs = 4000;
    let token;
    try {
      const config = currentConfig(input);
      pollIntervalMs = config.pollIntervalMs;
      const controller = currentSessionController(ctx);
      const workspaces = workspaceState(config, ctx.workspaceRegistry);
      runtime.workerId = config.workerId;
      runtime.workspaceCount = workspaces.count;
      runtime.execution = executionMode(controller !== undefined);
      runtime.maxConcurrentTasks = config.maxConcurrentTasks;
      activeTasks.setLimit(config.maxConcurrentTasks);

      const credentials = currentCredentials(ctx);
      if (credentials === undefined) {
        runtime.credential = "unconfigured";
        runtime.worker = "paused";
        runtime.lastError = "Harness Credential provider 不可用。";
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }
      token = await resolveWorkerToken(credentials);
      if (!token) {
        runtime.credential = "unconfigured";
        runtime.worker = "paused";
        runtime.lastError = "LOCAL_WORKER_TOKEN 未配置。";
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }
      runtime.credential = "configured";

      if (checkedToken !== token || checkedEndpoint !== config.endpoint || checkedPairingState !== "paired") {
        const pair = await pairingRequest(config, token, "status", {}, signal).catch((error) => {
          const mapped = classifyPairingError(error);
          if (["unpaired", "revoked", "expired"].includes(mapped.state)) return { state: mapped.state };
          throw error;
        });
        checkedToken = token;
        checkedEndpoint = config.endpoint;
        checkedPairingState = normalizePairingState(pair.state);
        runtime.pairing = checkedPairingState;
        runtime.cloud = "online";
        if (checkedPairingState !== "paired") {
          runtime.worker = "paused";
          runtime.lastError = checkedPairingState === "pending"
            ? "等待浏览器确认连接。"
            : "本机凭据已失效，请在 Connector 中重新连接 ChatGPT。";
          registeredSignature = "";
          registeredToken = undefined;
          await sleep(Math.max(pollIntervalMs, 30000), signal);
          continue;
        }
        runtime.lastError = null;
      }

      const hasConfiguredWorkspaces = config.authorizedWorkspaceIds.length > 0;
      const hasMissingWorkspaces = workspaces.missing.length > 0;
      const claimEnabled = hasConfiguredWorkspaces
        && workspaces.count > 0
        && !hasMissingWorkspaces
        && config.trustedWorkspaceMode;
      const presenceState = claimEnabled ? "online" : "paused";
      const workspacePayload = workspaceHeartbeatPayload(workspaces);

      const registrationSignature = JSON.stringify({
        endpoint: config.endpoint,
        workerId: config.workerId,
        workspaceIds: [...workspaces.workspaceIds].sort(),
        workspaces: workspacePayload.workspaces,
        trustedWorkspaceMode: config.trustedWorkspaceMode,
        clientVersion: CONNECTOR_VERSION,
      });
      if (registeredSignature !== registrationSignature || registeredToken !== token) {
        const registered = await workerRequest(config, token, "register", {
          hostname: hostname(),
          state: presenceState,
          ...workspacePayload,
          client_version: CONNECTOR_VERSION,
          chat_bridge_ready: bridgeReady(runtime, config),
        }, signal);
        await deliverBridgePayloads(config, registered, wakeCoordinator);
        registeredSignature = registrationSignature;
        registeredToken = token;
        lastHeartbeatAt = 0;
        runtime.cloud = "online";
        runtime.worker = presenceState;
        runtime.pairing = "paired";
      }

      if (Date.now() - lastHeartbeatAt >= config.heartbeatIntervalMs) {
        const heartbeat = await workerRequest(config, token, "heartbeat", {
          state: presenceState,
          ...workspacePayload,
          client_version: CONNECTOR_VERSION,
          chat_bridge_ready: bridgeReady(runtime, config),
        }, signal);
        await deliverBridgePayloads(config, heartbeat, wakeCoordinator);
        lastHeartbeatAt = Date.now();
        runtime.lastHeartbeat = new Date(lastHeartbeatAt).toISOString();
        runtime.cloud = "online";
        runtime.worker = presenceState;
      }

      if (!hasConfiguredWorkspaces) {
        runtime.worker = "paused";
        runtime.lastError = "未授权 Harness Workspace；Connector 已安全暂停。";
        await sleep(pollIntervalMs, signal);
        continue;
      }
      if (hasMissingWorkspaces) {
        runtime.worker = "paused";
        runtime.lastError = `授权 Workspace 已不存在：${workspaces.missing.join(", ")}。`;
        await sleep(pollIntervalMs, signal);
        continue;
      }
      if (!config.trustedWorkspaceMode) {
        runtime.worker = "paused";
        runtime.lastError = "当前为受限工作区模式；Connector 不领取远程执行任务。";
        await sleep(pollIntervalMs, signal);
        continue;
      }
      runtime.lastError = null;

      if (["waiting-idle", "installing"].includes(runtime.updateState)) {
        runtime.worker = "paused";
        await sleep(pollIntervalMs, signal);
        continue;
      }

      await fillTaskPool(
        activeTasks,
        () => workerRequest(config, token, "claim", {}, signal),
        (task) => processLease(ctx, config, token, task, signal, wakeCoordinator),
        signal,
      );
    } catch (error) {
      if (signal.aborted) break;
      const mapped = classifyConnectionError(error);
      runtime.cloud = mapped.cloud;
      runtime.worker = "error";
      if (mapped.code === "pairing_required") runtime.pairing = "pending";
      if (mapped.code === "credential_rejected") runtime.pairing = "unpaired";
      if (mapped.code === "credential_rejected") {
        checkedToken = token;
        checkedEndpoint = currentConfig(input).endpoint;
        checkedPairingState = "unpaired";
      }
      runtime.lastError = mapped.message;
      ctx.logger.warn("deepseek-worker connector loop: %s", redactSecret(error, token));
    }
      await sleep(pollIntervalMs, signal);
    }
  } finally {
    await activeTasks.waitForIdle();
    runtime.activeTaskCount = 0;
    runtime.workerBusy = false;
  }
}

async function sleep(ms, signal) {
  if (signal.aborted) return;
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export async function processLease(ctx, config, token, task, outerSignal, wakeCoordinator = null) {
  const leaseAbort = new AbortController();
  const relayAbort = () => leaseAbort.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", relayAbort, { once: true });
  let leaseLost = false;
  const renewer = renewLease(config, token, task.id, leaseAbort.signal).catch((error) => {
    leaseLost = true;
    leaseAbort.abort(error);
  });
  try {
    let workspaceId;
    let workspace;
    let execution;
    try {
      ({ workspaceId } = workspaceForTask(config, task));
      workspace = ctx.workspaceRegistry.get(workspaceId);
      if (workspace === undefined) throw new Error(`Authorized Harness Workspace "${workspaceId}" no longer exists`);
      const prompt = buildTaskPrompt(task);
      await workerRequest(config, token, "events", {
        task_id: task.id,
        event: "local_started",
        data: { workspace_id: workspaceId, trusted_workspace: config.trustedWorkspaceMode },
      }, outerSignal);
      const controller = currentSessionController(ctx);
      execution = controller
        ? await executeNativeSession(ctx, controller, task, workspace, prompt, leaseAbort.signal, config.leaseWaitTimeoutMs)
        : await executeHeadless(config, task, workspace, prompt, leaseAbort.signal);
    } catch (error) {
      if (!leaseLost && !outerSignal.aborted) {
        const failure = await workerRequest(config, token, "failure", {
          task_id: task.id,
          error: redactSecret(error, token),
        }, outerSignal).catch((uploadError) => {
          ctx.logger?.warn?.("deepseek-worker task %s failure upload failed: %s", task.id, redactSecret(uploadError, token));
          return null;
        });
        if (failure) {
          await enqueueTerminalWake(ctx, config, failure, wakeCoordinator, { taskId: task.id, terminalState: "failed" });
        }
      }
      return;
    }
    if (leaseLost || leaseAbort.signal.aborted && !outerSignal.aborted) return;

    const result = await workerRequest(config, token, "result", {
      task_id: task.id,
      result: execution.result,
      session_id: execution.sessionId,
      metadata: {
        executor: execution.executor,
        workspace_id: workspaceId,
        trusted_workspace: config.trustedWorkspaceMode,
      },
    }, outerSignal).catch((error) => {
      ctx.logger?.warn?.("deepseek-worker task %s result upload failed: %s", task.id, redactSecret(error, token));
      return null;
    });
    if (result) {
      await enqueueTerminalWake(ctx, config, result, wakeCoordinator, { taskId: task.id, terminalState: "completed" });
    }
  } finally {
    leaseAbort.abort();
    outerSignal.removeEventListener("abort", relayAbort);
    await renewer.catch(() => {});
  }
}

async function enqueueTerminalWake(ctx, config, response, wakeCoordinator, terminal) {
  try {
    await deliverBridgePayloads(config, response, wakeCoordinator, terminal);
  } catch (error) {
    ctx.logger?.warn?.("deepseek-worker task %s terminal was uploaded but its wake could not be persisted: %s", terminal.taskId, redactSecret(error));
  }
}

export async function deliverBridgePayloads(config, response, wakeCoordinator, terminal = null) {
  if (!wakeCoordinator || !response || config.chatBridgeEnabled === false) return { accepted: 0, localWake: null };
  return wakeCoordinator.acceptResponse(response, terminal);
}

async function renewLease(config, token, taskId, signal) {
  while (!signal.aborted) {
    await delay(config.leaseRenewIntervalMs, undefined, { signal });
    if (signal.aborted) return;
    await workerRequest(config, token, "lease/renew", { task_id: taskId }, signal);
  }
}

async function executeHeadless(config, task, workspace, prompt, signal) {
  if (!config.enableHeadlessFallback) {
    throw new Error("Harness Session Controller is unavailable and headless fallback is disabled");
  }
  if (task.session_id || task.harness_session_id) {
    throw new Error("Cannot safely resume an existing Harness Session through the generic headless fallback");
  }
  const cwd = workspace.path;
  const args = [...config.headlessArgs, "--cwd", cwd, "--prompt", prompt];
  const child = spawn(config.headlessCommand, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const limit = 8 * 1024 * 1024;
  let size = 0;
  const collect = (target) => (chunk) => {
    size += chunk.length;
    if (size > limit) child.kill(); else target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  signal.removeEventListener("abort", abort);
  if (signal.aborted) throw signal.reason || new Error("Harness task aborted");
  if (code !== 0) {
    throw new Error(`Headless Harness exited with ${code}: ${redactSecret(Buffer.concat(stderr).toString("utf8").slice(-4000))}`);
  }
  const text = Buffer.concat(stdout).toString("utf8").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Headless Harness did not return JSON output"); }
  const result = extractAssistantText(parsed);
  if (!result) throw new Error("Headless Harness returned no assistant result");
  return {
    result,
    sessionId: parsed.session_id || parsed.sessionId || null,
    executor: "harness-headless-fallback",
  };
}