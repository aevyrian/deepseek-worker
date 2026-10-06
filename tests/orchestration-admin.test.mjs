import assert from "node:assert/strict";
import test from "node:test";

import {
  getOrchestrationDiagnostics,
  getProjectOrchestrationMode,
  setProjectOrchestrationMode,
} from "../cloud/orchestration-admin.mjs";

const PROJECT = "project-1";
const OWNER = "owner-1";

function makeStore() {
  let config = null;
  return {
    async getProject(projectId, owner) {
      return projectId === PROJECT && owner === OWNER ? { project_id: PROJECT } : null;
    },
    async getOrchestrationConfig() { return config; },
    async setOrchestrationConfig(_project, _owner, value) { config = value; },
    async listPendingEvents() {
      return [{ event_id: "evt-1" }];
    },
    async getLatestBridgeDelivery() {
      return {
        delivery_id: "bridge-del-1",
        event_id: "evt-1",
        task_id: "task-1",
        state: "sent",
        attempts: 1,
        fallback_reason: "no_active_subscription",
        last_error: null,
        created_at: "2026-10-06T12:00:00Z",
        sent_at: "2026-10-06T12:00:01Z",
      };
    },
  };
}

test("old or unset projects default to free auto mode", async () => {
  const result = await getProjectOrchestrationMode({
    store: makeStore(),
    projectId: PROJECT,
    owner: OWNER,
  });
  assert.deepEqual(result, {
    project_id: PROJECT,
    mode: "auto",
    native_grace_ms: 30000,
  });
});

test("project mode accepts native/bridge/auto and rejects retired cloud mode", async () => {
  const store = makeStore();
  const bridge = await setProjectOrchestrationMode({
    store,
    projectId: PROJECT,
    owner: OWNER,
    mode: "bridge",
  });
  assert.equal(bridge.mode, "bridge");

  const read = await getProjectOrchestrationMode({ store, projectId: PROJECT, owner: OWNER });
  assert.equal(read.mode, "bridge");

  await assert.rejects(
    () => setProjectOrchestrationMode({ store, projectId: PROJECT, owner: OWNER, mode: "cloud" }),
    /auto.*native.*bridge/u,
  );
});

test("diagnostics report free channels and explicitly disable paid cloud orchestrator", async () => {
  const result = await getOrchestrationDiagnostics({
    store: makeStore(),
    projectId: PROJECT,
    owner: OWNER,
    nativeHealth: { activeSubscriptionCount: 0 },
    bridge: {
      ready: true,
      worker_online: true,
      bound: true,
      state: "sent",
      last_event_id: "evt-1",
      last_sent_at: "2026-10-06T12:00:01Z",
    },
  });

  assert.equal(result.mode, "auto");
  assert.equal(result.pending_event_count, 1);
  assert.equal(result.native_subscription.healthy, false);
  assert.equal(result.chat_bridge.ready, true);
  assert.equal(result.latest_bridge_delivery.state, "sent");
  assert.equal(result.paid_cloud_orchestrator_enabled, false);
  assert.ok(!Object.hasOwn(result, "latest_cloud_run"));
});
