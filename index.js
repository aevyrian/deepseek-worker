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
import {
  classifyPairingError,
  credentialInfo,
  credentialValue,
  hashWorkerToken,
  normalizeApprovalUrl,
  normalizePairingState,
  pairingRequest,
} from "./lib/pairing.mjs";
import {
  AutoUpdateController,
  CONNECTOR_VERSION,
  createUpdateRuntime,
  publicUpdateStatus,
} from "./lib/update.mjs";

export const name = "deepseek-worker-connector";

export const Config = Schema.object({
  endpoint: Schema.string().pattern(/^https:\/\//u).default(DEFAULT_ENDPOINT).volatile(),
  workerId: Schema.string().pattern(/\S/u).default(DEFAULT_WORKER_ID).volatile(),
  pollIntervalMs: Schema.number().step(1).min(1000).max(60000).default(4000).volatile(),
  heartbeatIntervalMs: Schema.number().step(1).min(5000).max(300000).default(20000).volatile(),
  leaseRenewIntervalMs: Schema.number().step(1).min(5000).max(55000).default(20000).volatile(),
  leaseWaitTimeoutMs: Schema.number().step(1).min(10000).max(86400000).default(1800000).volatile(),
  authorizedWorkspaceIds: Schema.array(Schema.string().pattern(/\S/u)).default([]).volatile(),
  trustedWorkspaceMode: Schema.boolean().default(true).volatile(),
  enableHeadlessFallback: Schema.boolean().default(true).volatile(),
  autoUpdate: Schema.boolean().default(true).volatile(),
  updateChannel: Schema.union([Schema.const("stable"), Schema.const("preview")]).default("stable").volatile(),
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
    lastError: null,
  };
}

function workspaceState(config, registry) {
  const availableIds = registry.list().map((workspace) => String(workspace.id));
  return {
    missing: missingAuthorizedWorkspaceIds(config.authorizedWorkspaceIds, availableIds),
    count: config.authorizedWorkspaceIds.length,
  };
}

export class WorkerControlService extends TypertRemoteService {
  static inject = ["workspaceRegistry"];
  static Config = Config;

  constructor(ctx, input = {}) {
    super(ctx, "deepseekWorkerConnectorControl", { namespace: "deepseekWorkerConnector" });
    this.input = input;
    this.runtime = initialRuntime();
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
      const lifecycle = new AbortController();
      const worker = runWorker(ctx, input, this.runtime, lifecycle.signal).catch((error) => {
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
      });
    } catch (error) {
      return publicRuntimeStatus(
        { ...this.runtime, execution: "unknown", worker: "error", lastError: redactSecret(error) },
        { credentialConfigured },
      );
    }
  }

  async beginPairing() {
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

    const token = generateWorkerToken();

    try {
      await saveWorkerToken(credentials, token);
    } catch (error) {
      return {
        ok: false,
        code: "credential_write_failed",
        state: "error",
        message: `保存本机 Worker 凭据失败：${redactSecret(error, token)}`,
      };
    }

    this.runtime.credential = "configured";
    this.runtime.worker = "paused";
    this.runtime.pairing = "pending";
    this.runtime.lastError = null;

    try {
      const started = await pairingRequest(config, undefined, "start", {
        token_hash: hashWorkerToken(token),
        hostname: hostname(),
        workspace_allowlist: config.authorizedWorkspaceIds,
        client_version: "0.3.2",
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

      this.runtime.pairing = state;
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
        workspace_allowlist: config.authorizedWorkspaceIds,
      }, AbortSignal.timeout(10000));
      this.runtime.credential = "configured";
      this.runtime.cloud = "online";
      this.runtime.worker = config.trustedWorkspaceMode ? "online" : "paused";
      this.runtime.pairing = "paired";
      this.runtime.lastError = config.trustedWorkspaceMode
        ? null
        : "当前为受限工作区模式；0.3.2 不领取远程执行任务。";
      this.runtime.workerId = config.workerId;
      this.runtime.workspaceCount = config.authorizedWorkspaceIds.length;
      return {
        ok: true,
        code: "connected",
        message: config.trustedWorkspaceMode
          ? "连接成功。授权 Harness Workspace 已报告给 Cloud。"
          : "连接成功；当前处于受限工作区模式，0.3.2 不领取远程执行任务。",
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

for (const method of ["status", "generateToken", "test", "beginPairing", "pairingStatus", "disconnectPairing", "checkForUpdates"]) {
  markRemoteMethod(WorkerControlService.prototype, method);
}

export default WorkerControlService;

async function runWorker(ctx, input, runtime, signal) {
  let registeredToken;
  let registeredSignature = "";
  let lastHeartbeatAt = 0;

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

      if (config.authorizedWorkspaceIds.length === 0) {
        runtime.worker = "paused";
        runtime.lastError = "未授权 Harness Workspace；Connector 已安全暂停。";
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }
      if (workspaces.missing.length > 0) {
        runtime.worker = "paused";
        runtime.lastError = `授权 Workspace 已不存在：${workspaces.missing.join(", ")}。`;
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }
      if (!config.trustedWorkspaceMode) {
        runtime.worker = "paused";
        runtime.lastError = "当前为受限工作区模式；0.3.2 不领取远程执行任务。";
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }

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

      const registrationSignature = JSON.stringify({
        endpoint: config.endpoint,
        workerId: config.workerId,
        workspaceIds: [...config.authorizedWorkspaceIds].sort(),
      });
      if (registeredSignature !== registrationSignature || registeredToken !== token) {
        await workerRequest(config, token, "register", {
          hostname: hostname(),
          workspace_allowlist: config.authorizedWorkspaceIds,
        }, signal);
        registeredSignature = registrationSignature;
        registeredToken = token;
        lastHeartbeatAt = 0;
        runtime.cloud = "online";
        runtime.worker = "online";
        runtime.pairing = "paired";
        runtime.lastError = null;
      }

      if (Date.now() - lastHeartbeatAt >= config.heartbeatIntervalMs) {
        await workerRequest(config, token, "heartbeat", { state: "online" }, signal);
        lastHeartbeatAt = Date.now();
        runtime.lastHeartbeat = new Date(lastHeartbeatAt).toISOString();
        runtime.cloud = "online";
        runtime.worker = "online";
        runtime.lastError = null;
      }

      if (["waiting-idle", "installing"].includes(runtime.updateState)) {
        runtime.worker = "paused";
        await sleep(pollIntervalMs, signal);
        continue;
      }

      runtime.workerBusy = true;
      try {
        const claim = await workerRequest(config, token, "claim", {}, signal);
        if (claim?.task) await processLease(ctx, config, token, claim.task, signal);
      } finally {
        runtime.workerBusy = false;
      }
    } catch (error) {
      if (signal.aborted) break;
      const mapped = classifyConnectionError(error);
      runtime.cloud = mapped.cloud;
      runtime.worker = "error";
      if (mapped.code === "pairing_required") runtime.pairing = "pending";
      if (mapped.code === "credential_rejected") runtime.pairing = "unpaired";
      runtime.lastError = mapped.message;
      ctx.logger.warn("deepseek-worker connector loop: %s", redactSecret(error, token));
    }
    await sleep(pollIntervalMs, signal);
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

async function processLease(ctx, config, token, task, outerSignal) {
  const leaseAbort = new AbortController();
  const relayAbort = () => leaseAbort.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", relayAbort, { once: true });
  let leaseLost = false;
  const renewer = renewLease(config, token, task.id, leaseAbort.signal).catch((error) => {
    leaseLost = true;
    leaseAbort.abort(error);
  });
  try {
    const { workspaceId } = workspaceForTask(config, task);
    const workspace = ctx.workspaceRegistry.get(workspaceId);
    if (workspace === undefined) throw new Error(`Authorized Harness Workspace "${workspaceId}" no longer exists`);
    const prompt = buildTaskPrompt(task);
    await workerRequest(config, token, "events", {
      task_id: task.id,
      event: "local_started",
      data: { workspace_id: workspaceId, trusted_workspace: config.trustedWorkspaceMode },
    }, outerSignal);
    const controller = currentSessionController(ctx);
    const execution = controller
      ? await executeNativeSession(ctx, controller, task, workspace, prompt, leaseAbort.signal, config.leaseWaitTimeoutMs)
      : await executeHeadless(config, task, workspace, prompt, leaseAbort.signal);
    if (leaseLost || leaseAbort.signal.aborted && !outerSignal.aborted) {
      throw leaseAbort.signal.reason || new Error("Worker lease was lost");
    }
    await workerRequest(config, token, "result", {
      task_id: task.id,
      result: execution.result,
      session_id: execution.sessionId,
      metadata: {
        executor: execution.executor,
        workspace_id: workspaceId,
        trusted_workspace: config.trustedWorkspaceMode,
      },
    }, outerSignal);
  } catch (error) {
    if (!leaseLost && !outerSignal.aborted) {
      await workerRequest(config, token, "failure", {
        task_id: task.id,
        error: redactSecret(error, token),
      }, outerSignal).catch(() => {});
    }
  } finally {
    leaseAbort.abort();
    outerSignal.removeEventListener("abort", relayAbort);
    await renewer.catch(() => {});
  }
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
