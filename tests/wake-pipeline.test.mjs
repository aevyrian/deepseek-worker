import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("terminal upload and wake persistence boundaries preserve terminal truth", () => {
  const probe = `
import { processLease } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "index.js")).href)};
const scenarios = ${JSON.stringify([
    { name: "result-success", resultStatus: 200 },
    { name: "result-wake-target", resultStatus: 200, wakeTarget: { type: "chatgpt_conversation", conversation_id: "conv-local", url: "https://chatgpt.com/c/conv-local", source: "worker-claim" } },
    { name: "result-missing-response-project", resultStatus: 200, missingResponseProject: true },
    { name: "result-failure", resultStatus: 503 },
    { name: "wake-persistence-failure", resultStatus: 200, wakeFails: true },
    { name: "failure-success", executionFails: true, failureStatus: 200 },
    { name: "failure-upload-failure", executionFails: true, failureStatus: 503 },
  ])};
  const results = [];
for (const scenario of scenarios) {
  const requests = [];
  const terminalContexts = [];
  let scheduled = 0;
  globalThis.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname.split("/").at(-1);
    requests.push(route);
    const status = route === "result" ? (scenario.resultStatus ?? 200)
      : route === "failure" ? (scenario.failureStatus ?? 200) : 200;
    return new Response(JSON.stringify({ ok: true, ...(scenario.missingResponseProject ? {} : { project_id: "project-1" }) }), {
      status, headers: { "content-type": "application/json" },
    });
  };
  const session = { events: [], snapshotEvents() { return [...this.events]; } };
  const agent = { session };
  const listeners = new Set();
  const controller = {
    async create() {
      if (scenario.executionFails) throw new Error("execution failed");
      return { sessionId: "session-1" };
    },
    async resolveAgent() { return { agent }; },
    async prompt() {
      const assistant = { type: "assistant/message", seq: 1, data: { message: { content: [{ type: "text", text: "done" }] } } };
      const end = { type: "turn/end", seq: 2, data: { reason: "completed" } };
      session.events.push(assistant, end);
      queueMicrotask(() => { for (const listener of listeners) listener(session, end); });
      return { accepted: true };
    },
  };
  const ctx = {
    workspaceRegistry: { get: () => ({ id: "workspace-1", path: process.cwd() }) },
    get: () => controller,
    on(_event, listener) { listeners.add(listener); return () => listeners.delete(listener); },
    logger: { warn() {} },
  };
  const config = {
    endpoint: "https://example.test/api/worker", workerId: "worker-test", authorizedWorkspaceIds: ["workspace-1"],
    trustedWorkspaceMode: true, chatBridgeEnabled: true, leaseRenewIntervalMs: 5000, leaseWaitTimeoutMs: 1000,
  };
  await processLease(ctx, config, "worker-token", { id: scenario.name, project_id: "project-from-claim", wake_target: scenario.wakeTarget, workspace_id: "workspace-1", prompt: "complete" }, new AbortController().signal, {
    async acceptResponse(_response, terminal) { scheduled += 1; terminalContexts.push(terminal); if (scenario.wakeFails) throw new Error("outbox unavailable"); },
  });
  results.push({ name: scenario.name, requests, scheduled, terminalContexts });
}
process.stdout.write(JSON.stringify(results));
`;
  const child = spawnSync(process.execPath, [
    "--no-warnings", "--experimental-loader", pathToFileURL(join(repositoryRoot, "tests", "support", "host-loader.mjs")).href,
    "--input-type=module", "-e", probe,
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.find((row) => row.name === "result-success"), {
    name: "result-success", requests: ["events", "result"], scheduled: 1,
    terminalContexts: [{ taskId: "result-success", task: { project_id: "project-from-claim" }, terminalState: "completed" }],
  });
  assert.deepEqual(result.find((row) => row.name === "result-wake-target"), {
    name: "result-wake-target", requests: ["events", "result"], scheduled: 1,
    terminalContexts: [{ taskId: "result-wake-target", task: { project_id: "project-from-claim", wake_target: { type: "chatgpt_conversation", conversation_id: "conv-local", url: "https://chatgpt.com/c/conv-local", source: "worker-claim" } }, terminalState: "completed" }],
  });
  assert.deepEqual(result.find((row) => row.name === "result-missing-response-project"), {
    name: "result-missing-response-project", requests: ["events", "result"], scheduled: 1,
    terminalContexts: [{ taskId: "result-missing-response-project", task: { project_id: "project-from-claim" }, terminalState: "completed" }],
  });
  assert.deepEqual(result.find((row) => row.name === "result-failure"), {
    name: "result-failure", requests: ["events", "result"], scheduled: 0, terminalContexts: [],
  });
  assert.deepEqual(result.find((row) => row.name === "wake-persistence-failure"), {
    name: "wake-persistence-failure", requests: ["events", "result"], scheduled: 1,
    terminalContexts: [{ taskId: "wake-persistence-failure", task: { project_id: "project-from-claim" }, terminalState: "completed" }],
  });
  assert.deepEqual(result.find((row) => row.name === "failure-success"), {
    name: "failure-success", requests: ["events", "failure"], scheduled: 1,
    terminalContexts: [{ taskId: "failure-success", task: { project_id: "project-from-claim" }, terminalState: "failed" }],
  });
  assert.deepEqual(result.find((row) => row.name === "failure-upload-failure"), {
    name: "failure-upload-failure", requests: ["events", "failure"], scheduled: 0, terminalContexts: [],
  });
});
