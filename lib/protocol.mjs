import { DEFAULT_ENDPOINT, DEFAULT_WORKER_ID, normalizeAuthorizedWorkspaceIds } from "./connector-config.mjs";

const routes = new Set(["register", "heartbeat", "claim", "lease/renew", "events", "result", "failure"]);
const prohibitedTaskPathFields = ["cwd", "path", "workspace_path", "local_path"];

export class WorkerApiError extends Error {
  constructor(status, serverCode) {
    super(`Worker API returned HTTP ${status}`);
    this.name = "WorkerApiError";
    this.status = status;
    this.serverCode = serverCode || undefined;
  }
}

export function normalizeConfig(input = {}) {
  const endpoint = new URL(input.endpoint || DEFAULT_ENDPOINT);
  if (endpoint.protocol !== "https:") throw new Error("Worker endpoint must use HTTPS");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    workerId: typeof input.workerId === "string" && input.workerId.trim() ? input.workerId.trim() : DEFAULT_WORKER_ID,
    pollIntervalMs: bounded(input.pollIntervalMs, 4000, 1000, 60000),
    heartbeatIntervalMs: bounded(input.heartbeatIntervalMs, 20000, 5000, 300000),
    leaseRenewIntervalMs: bounded(input.leaseRenewIntervalMs, 20000, 5000, 55000),
    leaseWaitTimeoutMs: bounded(input.leaseWaitTimeoutMs, 1800000, 10000, 86400000),
    authorizedWorkspaceIds: normalizeAuthorizedWorkspaceIds(input.authorizedWorkspaceIds),
    trustedWorkspaceMode: input.trustedWorkspaceMode !== false,
    enableHeadlessFallback: input.enableHeadlessFallback !== false,
    autoUpdate: input.autoUpdate !== false,
    updateChannel: input.updateChannel === "preview" ? "preview" : "stable",
    headlessCommand: input.headlessCommand || "dsh",
    headlessArgs: Array.isArray(input.headlessArgs) && input.headlessArgs.every((value) => typeof value === "string")
      ? input.headlessArgs : ["--profile", "headless", "--json"],
  };
}

function bounded(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Configuration interval must be ${min}–${max} milliseconds`);
  }
  return number;
}

export function workspaceForTask(config, task) {
  for (const field of prohibitedTaskPathFields) {
    if (Object.hasOwn(task ?? {}, field)) throw new Error(`Cloud task cannot specify local path field "${field}"`);
  }
  const workspaceId = typeof task?.workspace_id === "string" ? task.workspace_id.trim() : "";
  if (!workspaceId || !config.authorizedWorkspaceIds.includes(workspaceId)) {
    throw new Error("Task workspace_id is not authorized for this Harness worker");
  }
  return { workspaceId };
}

export function buildTaskPrompt(task) {
  return [task.context?.trim() && `Saved task context:\n${task.context.trim()}`, `Task:\n${task.prompt}`]
    .filter(Boolean).join("\n\n");
}

export function extractAssistantText(data) {
  if (!data || typeof data !== "object") return "";
  const pieces = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value === "string") { if (["text", "content", "answer"].includes(key)) pieces.push(value); return; }
    if (!value || typeof value !== "object") return;
    if (value.type === "text" && typeof value.text === "string") { pieces.push(value.text); return; }
    for (const [childKey, child] of Object.entries(value)) {
      if (["content", "message", "blocks", "text", "answer"].includes(childKey)) visit(child, childKey);
    }
  };
  visit(data);
  return pieces.join("").trim();
}

async function responseServerCode(response) {
  try {
    const text = await response.text();
    if (!text || text.length > 16_384) return undefined;
    const parsed = JSON.parse(text);
    for (const candidate of [parsed?.code, parsed?.error_code, parsed?.error?.code, parsed?.error, parsed?.message]) {
      if (typeof candidate === "string" && candidate.length <= 160) return candidate;
    }
  } catch {}
  return undefined;
}

export async function workerRequest(config, token, route, body, signal) {
  if (!routes.has(route)) throw new Error("Unknown Worker API route");
  const response = await fetch(`${config.endpoint}/${route}`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ worker_id: config.workerId, ...body }),
  });
  if (!response.ok) throw new WorkerApiError(response.status, await responseServerCode(response));
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 1_500_000) throw new Error("Worker API response exceeded the configured size limit");
  return response.json();
}
