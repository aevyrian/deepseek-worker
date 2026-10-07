import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { bridgeWakeOutboxPath } from "./bridge-paths.mjs";

const FORMAT_VERSION = 1;
const MAX_RECORDS = 2000;

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
      || !["pending", "sending", "delivered", "superseded"].includes(row.delivery_state)
      || !Number.isInteger(row.attempts) || row.attempts < 0 || typeof row.created_at !== "string") {
      throw new Error("Chat Bridge outbox contains an invalid delivery record");
    }
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
  constructor({ filePath = bridgeWakeOutboxPath(), now = () => new Date().toISOString(), platform = process.platform } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.platform = platform;
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
    await this.#mutate((db) => { for (const row of db.deliveries) if (row.delivery_state === "sending") row.delivery_state = "pending"; });
    this.initialized = true;
  }

  async enqueueLocal({ projectId, taskId, terminalState }) {
    await this.initialize();
    const project_id = requiredId(projectId, "project_id");
    const task_id = requiredId(taskId, "task_id");
    const message_key = localWakeMessageKey(project_id, task_id, terminalState);
    return this.#mutate((db) => {
      let row = db.deliveries.find((item) => item.message_key === message_key);
      if (!row) {
        row = { message_key, project_id, task_id, terminal_state: terminalState, created_at: this.now(), delivery_state: "pending", attempts: 0, last_error: null, delivered_at: null, source: "local" };
        db.deliveries.push(row);
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
      terminal_state: eventState(envelope.eventName), created_at: this.now(), delivery_state: "pending", attempts: 0,
      last_error: null, delivered_at: null, source: "cloud", delivery_id: requiredId(envelope.deliveryId, "delivery_id"),
      event_id: requiredId(envelope.eventId, "event_id"), event_name: envelope.eventName, project_revision: envelope.revision,
    };
    if (!row.terminal_state) throw new Error("Unsupported Cloud Bridge terminal event");
    return this.#mutate((db) => {
      const existing = db.deliveries.find((item) => item.message_key === row.message_key);
      if (existing) return { row: structuredClone(existing), alreadyDelivered: existing.delivery_state === "delivered" };
      const local = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, row) && item.delivery_state !== "superseded");
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
      row.delivery_state = "sending"; row.attempts += 1; row.last_error = null;
      return structuredClone(row);
    });
  }

  async markDelivered(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row) return null;
      row.delivery_state = "delivered"; row.delivered_at ||= this.now(); row.last_error = null;
      return structuredClone(row);
    });
  }

  async markFailed(key, error) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row) return null;
      if (row.delivery_state !== "superseded") row.delivery_state = "pending";
      row.last_error = sanitizeWakeError(error);
      return structuredClone(row);
    });
  }

  async listPending() {
    await this.initialize();
    const db = await this.#read();
    return db.deliveries.filter((row) => row.delivery_state === "pending").map((row) => structuredClone(row));
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
      const live = db.deliveries.filter((row) => ["pending", "sending"].includes(row.delivery_state));
      const settled = db.deliveries.filter((row) => !["pending", "sending"].includes(row.delivery_state)).slice(-(MAX_RECORDS - live.length));
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