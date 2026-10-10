import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Durable local task-completion notifications for the DeepSeek Worker Connector.
 *
 * Scope: one JSON file per machine under the Connector state directory. The
 * store is independent of the Site, of the Chat Bridge, and of the ChatGPT
 * binding: it is written by the Connector itself immediately after Cloud
 * confirms a terminal upload, so the user can read task outcomes locally even
 * when no project lease, no wake transport, and no [DSW] path exists.
 *
 * The file must never contain prompts, workspace paths, conversation URLs,
 * tokens, cookies, or API keys. Every free-text field passes through the
 * preview sanitizer below and is length-bounded.
 */

export const FORMAT_VERSION = 1;
export const TERMINAL_STATES = Object.freeze(["completed", "failed"]);
export const DEFAULT_MAX_RECORDS = 200;
export const MIN_MAX_RECORDS = 100;
export const MAX_MAX_RECORDS = 200;
export const SUMMARY_LIMIT = 500;
export const ERROR_LIMIT = 500;
export const ID_LIMIT = 160;
export const NOTIFICATION_KEY_LIMIT = 300;
export const NOTIFICATION_KEY_PATTERN = /^ntf-[0-9a-f]{32}$/u;
const PENDING_LIMIT = 200;
const PREVIEW_MIN_LINE = 8;

