import { randomBytes } from "node:crypto";

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
    authorizedWorkspaceIds: unwrapConfigValue(input.authorizedWorkspaceIds),
    trustedWorkspaceMode: unwrapConfigValue(input.trustedWorkspaceMode),
    enableHeadlessFallback: unwrapConfigValue(input.enableHeadlessFallback),
    autoUpdate: unwrapConfigValue(input.autoUpdate),
    updateChannel: unwrapConfigValue(input.updateChannel),
    headlessCommand: unwrapConfigValue(input.headlessCommand),
    headlessArgs: unwrapConfigValue(input.headlessArgs),
  };
}

export function normalizeAuthorizedWorkspaceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("authorizedWorkspaceIds must be an array");
  const result = [];
  const seen = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new Error("Each authorized Workspace ID must be a non-empty string");
    }
    const id = candidate.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function missingAuthorizedWorkspaceIds(authorizedIds, availableIds) {
  const available = new Set(Array.from(availableIds, (id) => String(id)));
  return normalizeAuthorizedWorkspaceIds(authorizedIds).filter((id) => !available.has(id));
}

export function reconcileAuthorizedWorkspaceIds(authorizedIds, availableIds) {
  const available = new Set(Array.from(availableIds, (id) => String(id)));
  return normalizeAuthorizedWorkspaceIds(authorizedIds).filter((id) => available.has(id));
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
  if (hasSessionController === true) return "native";
  if (hasSessionController === false) return "headless";
  return "unknown";
}

export function publicRuntimeStatus(runtime, options = {}) {
  return Object.freeze({
    connector: runtime.connector || "loaded",
    execution: runtime.execution || "unknown",
    credential: options.credentialConfigured === true
      ? "configured"
      : options.credentialConfigured === false ? "unconfigured" : (runtime.credential || "unknown"),
    cloud: runtime.cloud || "untested",
    worker: runtime.worker || "paused",
    lastHeartbeat: runtime.lastHeartbeat || null,
    workerId: options.workerId || runtime.workerId || "",
    workspaceCount: Number.isInteger(options.workspaceCount) ? options.workspaceCount : (runtime.workspaceCount || 0),
    missingWorkspaceIds: Array.isArray(options.missingWorkspaceIds) ? [...options.missingWorkspaceIds] : [],
    trustedWorkspaceMode: options.trustedWorkspaceMode === true,
    pairing: runtime.pairing || (options.credentialConfigured ? "unknown" : "unpaired"),
    pairingCode: runtime.pairingCode || null,
    approvalUrl: runtime.approvalUrl || null,
    pairingExpiresAt: runtime.pairingExpiresAt || null,
    currentVersion: runtime.currentVersion || "0.3.1",
    latestVersion: runtime.latestVersion || runtime.currentVersion || "0.3.1",
    updateState: runtime.updateState || "idle",
    lastCheckedAt: runtime.lastCheckedAt || null,
    restartRequired: runtime.restartRequired === true,
    lastUpdateError: runtime.lastUpdateError || null,
    lastError: runtime.lastError || null,
  });
}

export function classifyConnectionError(error) {
  const status = Number(error?.status || 0);
  const serverCode = typeof error?.serverCode === "string" ? error.serverCode.toLowerCase() : "";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  if (status === 401) {
    return { code: "credential_rejected", message: "本机 Worker 凭据无效或已撤销，请重新配对（HTTP 401）。", cloud: "unauthenticated" };
  }
  if (status === 403) {
    if (/unpaired|not[_ -]?paired|not[_ -]?registered|worker[_ -]?missing|pair/.test(serverCode + " " + message)) {
      return { code: "pairing_required", message: "此 Worker 尚未完成配对，请在 Connector 中点击“连接 DeepSeek Worker”（HTTP 403）。", cloud: "online" };
    }
    return { code: "forbidden", message: "Worker 未授权或 Workspace 不允许（HTTP 403）。", cloud: "online" };
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
