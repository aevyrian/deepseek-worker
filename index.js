import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import Schema from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_WORKER_ID,
  TOKEN_REF,
  classifyConnectionError,
  executionMode,
  generateWorkerToken,
  publicRuntimeStatus,
  redactSecret,
  snapshotConnectorInput,
} from "./lib/connector-config.mjs";
import { buildTaskPrompt, extractAssistantText, normalizeConfig, workerRequest, workspaceForTask } from "./lib/protocol.mjs";

export const name = "deepseek-worker-connector";

const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export const Config = Schema.object({
  endpoint: Schema.string().pattern(/^https:\/\//u).default(DEFAULT_ENDPOINT).volatile(),
  workerId: Schema.string().pattern(/\S/u).default(DEFAULT_WORKER_ID).volatile(),
  pollIntervalMs: Schema.number().step(1).min(1000).max(60000).default(4000).volatile(),
  heartbeatIntervalMs: Schema.number().step(1).min(5000).max(300000).default(20000).volatile(),
  leaseRenewIntervalMs: Schema.number().step(1).min(5000).max(55000).default(20000).volatile(),
  leaseWaitTimeoutMs: Schema.number().step(1).min(10000).max(86400000).default(1800000).volatile(),
  workspaceAllowlist: Schema.dict(Schema.string().pattern(ABSOLUTE_PATH_PATTERN)).default({}).volatile(),
  enableHeadlessFallback: Schema.boolean().default(true).volatile(),
  headlessCommand: Schema.string().pattern(/\S/u).default("dsh").volatile(),
  headlessArgs: Schema.array(Schema.string()).default(["--profile", "headless", "--json"]).volatile(),
});

function currentConfig(input) {
  return normalizeConfig(snapshotConnectorInput(input));
}

function currentSessionController(ctx) {
  try {
    return typeof ctx.get === "function" ? ctx.get("sessionController") : ctx.sessionController;
  } catch {
    return undefined;
  }
}

function initialRuntime(ctx) {
  return {
    connector: "loaded",
    execution: executionMode(Boolean(currentSessionController(ctx))),
    credential: "unknown",
    cloud: "untested",
    worker: "paused",
    lastHeartbeat: null,
    workerId: DEFAULT_WORKER_ID,
    workspaceCount: 0,
    lastError: null,
  };
}

class WorkerControlService extends TypertRemoteService {
  constructor(ctx, input, runtime) {
    super(ctx, "deepseekWorkerConnectorControl", { namespace: "deepseekWorkerConnector" });
    this.owner = ctx;
    this.input = input;
    this.runtime = runtime;
  }

  async status() {
    let credentialConfigured = false;
    try {
      credentialConfigured = Boolean(await this.owner.credentials.resolve(TOKEN_REF));
    } catch {}
    try {
      const config = currentConfig(this.input);
      this.runtime.workerId = config.workerId;
      this.runtime.workspaceCount = Object.keys(config.workspaceAllowlist).length;
      this.runtime.execution = executionMode(Boolean(currentSessionController(this.owner)));
      return publicRuntimeStatus(this.runtime, {
        credentialConfigured,
        workerId: config.workerId,
        workspaceCount: this.runtime.workspaceCount,
      });
    } catch (error) {
      return publicRuntimeStatus({ ...this.runtime, worker: "error", lastError: redactSecret(error) }, { credentialConfigured });
    }
  }

  generateToken() {
    return { token: generateWorkerToken(), ref: TOKEN_REF };
  }

  async test() {
    let config;
    try {
      config = currentConfig(this.input);
    } catch (error) {
      return { ok: false, code: "config_invalid", message: redactSecret(error) };
    }
    const workspaceIds = Object.keys(config.workspaceAllowlist);
    if (workspaceIds.length === 0) {
      return { ok: false, code: "workspace_missing", message: "Workspace 未配置。请至少添加一个允许访问的本地目录。" };
    }
    let token;
    try {
      token = await this.owner.credentials.resolve(TOKEN_REF);
    } catch (error) {
      return { ok: false, code: "credential_error", message: `读取 Harness Credentials 失败：${redactSecret(error)}` };
    }
    if (!token) return { ok: false, code: "token_missing", message: "Worker Token 未配置。" };
    try {
      await workerRequest(config, token, "register", {
        hostname: hostname(),
        workspace_allowlist: workspaceIds,
      }, AbortSignal.timeout(10000));
      this.runtime.credential = "configured";
      this.runtime.cloud = "online";
      this.runtime.worker = "online";
      this.runtime.lastError = null;
      this.runtime.workerId = config.workerId;
      this.runtime.workspaceCount = workspaceIds.length;
      return { ok: true, code: "connected", message: "连接成功。", workerId: config.workerId };
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

for (const method of ["status", "generateToken", "test"]) markRemoteMethod(WorkerControlService.prototype, method);

export async function apply(ctx, input = {}) {
  const lifecycle = new AbortController();
  const runtime = initialRuntime(ctx);
  ctx.effect(() => () => lifecycle.abort(new Error("DeepSeek Worker Connector stopped")));

  await ctx.inject(["credentials"], async (scope) => {
    new WorkerControlService(scope, input, runtime);
    try {
      await runWorker(scope, input, runtime, lifecycle.signal);
    } catch (error) {
      if (!lifecycle.signal.aborted) scope.logger.error("deepseek-worker connector stopped: %s", redactSecret(error));
    }
  });
}

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
      const workspaceIds = Object.keys(config.workspaceAllowlist);
      runtime.workerId = config.workerId;
      runtime.workspaceCount = workspaceIds.length;
      runtime.execution = executionMode(Boolean(currentSessionController(ctx)));

      if (workspaceIds.length === 0) {
        runtime.worker = "paused";
        runtime.lastError = "Workspace allowlist 为空；Connector 已安全暂停。";
        registeredSignature = "";
        registeredToken = undefined;
        await sleep(pollIntervalMs, signal);
        continue;
      }

      token = await ctx.credentials.resolve(TOKEN_REF);
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

      const registrationSignature = JSON.stringify({ endpoint: config.endpoint, workerId: config.workerId, workspaceIds: [...workspaceIds].sort() });
      if (registeredSignature !== registrationSignature || registeredToken !== token) {
        await workerRequest(config, token, "register", { hostname: hostname(), workspace_allowlist: workspaceIds }, signal);
        registeredSignature = registrationSignature;
        registeredToken = token;
        lastHeartbeatAt = 0;
        runtime.cloud = "online";
        runtime.worker = "online";
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

      const claim = await workerRequest(config, token, "claim", {}, signal);
      if (claim?.task) await processLease(ctx, config, token, claim.task, signal);
    } catch (error) {
      if (signal.aborted) break;
      const mapped = classifyConnectionError(error);
      runtime.cloud = mapped.cloud;
      runtime.worker = "error";
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
    const { workspaceId, cwd } = workspaceForTask(config, task);
    const prompt = buildTaskPrompt(task);
    await workerRequest(config, token, "events", { task_id: task.id, event: "local_started", data: { workspace_id: workspaceId } }, outerSignal);
    const controller = currentSessionController(ctx);
    const execution = controller
      ? await executeNative(controller, task, cwd, prompt, leaseAbort.signal, config.leaseWaitTimeoutMs)
      : await executeHeadless(config, task, cwd, prompt, leaseAbort.signal);
    if (leaseLost || leaseAbort.signal.aborted && !outerSignal.aborted) throw leaseAbort.signal.reason || new Error("Worker lease was lost");
    await workerRequest(config, token, "result", {
      task_id: task.id,
      result: execution.result,
      session_id: execution.sessionId,
      metadata: { executor: execution.executor, workspace_id: workspaceId },
    }, outerSignal);
  } catch (error) {
    if (!leaseLost && !outerSignal.aborted) {
      await workerRequest(config, token, "failure", { task_id: task.id, error: redactSecret(error, token) }, outerSignal).catch(() => {});
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

async function executeNative(controller, task, cwd, prompt, signal, timeoutMs) {
  const existingSessionId = task.session_id || task.harness_session_id || null;
  const session = existingSessionId
    ? await controller.resume(existingSessionId, { cwd, signal })
    : await controller.create({ cwd, signal });
  const sessionId = typeof session === "string" ? session : session?.id || existingSessionId;
  if (!sessionId) throw new Error("Harness Session Controller did not return a session ID");
  await controller.submit(session, { text: prompt, signal });
  const completed = typeof controller.waitForIdle === "function"
    ? await controller.waitForIdle(session, { timeoutMs, signal })
    : typeof controller.snapshot === "function" ? await controller.snapshot(session) : null;
  const result = extractAssistantText(completed);
  if (!result) throw new Error("Harness Session finished without an assistant result");
  return { result, sessionId, executor: "harness-session-controller" };
}

async function executeHeadless(config, task, cwd, prompt, signal) {
  if (!config.enableHeadlessFallback) throw new Error("Harness Session Controller is unavailable and headless fallback is disabled");
  const args = [...config.headlessArgs, "--cwd", cwd, "--prompt", prompt];
  if (task.session_id || task.harness_session_id) throw new Error("Cannot safely resume an existing Harness Session through the generic headless fallback");
  const child = spawn(config.headlessCommand, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  signal.removeEventListener("abort", abort);
  if (signal.aborted) throw signal.reason || new Error("Harness task aborted");
  if (code !== 0) throw new Error(`Headless Harness exited with ${code}: ${redactSecret(Buffer.concat(stderr).toString("utf8").slice(-4000))}`);
  const text = Buffer.concat(stdout).toString("utf8").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Headless Harness did not return JSON output"); }
  const result = extractAssistantText(parsed);
  if (!result) throw new Error("Headless Harness returned no assistant result");
  return { result, sessionId: parsed.session_id || parsed.sessionId || null, executor: "harness-headless-fallback" };
}
