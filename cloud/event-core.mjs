import { createHash } from "node:crypto";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export const EVENT_CATALOG = Object.freeze([
  Object.freeze({
    name: "task.completed",
    description: "A DeepSeek Worker task in the selected project completed and its full result is ready to read.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", minLength: 1 },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        status: { const: "completed" },
        summary: { type: "string" },
        result_available: { type: "boolean" },
        project_revision: { type: "integer", minimum: 1 },
      },
      required: ["project_id", "task_id", "status", "summary", "result_available", "project_revision"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "task.failed",
    description: "A DeepSeek Worker task in the selected project failed and may need a retry or a new debugging task.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", minLength: 1 },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        status: { const: "failed" },
        summary: { type: "string" },
        result_available: { type: "boolean" },
        project_revision: { type: "integer", minimum: 1 },
      },
      required: ["project_id", "task_id", "status", "summary", "result_available", "project_revision"],
      additionalProperties: false,
    },
  }),
]);

const EVENT_NAMES = new Set(EVENT_CATALOG.map((event) => event.name));
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function safeSummary(value) {
  if (typeof value !== "string") return "";
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > 600 ? `${oneLine.slice(0, 597)}...` : oneLine;
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function validateWebhookSecret(secret) {
  const raw = requiredString(secret, "delivery.secret");
  if (!raw.startsWith("whsec_")) throw new Error("delivery.secret must start with whsec_");
  let decoded;
  try {
    decoded = Buffer.from(raw.slice("whsec_".length), "base64");
  } catch {
    throw new Error("delivery.secret must contain valid base64");
  }
  if (decoded.byteLength < 24 || decoded.byteLength > 64) {
    throw new Error("delivery.secret must decode to 24-64 bytes");
  }
  return raw;
}

function isBlockedLiteralHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "localhost.localdomain"].includes(host)) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

export function validateCallbackUrl(value) {
  const input = requiredString(value, "delivery.url");
  let url;
  try { url = new URL(input); } catch { throw new Error("delivery.url must be a valid URL"); }
  if (url.protocol !== "https:") throw new Error("delivery.url must use HTTPS");
  if (url.username || url.password) throw new Error("delivery.url must not contain credentials");
  if (url.hash) throw new Error("delivery.url must not contain a fragment");
  if (isBlockedLiteralHost(url.hostname)) throw new Error("delivery.url must not target a local or private address");
  return url.href;
}

export function deriveSubscriptionId({ principal, callbackUrl, name, arguments: args }) {
  const owner = requiredString(principal, "principal");
  const eventName = requiredString(name, "name");
  if (!EVENT_NAMES.has(eventName)) throw new Error(`Unsupported event "${eventName}"`);
  const normalizedUrl = validateCallbackUrl(callbackUrl);
  const normalizedArgs = normalizeSubscriptionArguments(eventName, args);
  const identity = canonicalJson({
    principal: owner,
    callback_url: normalizedUrl,
    name: eventName,
    arguments: normalizedArgs,
  });
  return `sub_${sha256Base64Url(identity).slice(0, 32)}`;
}

export function normalizeSubscriptionArguments(name, args) {
  if (!EVENT_NAMES.has(name)) throw new Error(`Unsupported event "${name}"`);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be an object");
  }
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== "project_id") {
    throw new Error("arguments must contain only project_id");
  }
  return { project_id: requiredString(args.project_id, "arguments.project_id") };
}

export function computeRetryDelayMs(attemptNumber, {
  baseMs = 1_000,
  maxMs = 5 * 60_000,
} = {}) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error("attemptNumber must be >= 1");
  return Math.min(maxMs, baseMs * (2 ** (attemptNumber - 1)));
}

export function deliveryDisposition(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return "ack";
  if (code === 410 || code === 413) return "terminal";
  return "retry";
}

export class InMemoryEventCore {
  constructor() {
    this.projects = new Map();
    this.tasks = new Map();
    this.events = new Map();
    this.subscriptions = new Map();
    this.deliveries = new Map();
    this.leases = new Map();
  }

