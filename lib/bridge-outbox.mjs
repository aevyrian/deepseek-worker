import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { bridgeWakeOutboxPath } from "./bridge-paths.mjs";
import { normalizeWakeTarget } from "./chat-bridge.mjs";

const FORMAT_VERSION = 1;
// All instances targeting one file must serialize reads, writes and startup recovery.
const fileQueues = new Map();
const ownerTokenKey = Symbol.for('deepseek-worker.outbox.process-owner');
const processOwnerToken = globalThis[ownerTokenKey] ||= randomUUID();

function ownerAlive(pid, token) {
  if (pid === process.pid && token && token !== processOwnerToken) return false;
  return processAlive(pid);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_RETRY_MAX_MS = 120000;
const DEFAULT_RECONCILE_BASE_MS = 30000;
const DEFAULT_RECONCILE_MAX_MS = 1800000;
const DEFAULT_RECONCILE_LOCK_MS = 120000;
const DEFAULT_MANUAL_REVIEW_THRESHOLD = 8;
const DEFAULT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    if (!Number.isInteger(row.reconcile_attempts) || row.reconcile_attempts < 0) row.reconcile_attempts = 0;
    if (typeof row.next_reconcile_at !== "string") row.next_reconcile_at = null;
    if (typeof row.last_reconcile_at !== "string") row.last_reconcile_at = null;
    if (typeof row.last_reconcile_error !== "string") row.last_reconcile_error = null;
    if (typeof row.reconcile_lock_until !== "string") row.reconcile_lock_until = null;
    if (!row.reconcile_diagnostic || typeof row.reconcile_diagnostic !== "object" || Array.isArray(row.reconcile_diagnostic)) row.reconcile_diagnostic = null;
    row.reconcile_manual_intervention = row.reconcile_manual_intervention === true;
    row.message_visible = typeof row.message_visible === "boolean" ? row.message_visible : null;
    row.draft_verified = typeof row.draft_verified === "boolean" ? row.draft_verified : null;
    row.submit_attempted = typeof row.submit_attempted === "boolean" ? row.submit_attempted : null;
    if (!["queued", "draft_verified", "submit_attempted", "message_visible", "transport_acked"].includes(row.delivery_stage)) row.delivery_stage = null;
    row.delivery_manual_intervention = row.delivery_manual_intervention === true;
    row.cloud_ack_manual_intervention = row.cloud_ack_manual_intervention === true;
    row.transport_acked = typeof row.transport_acked === "boolean" ? row.transport_acked : null;
    // Only ack_project_event can prove orchestration consumption. The delivery
    // transport intentionally has no authority to set this to true.
    row.orchestrator_handled = null;
    if (row.source === "cloud") {
      if (!["pending", "sending", "acked"].includes(row.cloud_ack_state)) row.cloud_ack_state = "pending";
      if (!Number.isInteger(row.cloud_ack_attempts) || row.cloud_ack_attempts < 0) row.cloud_ack_attempts = 0;
      if (typeof row.cloud_ack_next_attempt_at !== "string") row.cloud_ack_next_attempt_at = null;
      if (typeof row.cloud_ack_last_error !== "string") row.cloud_ack_last_error = null;
    }
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
    .replace(/https?:\/\/[^\s"']+/giu, "[url]")
    .slice(0, 500);
}

export class BridgeWakeOutbox {
  constructor({
    filePath = bridgeWakeOutboxPath(),
    now = () => new Date().toISOString(),
    platform = process.platform,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    reconcileBaseMs = DEFAULT_RECONCILE_BASE_MS,
    reconcileMaxMs = DEFAULT_RECONCILE_MAX_MS,
    reconcileLockMs = DEFAULT_RECONCILE_LOCK_MS,
    manualReviewThreshold = DEFAULT_MANUAL_REVIEW_THRESHOLD,
    recoveryWindowMs = DEFAULT_RECOVERY_WINDOW_MS,
  } = {}) {
    this.filePath = resolve(filePath);
    const queueKey = process.platform === "win32" ? this.filePath.toLowerCase() : this.filePath;
    if (!fileQueues.has(queueKey)) fileQueues.set(queueKey, { writeTail: Promise.resolve(), deliveryTail: Promise.resolve(), submissionTail: Promise.resolve() });
    this.queue = fileQueues.get(queueKey);
    this.now = now;
    this.platform = platform;
    this.retryBaseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = Number.isFinite(retryMaxMs) && retryMaxMs >= this.retryBaseMs ? retryMaxMs : DEFAULT_RETRY_MAX_MS;
    this.reconcileBaseMs = Number.isFinite(reconcileBaseMs) && reconcileBaseMs >= 0 ? reconcileBaseMs : DEFAULT_RECONCILE_BASE_MS;
    this.reconcileMaxMs = Number.isFinite(reconcileMaxMs) && reconcileMaxMs >= this.reconcileBaseMs ? reconcileMaxMs : DEFAULT_RECONCILE_MAX_MS;
    this.reconcileLockMs = Number.isFinite(reconcileLockMs) && reconcileLockMs > 0 ? reconcileLockMs : DEFAULT_RECONCILE_LOCK_MS;
    this.manualReviewThreshold = Number.isInteger(manualReviewThreshold) && manualReviewThreshold > 0 ? manualReviewThreshold : DEFAULT_MANUAL_REVIEW_THRESHOLD;
    this.recoveryWindowMs = Number.isFinite(recoveryWindowMs) && recoveryWindowMs > 0 ? recoveryWindowMs : DEFAULT_RECOVERY_WINDOW_MS;
    this.initialized = false;
  }

  withDeliveryLock(operation) {
    const result = this.queue.deliveryTail.then(operation);
    this.queue.deliveryTail = result.catch(() => {});
    return result;
  }

  withSubmissionLock(operation) {
    // This lock is distinct from the short durable-mutation lock so progress
    // callbacks can commit while a browser submission owns the UI transaction.
    const result = this.queue.submissionTail.then(async () => {
      const unlock = await this.#lockFile(`${this.filePath}.submission.lock`);
      try { return await operation(); }
      finally { await unlock(); }
    });
    this.queue.submissionTail = result.catch(() => {});
    return result;
  }

  async initialize() {
    if (this.initialized) return;
    await this.#recoverInterrupted(true);
    this.initialized = true;
  }

  async #recoverInterrupted(forceWrite = false) {
    await this.#mutate((db) => {
      let changed = false;
      for (const row of db.deliveries) {
        if (row.delivery_state === "sending" && !ownerAlive(row.send_owner_pid, row.send_owner_token)) {
          row.delivery_state = "uncertain";
          row.send_state = row.delivery_stage === "draft_verified" && row.submit_attempted !== true ? "safe_draft" : "uncertain";
          row.last_error = "process_restarted_during_send";
          row.recovery_started_at ||= this.now();
          changed = true;
        }
        if (row.source === "cloud" && row.cloud_ack_state === "sending" && !ownerAlive(row.cloud_ack_owner_pid, row.cloud_ack_owner_token)) { row.cloud_ack_state = "pending"; changed = true; }
      }
      // An unrelated live process may have reused the recorded PID. Retain
      // the claimed state and stop after its lifetime; never reopen it blindly.
      const nowAt = Date.parse(this.now());
      for (const row of db.deliveries) {
        if (row.delivery_state === 'sending' && row.send_started_at && nowAt - Date.parse(row.send_started_at) >= this.recoveryWindowMs && !row.delivery_manual_intervention) {
          row.delivery_manual_intervention = true; row.last_error = 'send_owner_lifetime_exhausted'; changed = true;
        }
        if (row.cloud_ack_state === 'sending' && row.cloud_ack_started_at && nowAt - Date.parse(row.cloud_ack_started_at) >= this.recoveryWindowMs && !row.cloud_ack_manual_intervention) {
          row.cloud_ack_manual_intervention = true; row.cloud_ack_last_error = 'ack_owner_lifetime_exhausted'; changed = true;
        }
      }
      return { result: null, unchanged: !changed && !forceWrite };
    });
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
        row = { message_key, project_id, task_id, terminal_state: terminalState, created_at: this.now(), delivery_stage: "queued", delivery_state: "pending", attempts: 0, recovery_attempts: 0, send_state: null, last_error: null, last_failure: null, last_failure_at: null, next_attempt_at: null, delivered_at: null, source: "local", legacy_binding, ...(wake_target ? { wake_target } : {}) };
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
      terminal_state: eventState(envelope.eventName), created_at: this.now(), delivery_stage: "queued", delivery_state: "pending", attempts: 0, recovery_attempts: 0, send_state: null,
      last_error: null, last_failure: null, last_failure_at: null, next_attempt_at: null, delivered_at: null, source: "cloud", cloud_ack_state: "pending", cloud_ack_attempts: 0, cloud_ack_next_attempt_at: null, cloud_ack_last_error: null, delivery_id: requiredId(envelope.deliveryId, "delivery_id"),
      event_id: requiredId(envelope.eventId, "event_id"), event_name: envelope.eventName, project_revision: envelope.revision,
      legacy_binding: envelope.legacyBinding === true && !envelope.wakeTarget,
      ...(envelope.wakeTarget ? { wake_target: normalizeWakeTarget(envelope.wakeTarget) } : {}),
    };
    if (!row.terminal_state) throw new Error("Unsupported Cloud Bridge terminal event");
    return this.#mutate((db) => {
      const existing = db.deliveries.find((item) => item.message_key === row.message_key || item.cloud_message_key === row.message_key);
      if (existing) {
        if (!sameTerminal(existing, row) || (existing.source === "cloud" && (existing.delivery_id !== row.delivery_id || existing.event_id !== row.event_id))) {
          throw new Error("bridge_message_identity_conflict: message key is already bound to another event");
        }
        if (existing.wake_target && row.wake_target && existing.wake_target.url !== row.wake_target.url) {
          throw new Error("bridge_wake_target_conflict: message key is already bound to another conversation");
        }
        if (!existing.wake_target && row.wake_target && ["sending", "uncertain", "delivered"].includes(existing.delivery_state)) {
          throw new Error("bridge_wake_target_conflict: a sent delivery cannot acquire an unverified new conversation");
        }
        existing.wake_target ||= row.wake_target;
        if (existing.source === 'local') {
          existing.source = 'cloud';
          for (const field of ['delivery_id', 'event_id', 'event_name', 'project_revision']) existing[field] = row[field];
          existing.cloud_ack_state = 'pending';
          existing.cloud_ack_attempts = 0;
          if (existing.wake_target) existing.legacy_binding = false;
        }
        return { row: structuredClone(existing), alreadyDelivered: existing.delivery_state === "delivered" };
      }
      const local = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, row) && item.delivery_state !== "superseded");
      if (local?.wake_target && row.wake_target && local.wake_target.url !== row.wake_target.url) {
        throw new Error("bridge_wake_target_conflict: Cloud delivery target differs from its local fallback");
      }
      if (local && !local.wake_target && row.wake_target && ["sending", "uncertain", "delivered"].includes(local.delivery_state)) {
        throw new Error("bridge_wake_target_conflict: a sent local fallback cannot acquire an unverified new conversation");
      }
      row.wake_target ||= local?.wake_target;
      row.legacy_binding ||= local?.legacy_binding === true;
      if (row.wake_target) row.legacy_binding = false;
      if (local && (["sending", "uncertain", "delivered"].includes(local.delivery_state) || local.attempts > 0 || local.delivery_manual_intervention)) {
        // Keep the original message key: reconciliation must inspect the exact
        // text which may already have reached the conversation. ACK the formal
        // envelope only after that original send is confirmed visible.
        local.source = "cloud";
        local.delivery_id = row.delivery_id;
        local.event_id = row.event_id;
        local.event_name = row.event_name;
        local.project_revision = row.project_revision;
        local.cloud_message_key = row.message_key;
        local.cloud_ack_state = "pending";
        local.cloud_ack_attempts = 0;
        local.wake_target ||= row.wake_target;
        return { row: structuredClone(local), alreadyDelivered: local.delivery_state === "delivered" };
      }
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
      const row = db.deliveries.find((item) => item.source === "local" && sameTerminal(item, identity) && item.delivery_state === "pending" && item.attempts === 0 && !item.delivery_manual_intervention);
      if (!row) return null;
      row.delivery_state = "superseded";
      return structuredClone(row);
    });
  }

  async beginAttempt(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "pending" || row.delivery_manual_intervention) return null;
      const retryAt = row.next_attempt_at ? Date.parse(row.next_attempt_at) : 0;
      const nowAt = Date.parse(this.now());
      if (row.attempts >= this.manualReviewThreshold || (row.recovery_started_at && nowAt - Date.parse(row.recovery_started_at) >= this.recoveryWindowMs)) {
        row.delivery_manual_intervention = true;
        row.last_error = 'delivery_recovery_boundary_exhausted';
        row.next_attempt_at = null;
        return null;
      }
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
      row.delivery_state = "sending"; row.send_owner_pid = process.pid; row.attempts += 1; row.last_error = null; row.next_attempt_at = null;
      row.send_owner_token = processOwnerToken;
      row.send_started_at = this.now();
      row.previous_delivery_stage = row.delivery_stage;
      row.delivery_stage = "queued";
      row.draft_verified = false;
      row.submit_attempted = false;
      return structuredClone(row);
    });
  }

  async markDelivered(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row) return null;
      row.delivery_state = "delivered"; row.delivered_at ||= this.now(); row.last_error = null; row.next_attempt_at = null;
      row.message_visible = true;
      if (row.delivery_stage !== "transport_acked") row.delivery_stage = "message_visible";
      row.send_state = null;
      row.next_reconcile_at = null;
      row.reconcile_lock_until = null;
      row.reconcile_manual_intervention = false;
      if (row.source === "cloud" && !["acked", "sending"].includes(row.cloud_ack_state)) row.cloud_ack_state = "pending";
      return structuredClone(row);
    });
  }

  async recordSendProgress(key, stage, diagnostic = {}) {
    if (!["draft_verified", "submit_attempted"].includes(stage)) throw new Error("bridge_progress_stage_invalid");
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "sending" || row.send_owner_pid !== process.pid || row.send_owner_token !== processOwnerToken) {
        throw new Error("bridge_progress_owner_invalid: send is no longer owned by this process");
      }
      if (stage === "draft_verified") {
        row.draft_verified = true;
        row.draft_verified_at ||= this.now();
        if (row.delivery_stage !== "submit_attempted") row.delivery_stage = stage;
      } else {
        if (row.draft_verified !== true) throw new Error("bridge_progress_order_invalid: a verified draft is required before submission");
        row.submit_attempted = true;
        row.submit_attempted_at = this.now();
        row.delivery_stage = stage;
      }
      row.submit_diagnostic = {
        stage,
        composer_has_message_key: diagnostic.composerHasMessageKey === true,
        submit_attempted: stage === "submit_attempted",
        draft_retained: diagnostic.draftRetained === true,
      };
      return structuredClone(row);
    });
  }

  async markFailed(key, error) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || ["delivered", "superseded"].includes(row.delivery_state)) return null;
      const code = typeof error?.code === "string" ? error.code : null;
      row.recovery_started_at ||= this.now();
      const diagnostic = error?.diagnostic;
      if (diagnostic && typeof diagnostic === "object") row.submit_diagnostic = {
        stage: ["composer_insertion", "submission_state", "page_confirmation"].includes(diagnostic.stage) ? diagnostic.stage : null,
        composer_has_message_key: diagnostic.composerHasMessageKey === true,
        submit_attempted: diagnostic.submitAttempted === true,
        message_visible: diagnostic.messageVisible === true,
        draft_retained: diagnostic.draftRetained === true,
      };
      if (row.delivery_state !== "superseded") {
        if (code === "bridge_send_uncertain" || code === "bridge_send_not_submitted" || row.submit_attempted === true) {
          row.delivery_state = "uncertain";
          row.send_state = code === "bridge_send_not_submitted" ? "safe_draft" : "uncertain";
          row.next_attempt_at = null;
          row.next_reconcile_at = null;
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
    await this.#recoverInterrupted();
    const db = await this.#read();
    const nowAt = Date.parse(this.now());
    return db.deliveries.filter((row) => row.delivery_state === "uncertain"
      && !row.reconcile_manual_intervention
      && (!row.next_reconcile_at || !Number.isFinite(Date.parse(row.next_reconcile_at)) || !Number.isFinite(nowAt) || Date.parse(row.next_reconcile_at) <= nowAt)
      && (!row.reconcile_lock_until || !Number.isFinite(Date.parse(row.reconcile_lock_until)) || !Number.isFinite(nowAt) || Date.parse(row.reconcile_lock_until) <= nowAt))
      .map((row) => structuredClone(row));
  }

  async beginReconciliation(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "uncertain" || row.reconcile_manual_intervention) return null;
      const nowAt = Date.parse(this.now());
      if (row.reconcile_attempts >= this.manualReviewThreshold || nowAt - Date.parse(row.recovery_started_at || row.last_failure_at || row.created_at) >= this.recoveryWindowMs) {
        row.reconcile_manual_intervention = true;
        row.last_reconcile_error = "recovery_boundary_exhausted";
        row.next_reconcile_at = null;
        return null;
      }
      const dueAt = row.next_reconcile_at ? Date.parse(row.next_reconcile_at) : 0;
      const lockUntil = row.reconcile_lock_until ? Date.parse(row.reconcile_lock_until) : 0;
      if ((Number.isFinite(dueAt) && dueAt > 0 && Number.isFinite(nowAt) && dueAt > nowAt)
        || (Number.isFinite(lockUntil) && lockUntil > 0 && Number.isFinite(nowAt) && lockUntil > nowAt)) return null;
      row.reconcile_lock_until = new Date(nowAt + this.reconcileLockMs).toISOString();
      return structuredClone(row);
    });
  }

  async recordReconciliation(key, diagnostic = {}) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "uncertain") return null;
      row.reconcile_attempts += 1;
      row.reconcile_lock_until = null;
      row.last_reconcile_at = this.now();
      const reason = typeof diagnostic.reason === "string" || diagnostic.reason instanceof Error
        ? sanitizeWakeError(diagnostic.reason).replace(/https?:\/\/[^\s"']+/giu, "[url]")
        : null;
      const stage = ["target_location", "frame_validation", "page_confirmation", "submission_state"].includes(diagnostic.stage) ? diagnostic.stage : "page_confirmation";
      row.last_reconcile_error = reason;
      row.reconcile_diagnostic = {
        stage,
        reason,
        target_found: diagnostic.targetFound === true,
        frame_confirmed: diagnostic.frameConfirmed === true,
        message_visible: diagnostic.messageVisible === true,
        composer_found: diagnostic.composerFound === true,
        composer_empty: diagnostic.composerEmpty === true,
        composer_has_message_key: diagnostic.composerHasMessageKey === true,
        send_enabled: diagnostic.sendEnabled === true,
        send_control_found: diagnostic.sendControlFound === true,
        send_control_disabled: diagnostic.sendControlDisabled === true,
        submitting: diagnostic.submitting === true,
        stale_stop_control: diagnostic.staleStopControl === true,
        visible_errors: Number.isInteger(diagnostic.visibleErrors) ? diagnostic.visibleErrors : null,
        chat_page_count: Number.isInteger(diagnostic.chatPageCount) ? diagnostic.chatPageCount : null,
        read_only: diagnostic.readOnly === true,
        draft_retained: diagnostic.draftRetained === true,
        submit_attempted: diagnostic.submitAttempted === true,
      };
      const delay = retryDelayMs(row.reconcile_attempts, this.reconcileBaseMs, this.reconcileMaxMs);
      row.next_reconcile_at = new Date(Date.parse(this.now()) + delay).toISOString();
      if (row.reconcile_attempts >= this.manualReviewThreshold) row.reconcile_manual_intervention = true;
      return structuredClone(row);
    });
  }

  async resolveUncertain(key, result) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.delivery_state !== "uncertain") return null;
      if (result === "delivered") {
        row.delivery_state = "delivered";
        row.message_visible = true;
        row.delivery_stage = "message_visible";
        row.delivered_at ||= this.now();
        row.last_error = null;
        row.send_state = null;
        row.next_reconcile_at = null;
        row.reconcile_lock_until = null;
        row.last_reconcile_error = null;
        row.reconcile_manual_intervention = false;
      } else if (result === "safe_draft" && row.recovery_attempts < 1) {
        row.delivery_state = "pending";
        row.recovery_attempts += 1;
        row.last_error = null;
        row.send_state = null;
        row.next_attempt_at = null;
        row.next_reconcile_at = null;
        row.reconcile_lock_until = null;
        row.last_reconcile_error = null;
      }
      return structuredClone(row);
    });
  }

  async listPendingCloudAcks() {
    await this.initialize();
    await this.#recoverInterrupted();
    const db = await this.#read();
    const nowAt = Date.parse(this.now());
    return db.deliveries.filter((row) => row.source === "cloud" && row.delivery_state === "delivered" && row.cloud_ack_state !== "acked"
      && !row.cloud_ack_manual_intervention
      && (!row.cloud_ack_next_attempt_at || !Number.isFinite(Date.parse(row.cloud_ack_next_attempt_at)) || !Number.isFinite(nowAt) || Date.parse(row.cloud_ack_next_attempt_at) <= nowAt))
      .map((row) => structuredClone(row));
  }

  async beginCloudAck(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.source !== "cloud" || row.delivery_state !== "delivered" || row.cloud_ack_manual_intervention || row.cloud_ack_state === "acked" || (row.cloud_ack_state === "sending" && ownerAlive(row.cloud_ack_owner_pid, row.cloud_ack_owner_token))) return null;
      const retryAt = row.cloud_ack_next_attempt_at ? Date.parse(row.cloud_ack_next_attempt_at) : 0;
      const nowAt = Date.parse(this.now());
      if (Number.isFinite(retryAt) && retryAt > 0 && Number.isFinite(nowAt) && retryAt > nowAt) return null;
      row.cloud_ack_started_at ||= this.now();
      if (row.cloud_ack_attempts >= this.manualReviewThreshold || nowAt - Date.parse(row.cloud_ack_started_at) >= this.recoveryWindowMs) {
        row.cloud_ack_manual_intervention = true;
        row.cloud_ack_last_error = 'cloud_ack_recovery_boundary_exhausted';
        row.cloud_ack_next_attempt_at = null;
        return null;
      }
      row.cloud_ack_attempts += 1;
      row.cloud_ack_state = "sending";
      row.cloud_ack_owner_pid = process.pid;
      row.cloud_ack_owner_token = processOwnerToken;
      row.cloud_ack_next_attempt_at = new Date(nowAt + retryDelayMs(row.cloud_ack_attempts, this.retryBaseMs, this.retryMaxMs)).toISOString();
      return structuredClone(row);
    });
  }

  async finishCloudAck(key) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.source !== "cloud" || row.delivery_state !== "delivered") return null;
      row.cloud_ack_state = "acked";
      row.transport_acked = true;
      row.delivery_stage = "transport_acked";
      row.cloud_ack_next_attempt_at = null;
      row.cloud_ack_last_error = null;
      return structuredClone(row);
    });
  }

  async failCloudAck(key, error) {
    await this.initialize();
    return this.#mutate((db) => {
      const row = db.deliveries.find((item) => item.message_key === key);
      if (!row || row.source !== "cloud" || row.delivery_state !== "delivered" || row.cloud_ack_state === "acked") return null;
      row.cloud_ack_state = "pending";
      row.cloud_ack_last_error = sanitizeWakeError(error);
      return structuredClone(row);
    });
  }

  async listPending() {
    await this.initialize();
    const db = await this.#read();
    const nowAt = Date.parse(this.now());
    return db.deliveries.filter((row) => row.delivery_state === "pending" && !row.delivery_manual_intervention && (!row.next_attempt_at || !Number.isFinite(Date.parse(row.next_attempt_at)) || !Number.isFinite(nowAt) || Date.parse(row.next_attempt_at) <= nowAt)).map((row) => structuredClone(row));
  }

  async findByMessageKey(key) {
    await this.initialize();
    const db = await this.#read();
    const row = db.deliveries.find((item) => item.message_key === key);
    return row ? structuredClone(row) : null;
  }

  async #mutate(operation) {
    const result = this.queue.writeTail.then(async () => {
      const unlock = await this.#lockFile();
      try {
      const db = await this.#read();
      const value = operation(db);
      const resultValue = value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : value;
      if (value?.unchanged !== true) await this.#write(db);
      return resultValue;
      } finally { await unlock(); }
    });
    this.queue.writeTail = result.catch(() => {});
    return result;
  }

  async #lockFile(lockPath = `${this.filePath}.lock`) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: processOwnerToken })); }
        finally { await handle.close(); }
        return () => rm(lockPath, { force: true });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (!ownerAlive(owner.pid, owner.token) && await this.#removeAbandonedLock(lockPath)) continue;
        } catch (readError) {
          if (readError?.code === "ENOENT") continue;
          if (!(readError instanceof SyntaxError)) throw readError;
          // A writer can be between exclusive create and writing its owner.
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 30000 && await this.#removeAbandonedLock(lockPath)) continue;
        }
        if (Date.now() - started >= 10000) throw new Error("bridge_outbox_busy: another process owns the durable outbox lock");
        await new Promise((done) => setTimeout(done, 10));
      }
    }
  }

  async #removeAbandonedLock(lockPath) {
    // Serialize stale-owner removal separately: two observers must never remove
    // the fresh lock acquired by a third process after the first removal.
    const guardPath = `${lockPath}.recovery`;
    let guard;
    try { guard = await open(guardPath, "wx", 0o600); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return false;
    }
    try {
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (!ownerAlive(owner.pid, owner.token)) { await rm(lockPath, { force: true }); return true; }
        return false;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        if (!(error instanceof SyntaxError)) throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30000) { await rm(lockPath, { force: true }); return true; }
        return false;
      }
    } finally { await guard.close(); await rm(guardPath, { force: true }); }
  }

  async #read() {
    try { return validDb(JSON.parse(await readFile(this.filePath, "utf8"))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const backup = `${this.filePath}.bak`;
      try {
        const recovered = validDb(JSON.parse(await readFile(backup, "utf8")));
        return recovered;
      } catch (backupError) {
        if (backupError?.code === "ENOENT") return { version: FORMAT_VERSION, deliveries: [] };
        throw backupError;
      }
    }
  }

  async #write(db) {
    // Settled rows remain deduplication receipts, including pending ACKs.
    // Pruning without a separate durable receipt store permits old wakes to resend.
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(db)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (this.platform === "win32") {
      const backup = `${this.filePath}.bak`;
      // When startup read the sole backup, retain it until a new canonical
      // file has committed. A second crash must still have a durable receipt.
      const canonicalExists = await stat(this.filePath).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
      if (canonicalExists) {
        await rm(backup, { force: true });
        await rename(this.filePath, backup);
      }
      await syncDirectory(this.filePath);
      await rename(temporary, this.filePath);
      await syncDirectory(this.filePath);
      await rm(backup, { force: true });
      await syncDirectory(this.filePath);
    } else await rename(temporary, this.filePath);
    await syncDirectory(this.filePath);
  }
}
