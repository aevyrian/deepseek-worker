import { randomBytes } from "node:crypto";
import path from "node:path";

export const TOKEN_REF = "LOCAL_WORKER_TOKEN";
export const DEFAULT_ENDPOINT = "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker";
export const DEFAULT_WORKER_ID = "deepseek-worker-windows";

export function unwrapConfigValue(value) {
  return value && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

export function snapshotConnectorInput(input = {}) {
  return {
    endpoint: unwrapConfigValue(input.endpoint),
    workerId: unwrapConfigValue(input.workerId),
    pollIntervalMs: unwrapConfigValue(input.pollIntervalMs),
    heartbeatIntervalMs: unwrapConfigValue(input.heartbeatIntervalMs),
    leaseRenewIntervalMs: unwrapConfigValue(input.leaseRenewIntervalMs),
    leaseWaitTimeoutMs: unwrapConfigValue(input.leaseWaitTimeoutMs),
    workspaceAllowlist: unwrapConfigValue(input.workspaceAllowlist),
    enableHeadlessFallback: unwrapConfigValue(input.enableHeadlessFallback),
    headlessCommand: unwrapConfigValue(input.headlessCommand),
    headlessArgs: unwrapConfigValue(input.headlessArgs),
  };
}

export function isAbsoluteLocalPath(value) {
  return typeof value === "string" && (isWindowsAbsolutePath(value) || path.posix.isAbsolute(value));
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

export function normalizeLocalPath(value) {
  if (!isAbsoluteLocalPath(value)) throw new Error("Workspace local path must be absolute");
  return isWindowsAbsolutePath(value) ? path.win32.normalize(value) : path.posix.normalize(value);
}

export function workspaceEntriesToAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error("Workspace entries must be an array");
  const result = {};
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const localPath = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!id) throw new Error("Workspace ID cannot be empty");
    if (Object.hasOwn(result, id)) throw new Error(`Duplicate Workspace ID: ${id}`);
    result[id] = normalizeLocalPath(localPath);
  }
  return result;
}

export function workerTokenFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32) {
    throw new Error("Worker token requires at least 32 bytes of entropy");
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function generateWorkerToken(source = () => randomBytes(32)) {
  return workerTokenFromBytes(source());
}

export function executionMode(hasSessionController) {
  return hasSessionController ? "native" : "headless";
}

export function publicRuntimeStatus(runtime, options = {}) {
  const status = {
    connector: runtime.connector || "loaded",
    execution: runtime.execution || "headless",
    credential: options.credentialConfigured === true ? "configured" : options.credentialConfigured === false ? "unconfigured" : (runtime.credential || "unknown"),
    cloud: runtime.cloud || "untested",
    worker: runtime.worker || "paused",
    lastHeartbeat: runtime.lastHeartbeat || null,
    workerId: options.workerId || runtime.workerId || "",
    workspaceCount: Number.isInteger(options.workspaceCount) ? options.workspaceCount : (runtime.workspaceCount || 0),
    lastError: runtime.lastError || null,
  };
  return Object.freeze(status);
}

export function classifyConnectionError(error) {
  const status = Number(error?.status || 0);
  const serverCode = typeof error?.serverCode === "string" ? error.serverCode.toLowerCase() : "";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  if (status === 401) {
    if (/secret.*missing|token.*missing|local_worker_token.*missing/.test(serverCode + " " + message)) {
      return { code: "cloud_token_missing", message: "云端尚未配置 LOCAL_WORKER_TOKEN（HTTP 401）", cloud: "unauthenticated" };
    }
    return { code: "token_mismatch", message: "Token 未配置于云端或与云端不匹配（HTTP 401）", cloud: "unauthenticated" };
  }
  if (status === 403) {
    if (/unpaired|not[_ -]?paired|not[_ -]?registered|worker[_ -]?missing/.test(serverCode + " " + message)) {
      return { code: "worker_unpaired", message: "此 Worker 尚未在 DeepSeek Worker Cloud 中配对，请先通过 ChatGPT 的 DeepSeek Worker MCP 注册该 Worker ID。", cloud: "online" };
    }
    return { code: "forbidden", message: "Worker 未授权或 Workspace 不允许（HTTP 403）；如尚未配对，请先通过 MCP 注册 Worker ID。", cloud: "online" };
  }
  if (/certificate|tls|ssl|self[- ]signed|unable to verify/.test(message)) {
    return { code: "tls", message: "TLS 连接失败，请检查证书与 HTTPS 地址。", cloud: "offline" };
  }
  if (/fetch failed|network|enotfound|econnrefused|econnreset|etimedout|timeout|aborted/.test(message)) {
    return { code: "network", message: "网络无法访问 DeepSeek Worker Cloud。", cloud: "offline" };
  }
  if (status > 0) return { code: "http", message: `DeepSeek Worker Cloud 返回 HTTP ${status}。`, cloud: "online" };
  return { code: "unknown", message: "连接测试失败，请检查 Harness 日志中的脱敏错误。", cloud: "offline" };
}

export function redactSecret(message, secret) {
  let text = message instanceof Error ? message.message : String(message ?? "");
  if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