  createProject({ projectId, owner, goal = "", acceptanceCriteria = [], now = new Date() }) {
    const id = requiredString(projectId, "projectId");
    const principal = requiredString(owner, "owner");
    if (this.projects.has(id)) throw new Error(`Project "${id}" already exists`);
    const project = {
      project_id: id,
      owner: principal,
      goal: String(goal ?? ""),
      acceptance_criteria: Array.isArray(acceptanceCriteria) ? [...acceptanceCriteria] : [],
      revision: 1,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    this.projects.set(id, project);
    return structuredClone(project);
  }

  getProject(projectId, owner) {
    const project = this.projects.get(requiredString(projectId, "projectId"));
    if (!project) return null;
    if (owner !== undefined && project.owner !== owner) return null;
    return structuredClone(project);
  }

  attachTask({ projectId, taskId, owner, role = "", status = "queued", now = new Date() }) {
    const project = this.#requireOwnedProject(projectId, owner);
    const id = requiredString(taskId, "taskId");
    const key = this.#taskKey(project.project_id, id);
    const existing = this.tasks.get(key);
    if (existing) return structuredClone(existing);
    const task = {
      project_id: project.project_id,
      task_id: id,
      role: String(role ?? ""),
      status,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    this.tasks.set(key, task);
    project.revision += 1;
    project.updated_at = task.updated_at;
    return structuredClone(task);
  }

  markTaskTerminal({
    projectId,
    taskId,
    owner,
    status,
    summary = "",
    resultAvailable = false,
    occurredAt = new Date(),
  }) {
    if (!TERMINAL_STATUSES.has(status)) throw new Error("status must be completed or failed");
    const project = this.#requireOwnedProject(projectId, owner);
    const id = requiredString(taskId, "taskId");
    const taskKey = this.#taskKey(project.project_id, id);
    let task = this.tasks.get(taskKey);
    if (!task) {
      task = {
        project_id: project.project_id,
        task_id: id,
        role: "",
        status: "queued",
        created_at: new Date(occurredAt).toISOString(),
        updated_at: new Date(occurredAt).toISOString(),
      };
      this.tasks.set(taskKey, task);
    }

    const eventKey = `${project.project_id}:${id}:${status}`;
    const duplicate = [...this.events.values()].find((event) => event.dedupe_key === eventKey);
    if (duplicate) return { event: structuredClone(duplicate), duplicate: true };

    task.status = status;
    task.updated_at = new Date(occurredAt).toISOString();
    project.revision += 1;
    project.updated_at = task.updated_at;

    const eventId = `evt_${sha256Base64Url(eventKey).slice(0, 32)}`;
    const name = status === "completed" ? "task.completed" : "task.failed";
    const event = {
      eventId,
      dedupe_key: eventKey,
      name,
      timestamp: new Date(occurredAt).toISOString(),
      data: {
        project_id: project.project_id,
        task_id: id,
        status,
        summary: safeSummary(summary),
        result_available: Boolean(resultAvailable),
        project_revision: project.revision,
      },
      cursor: null,
      acknowledged: false,
    };
    this.events.set(eventId, event);
    this.#materializeDeliveries(event, project.owner, occurredAt);
    return { event: structuredClone(event), duplicate: false };
  }

  listProjectTasks({ projectId, owner }) {
    const project = this.#requireOwnedProject(projectId, owner);
    return [...this.tasks.values()]
      .filter((task) => task.project_id === project.project_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((task) => structuredClone(task));
  }

  listPendingEvents({ projectId, owner }) {
    const project = this.#requireOwnedProject(projectId, owner);
    return [...this.events.values()]
      .filter((event) => event.data.project_id === project.project_id && !event.acknowledged)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((event) => structuredClone(event));
  }

  acknowledgeEvent({ eventId, owner }) {
    const event = this.events.get(requiredString(eventId, "eventId"));
    if (!event) return false;
    this.#requireOwnedProject(event.data.project_id, owner);
    event.acknowledged = true;
    return true;
  }

  subscribe({
    principal,
    name,
    arguments: args,
    delivery,
    ttlMs = 24 * 60 * 60_000,
    now = new Date(),
  }) {
    const owner = requiredString(principal, "principal");
    if (!delivery || delivery.mode !== "webhook") throw new Error("Only webhook delivery is supported");
    const callbackUrl = validateCallbackUrl(delivery.url);
    const secret = validateWebhookSecret(delivery.secret);
    const normalizedArgs = normalizeSubscriptionArguments(name, args);
    const project = this.#requireOwnedProject(normalizedArgs.project_id, owner);
    const id = deriveSubscriptionId({
      principal: owner,
      callbackUrl,
      name,
      arguments: normalizedArgs,
    });
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs < 60_000)) {
      throw new Error("ttlMs must be null or at least 60000");
    }
    const expires = ttlMs === null ? null : new Date(new Date(now).getTime() + ttlMs).toISOString();
    const subscription = {
      id,
      principal: owner,
      name,
      arguments: normalizedArgs,
      callback_url: callbackUrl,
      secret,
      project_id: project.project_id,
      active: true,
      refreshBefore: expires,
      created_at: this.subscriptions.get(id)?.created_at || new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    this.subscriptions.set(id, subscription);
    return {
      id,
      refreshBefore: expires,
      cursor: null,
      truncated: false,
    };
  }

  unsubscribe({ principal, name, arguments: args, delivery }) {
    const owner = requiredString(principal, "principal");
    const callbackUrl = validateCallbackUrl(delivery?.url);
    const normalizedArgs = normalizeSubscriptionArguments(name, args);
    const id = deriveSubscriptionId({
      principal: owner,
      callbackUrl,
      name,
      arguments: normalizedArgs,
    });
    const existing = this.subscriptions.get(id);
    if (existing && existing.principal === owner) existing.active = false;
    return {};
  }

  acquireProjectLease({
    projectId,
    owner,
    holder,
    ttlMs = 60_000,
    now = new Date(),
  }) {
    const project = this.#requireOwnedProject(projectId, owner);
    const leaseHolder = requiredString(holder, "holder");
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new Error("ttlMs must be >= 1000");
    const current = this.leases.get(project.project_id);
    if (current && current.expires_at_ms > nowMs && current.holder !== leaseHolder) {
      return { acquired: false, holder: current.holder, expiresAt: new Date(current.expires_at_ms).toISOString() };
    }
    const expiresAtMs = nowMs + ttlMs;
    this.leases.set(project.project_id, {
      holder: leaseHolder,
      expires_at_ms: expiresAtMs,
    });
    return { acquired: true, holder: leaseHolder, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  releaseProjectLease({ projectId, owner, holder }) {
    const project = this.#requireOwnedProject(projectId, owner);
    const current = this.leases.get(project.project_id);
    if (!current || current.holder !== holder) return false;
    this.leases.delete(project.project_id);
    return true;
  }

  dueDeliveries(now = new Date()) {
    const nowMs = new Date(now).getTime();
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.state === "pending" && delivery.next_attempt_at_ms <= nowMs)
      .sort((a, b) => a.next_attempt_at_ms - b.next_attempt_at_ms)
      .map((delivery) => structuredClone(delivery));
  }

  recordDeliveryResult({
    eventId,
    subscriptionId,
    httpStatus,
    now = new Date(),
    maxAttempts = 6,
  }) {
    const key = `${eventId}:${subscriptionId}`;
    const delivery = this.deliveries.get(key);
    if (!delivery) throw new Error("Unknown event delivery");
    const disposition = deliveryDisposition(httpStatus);
    const nowMs = new Date(now).getTime();
    delivery.attempts += 1;
    delivery.last_status = Number(httpStatus);

    if (disposition === "ack") {
      delivery.state = "delivered";
      delivery.delivered_at = new Date(now).toISOString();
      return structuredClone(delivery);
    }
    if (disposition === "terminal" || delivery.attempts >= maxAttempts) {
      delivery.state = "dead";
      delivery.dead_at = new Date(now).toISOString();
      return structuredClone(delivery);
    }

    delivery.next_attempt_at_ms = nowMs + computeRetryDelayMs(delivery.attempts);
    return structuredClone(delivery);
  }

  #materializeDeliveries(event, owner, now) {
    const nowMs = new Date(now).getTime();
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || subscription.principal !== owner || subscription.name !== event.name) continue;
      if (subscription.project_id !== event.data.project_id) continue;
      if (subscription.refreshBefore && new Date(subscription.refreshBefore).getTime() <= nowMs) continue;
      const key = `${event.eventId}:${subscription.id}`;
      if (this.deliveries.has(key)) continue;
      this.deliveries.set(key, {
        event_id: event.eventId,
        subscription_id: subscription.id,
        callback_url: subscription.callback_url,
        state: "pending",
        attempts: 0,
        last_status: null,
        next_attempt_at_ms: nowMs,
      });
    }
  }

  #requireOwnedProject(projectId, owner) {
    const id = requiredString(projectId, "projectId");
    const principal = requiredString(owner, "owner");
    const project = this.projects.get(id);
    if (!project || project.owner !== principal) throw new Error("Project not found");
    return project;
  }

  #taskKey(projectId, taskId) {
    return `${projectId}:${taskId}`;
  }
}
