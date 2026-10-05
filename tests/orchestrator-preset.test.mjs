import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_WORKER_PRESET_ID } from "../lib/native-session.mjs";
import { ORCHESTRATOR_TASK_CONTRACT, buildTaskPrompt } from "../lib/protocol.mjs";

test("worker orchestration uses the built-in Standard preset", () => {
  assert.equal(DEFAULT_WORKER_PRESET_ID, "standard");
});

test("connector bundle owns only the connector row and no standing agent preset", async () => {
  const patch = await readFile(new URL("../dsh.bundle.patch.yml", import.meta.url), "utf8");
  assert.equal(patch.includes("id: deepseek-worker-connector"), true);
  assert.equal(patch.includes("@deepseek-ai/dsh-agent-preset"), false);
  assert.equal(patch.includes("preset-orchestrator-worker"), false);
  assert.equal(patch.includes("orchestrator-worker"), false);
});

test("orchestrator behavior is carried in each task prompt instead of a persistent bundle component", () => {
  const prompt = buildTaskPrompt({ context: "Previous result", prompt: "Continue fixing the project" });
  assert.equal(prompt.startsWith(ORCHESTRATOR_TASK_CONTRACT), true);
  assert.match(prompt, /Prefer doing, testing, and verifying over explaining/);
  assert.match(prompt, /Saved task context:\nPrevious result/);
  assert.match(prompt, /Task:\nContinue fixing the project/);
});
