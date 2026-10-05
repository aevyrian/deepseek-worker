import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { buildTaskPrompt, extractAssistantText, normalizeConfig, workerRequest, workspaceForTask } from "./lib/protocol.mjs";

export const name = "deepseek-worker-connector";

export function apply(ctx, input = {}) {
  const config = normalizeConfig({ ...input, workerId: input.workerId || `deepseek-worker-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}` });
  const lifecycle = new AbortController();
  const running = ctx.inject(["credentials"], (injected) => {
    const host = injected;
    const credentials = host.credentials;
    const logger = host.logger || console;
    const controller = host.sessionController;
    host.effect(() => {
      const loop = runWorker({ config, credentials, controller, logger, signal: lifecycle.signal });
      void loop.catch((error) => logger.error(`[${name}] worker stopped: ${safeMessage(error)}`));
      return () => lifecycle.abort();
    }, "deepseek-worker-connector: stop polling");
  });
  void Promise.resolve(running).catch((error) => {
    if (!lifecycle.signal.aborted) (ctx.logger || console).error(`[${name}] startup failed: ${safeMessage(error)}`);
  });
}

async function runWorker({ config, credentials, controller, logger, signal }) {
  const workspaceIds = Object.keys(config.workspaceAllowlist);
  logger.info(`[${name}] loaded; ${controller ? "ctx.sessionController is available (native Harness execution)" : "ctx.sessionController is unavailable (headless fallback only)"}`);
  if (!workspaceIds.length) {
    logger.warn(`[${name}] paused safely: workspaceAllowlist is empty; no Site requests will be sent`);
    return;
  }
  if (typeof credentials?.resolve !== "function") {
    logger.error(`[${name}] ctx.credentials.resolve is unavailable; worker not started`);
    return;
  }
  let registered = false;
  let lastHeartbeat = 0;
  logger.info(`[${name}] starting worker ${config.workerId}; ${workspaceIds.length} workspace(s) allowlisted`);
  while (!signal.aborted) {
    try {
      const resolved = await credentials.resolve("LOCAL_WORKER_TOKEN");
      const token = typeof resolved === "string" ? resolved : resolved?.value;
      if (!token) throw new Error("LOCAL_WORKER_TOKEN is not configured in Harness credentials");
      if (!registered) {
        await workerRequest(config, token, "register", { workspace_allowlist: workspaceIds }, signal);
        registered = true;
        logger.info(`[${name}] worker registered with the configured workspace allowlist`);
      }
      if (Date.now() - lastHeartbeat >= config.heartbeatIntervalMs) {
        await workerRequest(config, token, "heartbeat", {}, signal);
        lastHeartbeat = Date.now();
      }
      const response = await workerRequest(config, token, "claim", {}, signal);
      if (response?.task) await processLease({ config, credentials, controller, logger, task: response.task, signal });
      else await delay(config.pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) break;
      const message = safeMessage(error);
      logger.warn(`[${name}] poll failed: ${message}`);
      if (/HTTP 401|HTTP 403/.test(message)) registered = false;
      try { await delay(Math.max(config.pollIntervalMs, 8000), undefined, { signal }); } catch { break; }
    }
  }
}

async function processLease({ config, credentials, controller, logger, task, signal }) {
  const workspace = workspaceForTask(config, task);
  let leaseFailed = null;
  const renewAbort = new AbortController();
  const renew = renewLease({ config, credentials, task, signal, renewSignal: renewAbort.signal }).catch((error) => { leaseFailed = error; });
  try {
    const result = controller
      ? await runInHarnessSession({ config, credentials, controller, task, workspace, timeoutMs: config.leaseWaitTimeoutMs, signal })
      : config.enableHeadlessFallback
        ? await runHeadless(config, task, workspace, signal)
        : (() => { throw new Error("Harness sessionController unavailable and CLI fallback is disabled"); })();
    if (leaseFailed) throw new Error("Worker lease renewal failed; result was not committed");
    const token = await readToken(credentials);
    await workerRequest(config, token, "result", { task_id: task.id, result, ...(task.session_id ? { session_id: task.session_id } : {}) }, signal);
    logger.info(`[${name}] completed task ${task.id}`);
  } catch (error) {
    if (signal.aborted) return;
    const token = await readToken(credentials).catch(() => null);
    const message = safeMessage(error, token);
    if (token && !leaseFailed) {
      try { await workerRequest(config, token, "failure", { task_id: task.id, error: message.slice(0, 3000) }, signal); } catch (reportError) { logger.warn(`[${name}] could not report task failure: ${safeMessage(reportError, token)}`); }
    }
    logger.error(`[${name}] task ${task.id} failed: ${message}`);
  } finally {
    renewAbort.abort();
    await renew;
  }
}

