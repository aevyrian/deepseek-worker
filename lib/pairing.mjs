import { createHash } from "node:crypto";

const pairingRoutes = new Set(["start", "status", "disconnect"]);

export class PairingApiError extends Error {
  constructor(status, serverCode) {
    super(`Pairing API returned HTTP ${status}`);
    this.name = "PairingApiError";
    this.status = status;
    this.serverCode = serverCode || undefined;
  }
}

export function credentialValue(resolved) {
  if (typeof resolved === "string") return resolved;
  if (resolved && typeof resolved === "object" && typeof resolved.value === "string") return resolved.value;
  return "";
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
  endpoint.search = ""; endpoint.hash = "";
  return endpoint.toString().replace(/\/$/u, "");
}

async function responseCodeAndJson(response) {
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Pairing API response exceeded the size limit");
  let parsed = {};
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = {}; } }
  const candidates = [parsed?.code, parsed?.error_code, parsed?.error?.code, parsed?.error, parsed?.message];
  const code = candidates.find((value) => typeof value === "string" && value.length <= 160);
  return { code, parsed };
}

export async function pairingRequest(config, token, route, body = {}, signal) {
  if (!pairingRoutes.has(route)) throw new Error("Unknown Pairing API route");
  const base = cloudBaseFromWorkerEndpoint(config.endpoint);
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/api/pair/${route}`, { method: "POST", redirect: "error", signal, headers, body: JSON.stringify({ worker_id: config.workerId, ...body }) });
  const result = await responseCodeAndJson(response);
  if (!response.ok) throw new PairingApiError(response.status, result.code);
  return result.parsed;
}

export function classifyPairingError(error) {
  const status = Number(error?.status || 0);
  const code = typeof error?.serverCode === "string" ? error.serverCode : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  if (status === 404) return { code: "pairing_api_unavailable", message: "Cloud 尚未部署 0.3.0 配对 API。" };
  if (status === 409) return { code: "pairing_conflict", message: "该 Worker 已存在未完成或冲突的配对，请稍后重试或先断开旧配对。" };
  if (status === 410) return { code: "pairing_expired", message: "配对码已过期，请重新点击连接。" };
  if (status === 429) return { code: "pairing_rate_limited", message: "配对请求过于频繁，请稍后再试。" };
  if (status === 401) return { code: "pairing_credential_rejected", message: "本机配对凭据无效，请重新连接。" };
  if (status === 403) return { code: "pairing_denied", message: "配对未获授权或已被拒绝。" };
  if (/fetch failed|network|enotfound|econnrefused|econnreset|etimedout|timeout|aborted/.test(message)) return { code: "pairing_network", message: "无法访问 DeepSeek Worker Cloud 配对服务。" };
  if (status > 0) return { code: code || "pairing_http", message: `配对服务返回 HTTP ${status}。` };
  return { code: "pairing_unknown", message: "配对失败，请查看 Harness 日志中的脱敏错误。" };
}
