import { sanitizeWakeError } from "./bridge-outbox.mjs";

const DEFAULT_RETRY_INTERVAL_MS = 5000;
const MAX_BATCH = 8;

function cloudEnvelope(delivery) {
  return {
    delivery_id: delivery.delivery_id,
    message_key: delivery.message_key,
    project_id: delivery.project_id,
    task_id: delivery.task_id,
    event_id: delivery.event_id,
    event_name: delivery.event_name,
    project_revision: delivery.project_revision,
    ...(delivery.wake_target ? { wake_target: delivery.wake_target } : {}),
    ...(delivery.wake_target ? {} : delivery.legacy_binding === true ? { legacy_binding: true } : {}),
  };
}

export class WakeTransport {
  constructor({ outbox, bridge, enabled = () => true, logger, acknowledgeDelivery = null, rejectDelivery = null, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS, maxBatch = MAX_BATCH } = {}) {
    if (!outbox || typeof outbox.listPending !== "function" || !bridge) {
      throw new Error("WakeTransport requires a durable outbox and Chat Bridge");
    }
    this.outbox = outbox;
    this.bridge = bridge;
    this.enabled = typeof enabled === "function" ? enabled : () => enabled !== false;
    this.logger = logger;
    this.acknowledgeDelivery = typeof acknowledgeDelivery === "function" ? acknowledgeDelivery : null;
    this.rejectDelivery = typeof rejectDelivery === "function" ? rejectDelivery : null;
    this.retryIntervalMs = Number.isInteger(retryIntervalMs) && retryIntervalMs >= 100 ? retryIntervalMs : DEFAULT_RETRY_INTERVAL_MS;
    this.maxBatch = Number.isInteger(maxBatch) && maxBatch > 0 ? Math.min(maxBatch, MAX_BATCH) : MAX_BATCH;
    this.wakeupRequested = false;
    this.wakeupWaiter = null;
    this.drainPromise = null;
    this.loopPromise = null;
    this.reconciledUncertain = new Set();
  }

  kick() {
    this.wakeupRequested = true;
    this.wakeupWaiter?.();
  }

  async acknowledgeCloudDelivery(delivery) {
    if (!this.acknowledgeDelivery) return false;
    try {
      const envelope = delivery.message_key ? cloudEnvelope(delivery) : {
        delivery_id: delivery.deliveryId,
        message_key: delivery.messageKey,
        project_id: delivery.projectId,
        event_id: delivery.eventId,
        task_id: delivery.taskId,
        event_name: delivery.eventName,
        project_revision: delivery.revision,
      };
      await this.acknowledgeDelivery(envelope);
      return true;
    } catch (error) {
      this.logger?.warn?.("deepseek-worker wake transport: cloud delivery acknowledgement failed: %s", sanitizeWakeError(error));
      return false;
    }
  }

  async rejectCloudDelivery(delivery, reason) {
    if (!this.rejectDelivery || !delivery || typeof delivery !== "object") return false;
    const identity = Object.fromEntries([
      "delivery_id", "message_key", "project_id", "event_id", "task_id", "event_name", "project_revision",
    ].map((key) => [key, delivery[key]]));
    try {
      await this.rejectDelivery(identity, reason);
      return true;
    } catch (error) {
      this.logger?.warn?.("deepseek-worker wake transport: permanent delivery rejection failed: %s", sanitizeWakeError(error));
      return false;
    }
  }

  async drainOnce() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.#drain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async run(signal) {
    if (this.loopPromise) return this.loopPromise;
    this.loopPromise = this.#run(signal).finally(() => { this.loopPromise = null; });
    return this.loopPromise;
  }

  async #run(signal) {
    while (!signal.aborted) {
      this.wakeupRequested = false;
      try {
        await this.outbox.initialize?.();
        await this.drainOnce();
      } catch (error) {
        this.logger?.warn?.("deepseek-worker wake transport: %s", sanitizeWakeError(error));
      }
      if (signal.aborted) break;
      if (this.wakeupRequested) continue;
      await this.#wait(signal);
    }
  }

  async #wait(signal) {
    await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.wakeupWaiter === finish) this.wakeupWaiter = null;
        resolve();
      };
      timer = setTimeout(finish, this.retryIntervalMs);
      this.wakeupWaiter = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted || this.wakeupRequested) finish();
    });
  }

  async #drain() {
    if (!this.enabled()) return { attempted: 0, delivered: 0 };
    let attempted = 0;
    let delivered = 0;
    if (typeof this.outbox.listUncertain === "function" && typeof this.bridge.reconcileDelivery === "function") {
      const uncertain = await this.outbox.listUncertain();
      for (const row of uncertain) {
        if (this.reconciledUncertain.has(row.message_key)) continue;
        this.reconciledUncertain.add(row.message_key);
        try {
          const result = await this.bridge.reconcileDelivery(row);
          if (result?.state === "delivered") {
            await this.outbox.withDeliveryLock(() => this.outbox.resolveUncertain(row.message_key, "delivered"));
            if (row.source === "cloud") await this.acknowledgeCloudDelivery(row);
            delivered += 1;
          } else if (result?.state === "safe_draft") {
            await this.outbox.withDeliveryLock(() => this.outbox.resolveUncertain(row.message_key, "safe_draft"));
          } else {
            this.logger?.warn?.("deepseek-worker wake transport: uncertain delivery retained for safe verification (key=%s reason=%s)", row.message_key, result?.reason || "unverified");
          }
        } catch (error) {
          this.logger?.warn?.("deepseek-worker wake transport: uncertain delivery verification failed (key=%s error=%s)", row.message_key, sanitizeWakeError(error));
        }
      }
    }
    const pending = (await this.outbox.listPending()).slice(0, this.maxBatch);
    for (const row of pending) {
      if (!this.enabled()) break;
      const delivery = await this.outbox.withDeliveryLock(() => this.outbox.beginAttempt(row.message_key));
      if (!delivery) continue;
      attempted += 1;
      try {
        if (delivery.source === "cloud") await this.bridge.sendEnvelope(cloudEnvelope(delivery));
        else await this.bridge.sendLocalWake(delivery);
        await this.outbox.withDeliveryLock(() => this.outbox.markDelivered(delivery.message_key));
        if (delivery.source === "cloud") await this.acknowledgeCloudDelivery(delivery);
        delivered += 1;
      } catch (error) {
        const failed = await this.outbox.withDeliveryLock(() => this.outbox.markFailed(delivery.message_key, error));
        this.logger?.warn?.("deepseek-worker wake transport: %s", failed?.last_error || "Chat Bridge delivery failed");
      }
    }
    return { attempted, delivered };
  }
}