async function renewLease({ config, credentials, task, signal, renewSignal }) {
  while (!signal.aborted && !renewSignal.aborted) {
    await delay(config.leaseRenewIntervalMs, undefined, { signal: renewSignal });
    if (signal.aborted || renewSignal.aborted) return;
    const token = await readToken(credentials);
    await workerRequest(config, token, "lease/renew", { task_id: task.id }, signal);
  }
}

async function runInHarnessSession({ config, credentials, controller, task, workspace, timeoutMs, signal }) {
  if (typeof controller.create !== "function" || typeof controller.prompt !== "function" || typeof controller.inspect !== "function") throw new Error("ctx.sessionController must provide create, prompt, and inspect");
  const sessionId = task.session_id || undefined;
  const created = await controller.create({ ...(sessionId ? { sessionId } : {}), workspaceId: workspace.workspaceId, cwd: workspace.cwd });
  const id = created.sessionId;
  if (!id) throw new Error("Harness did not return a Session ID");
  const initial = await controller.inspect(id, signal);
  const afterSeq = initial.events?.at(-1)?.seq ?? -1;
  const requestId = crypto.randomUUID();
  if (!task.session_id) {
    await workerRequest(config, await readToken(credentials), "events", { task_id: task.id, kind: "session_bound", detail: { session_id: id } }, signal);
    task.session_id = id;
  }
  await controller.prompt({ requestId, sessionId: id, mode: "queue", content: [{ type: "text", text: buildTaskPrompt(task) }] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    const inspection = await controller.inspect(id, signal);
    const events = inspection.events || [];
    const fresh = events.filter((event) => event.seq > afterSeq);
    const turnEnd = fresh.findLast((event) => event.type === "turn/end");
    if (turnEnd) {
      const assistant = fresh.slice(0, fresh.indexOf(turnEnd)).findLast((event) => event.type === "assistant/message");
      const answer = extractAssistantText(assistant?.data);
      if (answer) return answer;
      throw new Error("Harness Session ended without a final text response");
    }
    await delay(1000, undefined, { signal });
  }
  if (signal.aborted) throw new Error("Worker stopped while waiting for the Harness Session");
  throw new Error("Harness Session did not finish before the configured wait timeout");
}

async function runHeadless(config, task, workspace, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.headlessCommand, config.headlessArgs, { cwd: workspace.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part) => { stdout = (stdout + part).slice(-1_000_000); });
    child.stderr.on("data", (part) => { stderr = (stderr + part).slice(-16_000); });
    child.once("error", (error) => reject(new Error(`Headless CLI fallback could not start: ${error.message}`)));
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (code !== 0) return reject(new Error(stderr.trim() || `Headless CLI exited with code ${code}`));
      let answer = "";
      for (const line of stdout.split(/\r?\n/)) { try { const event = JSON.parse(line); if (event.type === "final") answer = event.text || ""; } catch { /* ignore non-JSON CLI output */ } }
      answer ? resolve(answer) : reject(new Error("Headless CLI returned no final event"));
    });
    child.stdin.end(buildTaskPrompt(task));
  });
}

async function readToken(credentials) {
  const resolved = await credentials.resolve("LOCAL_WORKER_TOKEN");
  const token = typeof resolved === "string" ? resolved : resolved?.value;
  if (!token) throw new Error("LOCAL_WORKER_TOKEN is not configured in Harness credentials");
  return token;
}

function safeMessage(error, token = "") {
  token = typeof token === "string" ? token : "";
  const value = error instanceof Error ? error.message : String(error);
  const escapedToken = token ? token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/LOCAL_WORKER_TOKEN\s*[:=]\s*\S+/gi, "LOCAL_WORKER_TOKEN=[redacted]").replace(escapedToken ? new RegExp(escapedToken, "g") : /$^/, "[redacted]").slice(0, 3000);
}
