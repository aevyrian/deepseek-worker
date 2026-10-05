import { createHash } from "node:crypto";

const pairingRoutes = new Set(["start", "status", "disconnect"]);
const pairingStates = new Set(["unpaired", "pending", "paired", "expired", "revoked", "error"]);

export class PairingApiError extends Error {
  constructor(status, serverCode) {
    super(`Pairing API returned HTTP ${status}`);
    this.name = "PairingApiError";
    this.status = status;
    this.serverCode = serverCode || undefined;
  }
}

export function credentialValue(resolved) {
  if (resolved === undefined) return "";
  if (
    resolved
    && typeof resolved === "object"
    && typeof resolved.value === "string"
    && resolved.value.length > 0
    && typeof resolved.source === "string"
  ) {
    return resolved.value;
  }
  throw new TypeError("Harness Credentials resolve() returned an unexpected value shape");
}

export function credentialInfo(info) {
  if (
    !info
    || typeof info !== "object"
    || typeof info.configured !== "boolean"
    || typeof info.writable !== "boolean"
    || (info.source !== undefined && typeof info.source !== "string")
  ) {
    throw new TypeError("Harness Credentials describe() returned an unexpected value shape");
  }
  return {
    configured: info.configured,
    ...(info.source === undefined ? {} : { source: info.source }),
    writable: info.writable,
  };
}

export function hashWorkerToken(token) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Worker token is too short");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function cloudBaseFromWorkerEndpoint(endpointValue) {
  const endpoint = new URL(endpointValue);
  const path = endpoint.pathname.replace(/\/+$/u, "");
  if (!path.endsWith("/api/worker")) throw new Error("Worker endpoint must end with /api/worker for automatic pairing");
  endpoint.pathname = path.slice(0, -"/api/worker".length) || "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/u, "");
}

export function setupUrlFromWorkerEndpoint(endpointValue) {
  return `${cloudBaseFromWorkerEndpoint(endpointValue)}/setup`;
}

export function normalizeApprovalUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Pairing approval URL must be credential-free HTTPS");
  }
  return url.href;
}

export function normalizePairingState(value) {
  const state = value === "active" ? "paired" : String(value || "unknown").toLowerCase();
  return pairingStates.has(state) ? state : "error";
}

export function isTerminalPairingState(value) {
  return ["paired", "expired", "revoked", "error"].includes(normalizePairingState(value));
}

async function responseCodeAndJson(response) {
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Pairing API response exceeded the size limit");
  let parsed = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
  }
  const candidates = [parsed?.code, parsed?.error_code, parsed?.error?.code, parsed?.error, parsed?.message];
  const code = candidates.find((value) => typeof value === "string" && value.length <= 160);
  return { code, parsed };
}

export async function pairingRequest(config, token, route, body = {}, signal) {
  if (!pairingRoutes.has(route)) throw new Error("Unknown Pairing API route");
  const base = cloudBaseFromWorkerEndpoint(config.endpoint);
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/api/pair/${route}`, {
    method: "POST",
    redirect: "error",
    signal,
    headers,
    body: JSON.stringify({ worker_id: config.workerId, ...body }),
  });
  const result = await responseCodeAndJson(response);
  if (!response.ok) throw new PairingApiError(response.status, result.code);
  return result.parsed;
}

export function classifyPairingError(error) {
  const status = Number(error?.status || 0);
  const code = typeof error?.serverCode === "string" ? error.serverCode.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();

  if (status === 404) {
    return { code: "pairing_api_unavailable", state: "error", message: "Cloud 配对 API 当前不可用。" };
  }
  if (status === 409) {
    return { code: "pairing_conflict", state: "error", message: "该 Worker 存在冲突的配对请求，请检查当前状态后重试。" };
  }
  if (status === 410) {
    return { code: "pairing_expired", state: "expired", message: "连接请求已过期，请重新点击安装并连接。" };
  }
  if (status === 429) {
    return { code: "pairing_rate_limited", state: "error", message: "配对请求过于频繁，请稍后再试。" };
  }
  if (status === 401) {
    return { code: "pairing_credential_rejected", state: "unpaired", message: "本机 Worker 凭据无效或已撤销，请重新连接。" };
  }
  if (status === 403) {
    const state = /revoked/.test(code) ? "revoked" : "error";
    return {
      code: state === "revoked" ? "pairing_revoked" : "pairing_denied",
      state,
      message: state === "revoked" ? "此设备连接已被撤销。" : "配对未获授权或已被拒绝。",
    };
  }
  if (/fetch failed|network|enotfound|econnrefused|econnreset|etimedout|timeout|aborted/.test(message)) {
    return { code: "pairing_network", state: "error", message: "无法访问 DeepSeek Worker Cloud 配对服务。" };
  }
  if (status > 0) {
    return { code: code || "pairing_http", state: "error", message: `配对服务返回 HTTP ${status}。` };
  }
  return { code: "pairing_unknown", state: "error", message: "配对失败，请查看 Harness 日志中的脱敏错误。" };
}
