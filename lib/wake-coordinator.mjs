import { normalizeBridgeEnvelope } from "./chat-bridge.mjs";

const MAX_CLOUD_DELIVERIES = 8;

export class WakeCoordinator {
  constructor({ outbox, transport, enabled = () => true, logger } = {}) {
    if (!outbox || typeof outbox.adoptCloudDelivery !== "function" || typeof outbox.enqueueLocal !== "function") {
      throw new Error("WakeCoordinator requires a durable bridge outbox");
    }
    this.outbox = outbox;
    this.transport = transport;
    this.enabled = typeof enabled === "function" ? enabled : () => enabled !== false;
    this.logger = logger;
  }

  async acceptResponse(response, terminal = null) {
    if (!response || typeof response !== "object" || !this.enabled()) {
      return { accepted: 0, localWake: null };
    }

    const rows = Array.isArray(response.bridge_deliveries)
      ? response.bridge_deliveries
      : response.bridge_delivery ? [response.bridge_delivery] : [];
    const boundedRows = rows.slice(0, MAX_CLOUD_DELIVERIES);
    if (rows.length > MAX_CLOUD_DELIVERIES) {
      this.logger?.warn?.("deepseek-worker wake coordinator: ignored excess bridge deliveries");
    }

    let accepted = 0;
    let reconciliationNeeded = false;
    let diagnostic = null;
    for (const row of boundedRows) {
      let envelope;
      let adopted;
      try {
        envelope = normalizeBridgeEnvelope(row);
        adopted = await this.outbox.adoptCloudDelivery(envelope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = ["bridge_wake_target_invalid", "bridge_wake_target_conflict"].find((code) => message.includes(code));
        if (reason) {
          const rejected = await this.transport?.rejectCloudDelivery?.(row, reason);
          if (rejected) {
            diagnostic = { code: reason, messageKey: typeof row?.message_key === "string" ? row.message_key : null };
            this.logger?.warn?.("deepseek-worker wake coordinator: permanently rejected Cloud delivery (%s)", reason);
            continue;
          }
          this.logger?.warn?.("deepseek-worker wake coordinator: rejected delivery target (%s)", reason);
        }
        throw error;
      }
      if (!adopted.alreadyDelivered && adopted.row.delivery_state === "pending") accepted += 1;
      else if (adopted.alreadyDelivered) await this.transport?.acknowledgeCloudDelivery?.(adopted.row);
      else if (adopted.row.delivery_state === "uncertain") reconciliationNeeded = true;
    }

    let localWake = null;
    if (rows.length === 0 && terminal) {
      const projectId = [response.project_id, response.project?.id, terminal.task?.project_id]
        .find((value) => typeof value === "string" && value.trim())?.trim();
      if (typeof projectId === "string" && projectId.trim()) {
        try {
          localWake = await this.outbox.enqueueLocal({
            projectId,
            taskId: terminal.taskId,
            terminalState: terminal.terminalState,
            wakeTarget: terminal.wakeTarget ?? terminal.task?.wake_target ?? null,
            // The Site only marks a delivery as legacy when the project itself is
            // origin-unbound. Never assume it.
            legacyBinding: (terminal.legacyBinding ?? terminal.task?.legacy_binding) === true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/bridge_wake_target_invalid|bridge_wake_target_conflict/iu.test(message)) {
            diagnostic = { code: message.split(":")[0], taskId: terminal.taskId ?? null, terminalState: terminal.terminalState ?? null };
            this.logger?.warn?.("deepseek-worker wake coordinator: rejected local delivery target (%s task=%s)", diagnostic.code, diagnostic.taskId ?? "unknown");
          } else throw error;
        }
      } else {
        diagnostic = {
          code: "terminal_project_identity_missing",
          taskId: typeof terminal.taskId === "string" ? terminal.taskId : null,
          terminalState: terminal.terminalState ?? null,
        };
        this.logger?.warn?.(
          "deepseek-worker wake coordinator: terminal response has no project identity; local wake was not queued (task=%s)",
          diagnostic.taskId ?? "unknown",
        );
      }
    }

    if (accepted > 0 || localWake?.delivery_state === "pending" || reconciliationNeeded) this.transport?.kick?.();
    return { accepted, localWake, diagnostic };
  }
}
