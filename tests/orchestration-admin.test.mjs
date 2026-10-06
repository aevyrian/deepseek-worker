import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventCore } from "../cloud/event-core.mjs";
import {
  getOrchestrationDiagnostics,
  getProjectOrchestrationMode,
  setProjectOrchestrationMode,
} from "../cloud/orchestration-admin.mjs";

const OWNER = "owner-1";
const PROJECT = "project-1";

function createStore() {
  const core = new InMemoryEventCore();
  core.createProject({ projectId: PROJECT, owner: OWNER });
  core.configs = new Map();
  core.getOrchestrationConfig = async (projectId) => core.configs.get(projectId) ?? null;
  core.setOrchestrationConfig = async (projectId, _owner, config) => {
    core.configs.set(projectId, structuredClone(config));
  };
  core.getLatestOrchestratorRun = async () => ({
    run_id: "run-1",
    status: "completed",
    selected_path: "cloud",
    fallback_reason: "no_active_subscription",
    model: "model-test",
    response_id: "resp-1",
    input_event_ids: ["evt-1"],
    created_task_ids: ["task-2"],
    error_summary: null,
    started_at: "2026-10-06T12:00:00Z",
    finished_at: "2026-10-06T12:00:02Z",
  });
  return core;
}

test("old projects default to auto mode with a 30 second native grace", async () => {
  const store = createStore();
  const result = await getProjectOrchestrationMode({
    store,
    projectId: PROJECT,
    owner: OWNER,
  });
  assert.deepEqual(result, {
    project_id: PROJECT,
    mode: "auto",
    native_grace_ms: 30_000,
  });
});

test("project orchestration mode can switch among native/cloud/auto", async () => {
  const store = createStore();
  const cloud = await setProjectOrchestrationMode({
    store,
    projectId: PROJECT,
    owner: OWNER,
    mode: "cloud",
    nativeGraceMs: 45_000,
    now: new Date("2026-10-06T12:00:00Z"),
  });
  assert.equal(cloud.mode, "cloud");
  assert.equal(cloud.native_grace_ms, 45_000);

  const read = await getProjectOrchestrationMode({
    store,
    projectId: PROJECT,
    owner: OWNER,
  });
  assert.equal(read.mode, "cloud");

  const auto = await setProjectOrchestrationMode({
    store,
    projectId: PROJECT,
    owner: OWNER,
    mode: "auto",
    nativeGraceMs: 30_000,
  });
  assert.equal(auto.mode, "auto");
});

test("diagnostics expose mode, native health, pending count, and sanitized latest run", async () => {
  const store = createStore();
  const result = await getOrchestrationDiagnostics({
    store,
    projectId: PROJECT,
    owner: OWNER,
    nativeHealth: {
      activeSubscriptionCount: 0,
    },
  });

  assert.equal(result.mode, "auto");
  assert.equal(result.pending_event_count, 0);
  assert.equal(result.native_subscription.healthy, false);
  assert.equal(result.native_subscription.reason, "no_active_subscription");
  assert.equal(result.latest_cloud_run.run_id, "run-1");
  assert.deepEqual(result.latest_cloud_run.created_task_ids, ["task-2"]);
  assert.ok(!Object.hasOwn(result.latest_cloud_run, "api_key"));
  assert.ok(!Object.hasOwn(result.latest_cloud_run, "callback_url"));
});
