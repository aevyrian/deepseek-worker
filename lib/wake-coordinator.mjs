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
    for (const row of boundedRows) {
      const envelope = normalizeBridgeEnvelope(row);
      const adopted = await this.outbox.adoptCloudDelivery(envelope);
      if (!adopted.alreadyDelivered && adopted.row.delivery_state === "pending") accepted += 1;
    }

    let localWake = null;
    if (rows.length === 0 && terminal) {
      const projectId = response.project_id ?? response.project?.id;
      if (typeof projectId === "string" && projectId.trim()) {
        localWake = await this.outbox.enqueueLocal({
          projectId,
          taskId: terminal.taskId,
          terminalState: terminal.terminalState,
        });
      }
    }

    if (accepted > 0 || localWake?.delivery_state === "pending") this.transport?.kick?.();
    return { accepted, localWake };
  }
}