function envPath(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function taskNotificationRootDir() {
  if (process.platform === "win32") {
    return join(envPath("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "DeepSeekWorker");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "DeepSeekWorker");
  }
  return join(envPath("XDG_STATE_HOME") || join(homedir(), ".local", "state"), "deepseek-worker");
}

export function taskNotificationsPath() {
  return envPath("DEEPSEEK_WORKER_TASK_NOTIFICATIONS_PATH")
    || join(taskNotificationRootDir(), "task-notifications.json");
}

export function boundedMaxRecords(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_MAX_RECORDS;
  return Math.min(MAX_MAX_RECORDS, Math.max(MIN_MAX_RECORDS, number));
}

function collapseWhitespace(text) {
  let out = "";
  let pendingSpace = false;
  for (const character of text) {
    if (character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f" || character === "\v") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += character;
  }
  return out;
}

function replaceLongOpaqueRuns(text) {
  const runs = [
    /\b[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\b/gu,
    /\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){1,2}\b/gu,
    /\b(?:sk|pk|ghp|gho|ghs|ghr|xox[baprs])-[A-Za-z0-9_-]{12,}\b/gu,
    /\b[A-Za-z0-9+/]{64,}={0,2}\b/gu,
    /\b[0-9a-fA-F]{48,}\b/gu,
  ];
  let out = text;
  for (const pattern of runs) out = out.replace(pattern, "[secret]");
  return out;
}

export function redactSecrets(text) {
  const source = text instanceof Error
    ? `${text.message}`
    : typeof text === "string" ? text : String(text ?? "");
  let out = source
    .replace(/Bearer\s+[^\s"',;)]+/giu, "Bearer [redacted]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|token|cookie|set-cookie|authorization|password|passwd|secret|session[_-]?id|credential)s?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/giu, "$1[redacted]")
    .replace(/("(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|token|cookie|authorization|password|secret|credential)"\s*:\s*)("[^"]*"|[^,}]+)/giu, "$1\"[redacted]\"");
  out = replaceLongOpaqueRuns(out);
  return out;
}

export function sanitizePreview(text, limit = SUMMARY_LIMIT) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : SUMMARY_LIMIT;
  const lines = splitSanitizedLines(text);
  if (lines.length === 0) return "";
  const joined = lines.join(" ");
  if (joined.length <= cap) return joined;
  return `${joined.slice(0, cap - 1)}…`;
}

/**
 * Sanitize text into single-line, whitespace-collapsed, secret-free lines.
 * Whitespace is collapsed before secret matching so a line-wrapped token is
 * still recognized, and each line is bounded.
 */
function splitSanitizedLines(text) {
  const source = text instanceof Error
    ? `${text.message}`
    : typeof text === "string" ? text : String(text ?? "");
  const lines = [];
  for (const raw of source.split(/[\r\n\u2028\u2029]+/u)) {
    const collapsed = collapseWhitespace(raw).trim();
    if (!collapsed) continue;
    lines.push(sanitizeLine(collapsed));
  }
  return lines;
}

function sanitizeLine(line) {
  let out = redactSecrets(line);
  out = out
    .replace(/https?:\/\/[^\s"'<>)\]]+/giu, "[url]")
    .replace(/\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s"'<>)\]]+/giu, "[url]")
    .replace(/[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]*/gu, "[path]")
    .replace(/(?<![\w.-])\/(?:Users|home|root|tmp|var|etc|private|mnt|opt)(?:\/[^\s"'<>)\]]*)+/gu, "[path]")
    .replace(/\\\\[^\s"'<>)\]]+/gu, "[path]");
  return out.length <= SUMMARY_LIMIT ? out : `${out.slice(0, SUMMARY_LIMIT - 1)}…`;
}

export function summarizeResult(result, limit = SUMMARY_LIMIT) {
  if (result === null || result === undefined) return "";
  const text = typeof result === "string"
    ? result
    : (() => {
      try { return JSON.stringify(result); } catch { return ""; }
    })();
  if (typeof text !== "string" || !text.trim()) return "";
  const lines = splitSanitizedLines(text);
  const candidate = lines.find((line) => line.length >= PREVIEW_MIN_LINE) ?? lines[0] ?? "";
  if (!candidate) return "";
  return sanitizePreview(candidate, limit);
}

export function summarizeError(error, limit = ERROR_LIMIT) {
  if (error === null || error === undefined) return "";
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : (() => {
      try { return String(error?.message ?? error); } catch { return ""; }
    })();
  if (typeof message !== "string" || !message.trim()) return "";
  const firstLine = splitSanitizedLines(message)[0] ?? "";
  return sanitizePreview(firstLine, limit);
}

function safeTaskId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("task notification requires a task id");
  return sanitizePreview(text, ID_LIMIT) || "unknown-task";
}

/**
 * One stable identity per task and terminal state, so a replayed terminal
 * upload (Connector restart, Cloud retry, duplicate lease) can never produce a
 * second row or resurrect a notification the user already dismissed.
 */
export function taskNotificationKey(taskId, terminalState) {
  const task = safeTaskId(taskId);
  if (!TERMINAL_STATES.includes(terminalState)) throw new Error("terminal_state must be completed or failed");
  const digest = createHash("sha256").update(JSON.stringify([task, terminalState])).digest("hex").slice(0, 32);
  return `ntf-${digest}`;
}

export function isValidNotificationKey(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= NOTIFICATION_KEY_LIMIT
    && NOTIFICATION_KEY_PATTERN.test(value);
}

function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (!isValidNotificationKey(row.key)) return null;
  if (!TERMINAL_STATES.includes(row.terminalState)) return null;
  if (typeof row.taskId !== "string" || !row.taskId.trim()) return null;
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) return null;
  return {
    key: row.key,
    taskId: sanitizePreview(row.taskId, ID_LIMIT),
    terminalState: row.terminalState,
    at: new Date(Date.parse(row.at)).toISOString(),
    read: row.read === true,
    summary: typeof row.summary === "string" ? sanitizePreview(row.summary, SUMMARY_LIMIT) : "",
    error: typeof row.error === "string" ? sanitizePreview(row.error, ERROR_LIMIT) : "",
  };
}

function validDb(value) {
  if (!value || typeof value !== "object" || value.version !== FORMAT_VERSION || !Array.isArray(value.items)) {
    throw new Error("task notifications file has an unsupported or invalid format");
  }
  const items = [];
  const seen = new Set();
  for (const row of value.items) {
    const normalized = normalizeRow(row);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    items.push(normalized);
  }
  return { version: FORMAT_VERSION, items };
}

function emptyDb() {
  return { version: FORMAT_VERSION, items: [] };
}

async function syncDirectory(path) {
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {}
}

export class TaskNotificationStore {
  constructor({
    filePath = taskNotificationsPath(),
    now = () => new Date().toISOString(),
    platform = process.platform,
    maxRecords = DEFAULT_MAX_RECORDS,
    logger = null,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.platform = platform;
    this.maxRecords = boundedMaxRecords(maxRecords);
    this.logger = logger;
    this.writeTail = Promise.resolve();
    this.initialized = false;
    this.degraded = false;
    this.quarantined = false;
    this.pendingRecovery = [];
  }

  get degradedReason() {
    if (this.degraded) return "task_notification_store_write_failed";
    if (this.quarantined) return "task_notification_store_quarantined";
    return null;
  }

  /** Durable records still missing from disk after a failed write. */
  get pendingRecoveryCount() {
    return this.pendingRecovery.length;
  }

  async initialize() {
    if (!this.initialized) this.initialized = true;
    await this.#settle();
  }

  /**
   * Record one confirmed terminal. Returns the durable row plus whether this
   * call created it. A duplicate key never rewrites the row: the original
   * timestamp and read flag survive replays.
   */
  async recordTerminal({ taskId, terminalState, summary = "", error = "", at = null }) {
    const key = taskNotificationKey(taskId, terminalState);
    const task = sanitizePreview(typeof taskId === "string" ? taskId.trim() : String(taskId ?? ""), ID_LIMIT) || "unknown-task";
    const safeSummary = typeof summary === "string" ? sanitizePreview(summary, SUMMARY_LIMIT) : "";
    const safeError = typeof error === "string" ? sanitizePreview(error, ERROR_LIMIT) : "";
    const timestamp = Number.isFinite(Date.parse(at ?? "")) ? new Date(Date.parse(at)).toISOString() : this.now();
    const row = { key, taskId: task, terminalState, at: timestamp, read: false, summary: safeSummary, error: safeError };
    const result = await this.#mutate((db) => {
      const existing = db.items.find((item) => item.key === key);
      if (existing) return { result: { row: structuredClone(existing), created: false }, db };
      db.items.push(row);
      return { result: { row: structuredClone(row), created: true }, db };
    });
    return result;
  }

  /** Most recent first. Reads wait for queued writes so parallel completions are visible. */
  async list({ limit = this.maxRecords } = {}) {
    await this.initialize();
    const db = await this.#read();
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_MAX_RECORDS) : this.maxRecords;
    return [...db.items]
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .slice(0, cap)
      .map((row) => structuredClone(row));
  }

  async counts() {
    const items = await this.list({ limit: this.maxRecords });
    return { total: items.length, unreadCount: items.filter((row) => row.read !== true).length };
  }

  /**
   * Mark the given keys read, or every record when `keys` is omitted. Unknown,
   * malformed, and non-string keys are ignored instead of failing the call.
   */
  async markRead({ keys } = {}) {
    const selected = keys === undefined || keys === null
      ? null
      : (Array.isArray(keys) ? keys : [keys]).filter((key) => isValidNotificationKey(key));
    return this.#mutate((db) => {
      let changed = 0;
      for (const row of db.items) {
        if (row.read === true) continue;
        if (selected !== null && !selected.includes(row.key)) continue;
        row.read = true;
        changed += 1;
      }
      return { result: { changed, unreadCount: db.items.filter((row) => row.read !== true).length }, db };
    });
  }

  #bufferRecovery(db) {
    for (const row of db.items) {
      if (this.pendingRecovery.some((item) => item.key === row.key)) continue;
      this.pendingRecovery.push(structuredClone(row));
    }
    while (this.pendingRecovery.length > PENDING_LIMIT) this.pendingRecovery.shift();
  }

  #settle() {
    const tail = this.writeTail.catch(() => {});
    return tail;
  }

  #mutate(operation) {
    const result = this.writeTail.then(async () => {
      const db = await this.#read();
      if (this.pendingRecovery.length > 0) {
        for (const row of this.pendingRecovery) {
          if (!db.items.some((item) => item.key === row.key)) db.items.push(row);
        }
      }
      const outcome = operation(db);
      const value = outcome && typeof outcome === "object" && Object.hasOwn(outcome, "result") ? outcome.result : outcome;
      const next = outcome && typeof outcome === "object" && Object.hasOwn(outcome, "db") ? outcome.db : db;
      if (this.degraded && this.pendingRecovery.length > 0) this.#bufferRecovery(next);
      try {
        await this.#write(next);
        this.pendingRecovery = [];
        this.degraded = false;
      } catch (writeError) {
        this.degraded = true;
        this.#warn("task notification store could not persist %s: %s", next.items.length, summarizeError(writeError, ERROR_LIMIT));
        this.#bufferRecovery(next);
      }
      return value;
    });
    this.writeTail = result.catch(() => {});
    return result;
  }

  async #read() {
    try {
      return validDb(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          return validDb(JSON.parse(await readFile(`${this.filePath}.bak`, "utf8")));
        } catch (backupError) {
          if (backupError?.code === "ENOENT") return emptyDb();
          this.#warn("task notification backup unreadable: %s", summarizeError(backupError, ERROR_LIMIT));
          return emptyDb();
        }
      }
      await this.#quarantine(error);
      return emptyDb();
    }
  }

  async #quarantine(error) {
    const target = `${this.filePath}.corrupt-${Date.now()}`;
    this.quarantined = true;
    try {
      await rename(this.filePath, target);
      this.#warn("task notification store quarantined to %s: %s", target, summarizeError(error, ERROR_LIMIT));
    } catch (renameError) {
      this.#warn("task notification store unreadable and could not be quarantined: %s", summarizeError(renameError, ERROR_LIMIT));
    }
  }

  async #write(db) {
    if (db.items.length > this.maxRecords) {
      db.items = [...db.items]
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
        .slice(0, this.maxRecords)
        .reverse();
    }
    await this.writeDatabaseFile(`${JSON.stringify(db)}\n`);
  }

  /**
   * The only file-writing step, isolated so durability behavior (degraded
   * mode, bounded in-memory recovery) is testable without weakening the
   * atomic-write contract itself.
   */
  async writeDatabaseFile(contents) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.platform === "win32") {
      const backup = `${this.filePath}.bak`;
      await rm(backup, { force: true });
      try {
        await rename(this.filePath, backup);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await syncDirectory(this.filePath);
      await rm(this.filePath, { force: true });
      await rename(temporary, this.filePath);
      await syncDirectory(this.filePath);
      await rm(backup, { force: true });
      await syncDirectory(this.filePath);
    } else {
      await rename(temporary, this.filePath);
    }
    await syncDirectory(this.filePath);
  }

  #warn(...args) {
    try {
      this.logger?.warn?.(...args);
    } catch {}
  }
}
