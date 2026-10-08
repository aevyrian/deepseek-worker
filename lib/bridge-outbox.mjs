import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { bridgeWakeOutboxPath } from "./bridge-paths.mjs";
import { normalizeWakeTarget } from "./chat-bridge.mjs";

const FORMAT_VERSION = 1;
const MAX_RECORDS = 2000;
const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_RETRY_MAX_MS = 120000;

function retryDelayMs(attempts, baseMs, maxMs) {
  const exponent = Math.max(0, Math.min(20, attempts - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function requiredId(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new Error(`${field} must be a non-empty string up to 160 characters`);
  return value.trim();
}

export function localWakeMessageKey(projectId, taskId, terminalState) {
  const project = requiredId(projectId, "project_id");
  const task = requiredId(taskId, "task_id");
  if (!["completed", "failed"].includes(terminalState)) throw new Error("terminal_state must be completed or failed");
  const digest = createHash("sha256").update(JSON.stringify([project, task, terminalState])).digest("hex").slice(0, 32);
  return `dsw-wake-${digest}`;
}

export function buildLocalWakeMessage(delivery) {
  if (!["completed", "failed"].includes(delivery.terminal_state)) throw new Error("Unsupported local wake state");
  const text = [
    "[DSW]", "STATE: PROJECT_EVENT_PENDING",
    `PROJECT_ID: ${requiredId(delivery.project_id, "project_id")}`,
    `TASK_ID: ${requiredId(delivery.task_id, "task_id")}`,
    `MESSAGE_KEY: ${requiredId(delivery.message_key, "message_key")}`,
    "", "ACTION:", "Use DeepSeek Worker tools.", "Acquire the project lease.",
    "Read pending project events and the completed task result.", "Continue orchestration.",
    "Ack processed project events.", "Release the lease.", "Then end this turn.", "Do not poll task status.",
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > 900) throw new Error("Bridge wake message exceeded the size limit");
  return text;
}

function eventState(name) {
  return name === "task.completed" ? "completed" : name === "task.failed" ? "failed" : null;
}

function validDb(value) {
  if (!value || value.version !== FORMAT_VERSION || !Array.isArray(value.deliveries)) throw new Error("Chat Bridge outbox has an unsupported or invalid format");
  for (const row of value.deliveries) {
    if (!row || typeof row.message_key !== "string" || typeof row.project_id !== "string" || typeof row.task_id !== "string"
      || !["completed", "failed"].includes(row.terminal_state)
      || !["pending", "sending", "uncertain", "delivered", "superseded"].includes(row.delivery_state)
      || !Number.isInteger(row.attempts) || row.attempts < 0 || typeof row.created_at !== "string") {
      throw new Error("Chat Bridge outbox contains an invalid delivery record");
    }
    if (!Number.isInteger(row.recovery_attempts) || row.recovery_attempts < 0) row.recovery_attempts = 0;
    if (![null, "safe_draft", "uncertain"].includes(row.send_state)) row.send_state = null;
    if (typeof row.next_attempt_at !== "string") row.next_attempt_at = null;
    if (typeof row.last_failure !== "string") row.last_failure = null;
    if (typeof row.last_failure_at !== "string") row.last_failure_at = null;
    if (row.wake_target) row.wake_target = normalizeWakeTarget(row.wake_target);
    row.legacy_binding = row.legacy_binding === true;
  }
  return value;
}

function sameTerminal(a, b) {
  return a.project_id === b.project_id && a.task_id === b.task_id && a.terminal_state === b.terminal_state;
}

async function syncDirectory(path) {
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {}
}

export function sanitizeWakeError(error) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Chat Bridge delivery failed";
  return message
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/\b(token|cookie|authorization|password|secret)\s*[:=]\s*[^\s,;"']+/giu, "$1=[redacted]")
    .replace(/\b[A-Z]:\\[^\s"']+/giu, "[path]")
    .replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"']+/giu, "[path]")
    .slice(0, 500);
}

export class BridgeWakeOutbox {
  constructor({
    filePath = bridgeWakeOutboxPath(),
    now = () => new Date().toISOString(),
    platform = process.platform,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.platform = platform;
    this.retryBaseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = Number.isFinite(retryMaxMs) && retryMaxMs >= this.retryBaseMs ? retryMaxMs : DEFAULT_RETRY_MAX_MS;
    this.writeTail = Promise.resolve();
    this.deliveryTail = Promise.resolve();
    this.initialized = false;
  }

  withDeliveryLock(operation) {
    const result = this.deliveryTail.then(operation);
    this.deliveryTail = result.catch(() => {});
    return result;
  }

  async initialize() {
    if (this.initialized) return;
    await this.#mutate((db) => {
      for (const row of db.deliveries) {
        if (row.delivery_state === "sending") {
          row.delivery_state = "uncertain";
          row.send_state = "uncertain";
          row.last_error = "process_restarted_during_send";
        }
      }
    });
    this.initialized = true;
  }

  async enqueueLocal({ projectId, taskId, terminalState, wakeTarget = null, legacyBinding = false }) {
    await this.initialize();
    const project_id = requiredId(projectId, "project_id");
    const task_id = requiredId(taskId, "task_id");
    const wake_target = normalizeWakeTarget(wakeTarget);
    const legacy_binding = legacyBinding === true && !wake_target;
    const message_key = localWakeMessageKey(project_id, task_id, terminalState);
    return this.#mutate((db) => {
      let row = db.deliveries.find((item) => item.message_key === message_key);
      if (!row) {
        row = { message_key, project_id, task_id, terminal_state: terminalState, created_at: this.now(), delivery_state: "pending", attempts: 0, recovery_attempts: 0, send_state: null, last_error: null, last_failure: null, last_failure_at: null, next_attempt_at: null, delivered_at: null, source: "local", legacy_binding, ...(wake_target ? { wake_target } : {}) };
        db.deliveries.push(row);
      } else {
        row.legacy_binding ||= legacy_binding;
        if (wake_target) {
          if (row.wake_target && row.wake_target.url !== wake_target.url) throw new Error("bridge_wake_target_conflict: message key is already bound to another conversation");
          row.wake_target ||= wake_target;
        }
      }
      return structuredClone(row);
    });
  }

  async adoptCloudDelivery(envelope) {
    await this.initialize();
    const row = {
      message_key: requiredId(envelope.messageKey, "message_key"),
      project_id: requiredId(envelope.projectId, "project_id"),
      task_id: requiredId(envelope.taskId, "task_id"),
      terminal_state: eventState(envelope.eventName), created_at: this.now(), delivery_state: "pending", attempts: 0, recovery_attempts: 0, send_state: null,
      last_error: null, last_failure: null, last_failure_at: null, next_attempt_at: null, delivered_at: null, source: "cloud", delivery_id: requiredId(envelope.deliveryId, "delivery_id"),
      event_id: requiredId(envelope.eventId, "event_id"), event_name: envelope.eventName, project_revision: envelope.revision,
      legacy_binding: envelope.legacyBinding === true && !envelope.wakeTarget,
      ...(envelope.wakeTarget ? { wake_target: normalizeWakeTarget(envelope.wakeTarget) } : {}),
    };
    if (!row.terminal_state) throw new Error("Unsupported Cloud Bridge terminal event");
    return this.#mutate((db) => {
      const existing = db.deliveries.find((item) => item.message_key === row.message_key);
      if (existing) {
        if (existing.wake_target && row.wake_target && existing.wake_target.url !== row.wake_target.url) {
          throw new Error("bridge_wake_target_conflict: message key is already bound to another conversation");
        }
        existing.wake_target ||= row.wake_target;
        return { row: structuredClone(existing), alreadyDelivered: existing.delivery_state === "delivered" };
      }
      const local = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, row) && item.delivery_state !== "superseded");
      if (local?.wake_target && row.wake_target && local.wake_target.url !== row.wake_target.url) {
        throw new Error("bridge_wake_target_conflict: Cloud delivery target differs from its local fallback");
      }
      row.wake_target ||= local?.wake_target;
      row.legacy_binding ||= local?.legacy_binding === true;
      if (row.wake_target) row.legacy_binding = false;
      if (local?.delivery_state === "delivered") {
        row.delivery_state = "delivered";
        row.delivered_at = local.delivered_at;
        row.attempts = local.attempts;
      } else if (local) local.delivery_state = "superseded";
      db.deliveries.push(row);
      return { row: structuredClone(row), alreadyDelivered: row.delivery_state === "delivered" };
    });
  }

  async supersedeLocal({ projectId, taskId, terminalState }) {
    await this.initialize();
    const identity = { project_id: requiredId(projectId, "project_id"), task_id: requiredId(taskId, "task_id"), terminal_state: terminalState };
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, identity) && item.delivery_state !== "delivered");
      if (!row) return null;
      row.delivery_state = "superseded";
      return structuredClone(row);
    });
  }

  async beginAttempt(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "pending") return null;
      const retryAt = row.next_attempt_at ? Date.parse(row.next_attempt_at) : 0;
      const nowAt = Date.parse(this.now());
      if (Number.isFinite(retryAt) && retryAt > 0 && Number.isFinite(nowAt) && retryAt > nowAt) return null;
      if (row.source === "local") {
        const formal = db.deliveries.find((item) => item.source === "cloud" && sameTerminal(item, row) && item.delivery_state !== "superseded");
        if (formal) {
          row.delivery_state = "superseded";
          return null;
        }
      } else if (row.source === "cloud") {
        const local = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, row) && item.delivery_state === "delivered");
        if (local) {
          row.delivery_state = "delivered";
          row.delivered_at ||= local.delivered_at;
          row.attempts = local.attempts;
          row.last_error = null;
          return null;
        }
      }
      row.delivery_state = "sending"; row.attempts += 1; row.last_error = null; row.next_attempt_at = null;
      return structuredClone(row);
    });
  }

  async markDelivered(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row) return null;
      row.delivery_state = "delivered"; row.delivered_at ||= this.now(); row.last_error = null; row.next_attempt_at = null;
      row.send_state = null;
      return structuredClone(row);
    });
  }

  async markFailed(key, error) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row) return null;
      const code = typeof error?.code === "string" ? error.code : null;
      if (row.delivery_state !== "superseded") {
        if (code === "bridge_send_uncertain" || code === "bridge_send_not_submitted") {
          row.delivery_state = "uncertain";
          row.send_state = code === "bridge_send_not_submitted" ? "safe_draft" : "uncertain";
          row.next_attempt_at = null;
        } else {
          row.delivery_state = "pending";
          row.send_state = null;
          row.next_attempt_at = new Date(Date.parse(this.now()) + retryDelayMs(row.attempts, this.retryBaseMs, this.retryMaxMs)).toISOString();
        }
      }
      row.last_error = sanitizeWakeError(error);
      row.last_failure = row.last_error;
      row.last_failure_at = this.now();
      return structuredClone(row);
    });
  }

  async listUncertain() {
    await this.initialize();
    const db = await this.#read();
    return db.deliveries.filter((row) => row.delivery_state === "uncertain").map((row) => structuredClone(row));
  }

  async resolveUncertain(key, result) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "uncertain") return null;
      if (result === "delivered") {
        row.delivery_state = "delivered";
        row.delivered_at ||= this.now();
        row.last_error = null;
        row.send_state = null;
      } else if (result === "safe_draft" && row.recovery_attempts < 1) {
        row.delivery_state = "pending";
        row.recovery_attempts += 1;
        row.last_error = null;
        row.send_state = null;
        row.next_attempt_at = null;
      }
      return structuredClone(row);
    });
  }

  async listPending() {
    await this.initialize();
    const db = await this.#read();
    const nowAt = Date.parse(this.now());
    return db.deliveries.filter((row) => row.delivery_state === "pending" && (!row.next_attempt_at || !Number.isFinite(Date.parse(row.next_attempt_at)) || !Number.isFinite(nowAt) || Date.parse(row.next_attempt_at) <= nowAt)).map((row) => structuredClone(row));
  }

  async findByMessageKey(key) {
    await this.initialize();
    const db = await this.#read();
    const row = db.deliveries.find((item) => item.message_key === key);
    return row ? structuredClone(row) : null;
  }

  async #mutate(operation) {
    const result = this.writeTail.then(async () => {
      const db = await this.#read();
      const value = operation(db);
      const resultValue = value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : value;
      await this.#write(db);
      return resultValue;
    });
    this.writeTail = result.catch(() => {});
    return result;
  }

  async #read() {
    try { return validDb(JSON.parse(await readFile(this.filePath, "utf8"))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const backup = `${this.filePath}.bak`;
      try {
        const recovered = validDb(JSON.parse(await readFile(backup, "utf8")));
        await rename(backup, this.filePath);
        return recovered;
      } catch (backupError) {
        if (backupError?.code === "ENOENT") return { version: FORMAT_VERSION, deliveries: [] };
        throw backupError;
      }
    }
  }

  async #write(db) {
    if (db.deliveries.length > MAX_RECORDS) {
      const live = db.deliveries.filter((row) => ["pending", "sending", "uncertain"].includes(row.delivery_state));
      const settled = db.deliveries.filter((row) => !["pending", "sending", "uncertain"].includes(row.delivery_state)).slice(-(MAX_RECORDS - live.length));
      db.deliveries = [...settled, ...live];
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(db)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (this.platform === "win32") {
      const backup = `${this.filePath}.bak`;
      await rm(backup, { force: true });
      try { await rename(this.filePath, backup); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await syncDirectory(this.filePath);
      await rename(temporary, this.filePath);
      await syncDirectory(this.filePath);
      await rm(backup, { force: true });
      await syncDirectory(this.filePath);
    } else await rename(temporary, this.filePath);
    await syncDirectory(this.filePath);
  }
}
