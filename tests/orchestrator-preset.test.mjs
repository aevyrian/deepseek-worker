import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_WORKER_PRESET_ID } from "../lib/native-session.mjs";
import {
  ORCHESTRATOR_PRESET_DEFINITION,
  ORCHESTRATOR_PRESET_ID,
  registerOrchestratorPreset,
} from "../lib/orchestrator-preset.mjs";
import { ORCHESTRATOR_TASK_CONTRACT, buildTaskPrompt } from "../lib/protocol.mjs";

test("worker orchestration keeps the built-in Standard preset for remote tasks", () => {
  assert.equal(DEFAULT_WORKER_PRESET_ID, "standard");
});

test("connector bundle owns only the connector row and no standing agent-preset row", async () => {
  const patch = await readFile(new URL("../dsh.bundle.patch.yml", import.meta.url), "utf8");
  assert.equal(patch.includes("id: deepseek-worker-connector"), true);
  assert.equal(patch.includes("@deepseek-ai/dsh-agent-preset"), false);
  assert.equal(patch.includes("preset-orchestrator-worker"), false);
});

test("runtime preset restores the visible total-control mode without schedule hard dependency", () => {
  assert.equal(ORCHESTRATOR_PRESET_ID, "orchestrator-worker");
  assert.equal(ORCHESTRATOR_PRESET_DEFINITION.id, "orchestrator-worker");
  assert.equal(ORCHESTRATOR_PRESET_DEFINITION.name, "总控执行模式");
  const ids = ORCHESTRATOR_PRESET_DEFINITION.plugins.map((row) => row.id);
  assert.equal(ids.includes("tool-schedule"), false);
  for (const id of ["persona", "tool-fs", "tool-fs-search", "delegation", "tool-web"]) {
    assert.equal(ids.includes(id), true, "missing orchestrator preset row: " + id);
  }
});

test("runtime preset registration is lifecycle-disposable", async () => {
  let registered = null;
  let disposed = false;
  const unregister = await registerOrchestratorPreset({
    list: async () => [],
    register: async (definition) => {
      registered = definition;
      return async () => { disposed = true; };
    },
  });
  assert.equal(registered?.id, "orchestrator-worker");
  assert.equal(typeof unregister, "function");
  await unregister();
  assert.equal(disposed, true);
});

test("runtime preset registration is idempotent when a preset already exists", async () => {
  let registerCalls = 0;
  const unregister = await registerOrchestratorPreset({
    list: async () => [{ id: "orchestrator-worker" }],
    register: async () => { registerCalls += 1; return async () => {}; },
  });
  assert.equal(unregister, null);
  assert.equal(registerCalls, 0);
});

test("remote worker behavior is also carried in each task prompt", () => {
  const prompt = buildTaskPrompt({ context: "Previous result", prompt: "Continue fixing the project" });
  assert.equal(prompt.startsWith(ORCHESTRATOR_TASK_CONTRACT), true);
  assert.match(prompt, /Prefer doing, testing, and verifying over explaining/);
  assert.match(prompt, /Saved task context:\nPrevious result/);
  assert.match(prompt, /Task:\nContinue fixing the project/);
});
