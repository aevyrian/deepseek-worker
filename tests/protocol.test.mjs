import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  buildTaskPrompt,
  extractAssistantText,
  normalizeConfig,
  workerRequest,
  workspaceForTask,
} from "../lib/protocol.mjs";

test("requires HTTPS and defaults to an empty native Workspace authorization list", () => {
  assert.throws(() => normalizeConfig({ endpoint: "http://example.test/api/worker" }), /HTTPS/);
  const config = normalizeConfig({});
  assert.deepEqual(config.authorizedWorkspaceIds, []);
  assert.equal(config.trustedWorkspaceMode, true);
  assert.equal(config.autoUpdate, true);
  assert.equal(config.updateChannel, "stable");
});

test("normalizes update channel without changing Workspace semantics", () => {
  const preview = normalizeConfig({ updateChannel: "preview", autoUpdate: false });
  assert.equal(preview.updateChannel, "preview");
  assert.equal(preview.autoUpdate, false);
  assert.deepEqual(preview.authorizedWorkspaceIds, []);
  const invalid = normalizeConfig({ updateChannel: "nightly" });
  assert.equal(invalid.updateChannel, "stable");
});

test("accepts only an exact authorized Harness WorkspaceId", () => {
  const config = normalizeConfig({
    endpoint: "https://example.test/api/worker",
    authorizedWorkspaceIds: ["workspace-a"],
  });
  assert.deepEqual(workspaceForTask(config, { workspace_id: "workspace-a" }), { workspaceId: "workspace-a" });
  assert.throws(
    () => workspaceForTask(config, { workspace_id: "workspace-b" }),
    /not authorized/,
  );
});

test("Cloud cannot inject a local path even in trusted Workspace mode", () => {
  for (const trustedWorkspaceMode of [true, false]) {
    const config = normalizeConfig({
      endpoint: "https://example.test/api/worker",
      authorizedWorkspaceIds: ["workspace-a"],
      trustedWorkspaceMode,
    });
    for (const field of ["cwd", "path", "workspace_path", "local_path"]) {
      assert.throws(
        () => workspaceForTask(config, { workspace_id: "workspace-a", [field]: "E:/outside" }),
        /cannot specify local path/,
      );
    }
  }
});

test("normalizes and deduplicates authorized Workspace IDs", () => {
  const config = normalizeConfig({
    endpoint: "https://example.test/api/worker",
    authorizedWorkspaceIds: ["workspace-a", " workspace-b ", "workspace-a"],
  });
  assert.deepEqual(config.authorizedWorkspaceIds, ["workspace-a", "workspace-b"]);
});

test("builds the prompt from durable context and task text", () => {
  assert.equal(
    buildTaskPrompt({ context: "Prior result", prompt: "Continue" }),
    "Saved task context:\nPrior result\n\nTask:\nContinue",
  );
});

test("extracts assistant text from a completed Session event", () => {
  assert.equal(
    extractAssistantText({ message: { content: [{ type: "text", text: "Done." }] } }),
    "Done.",
  );
});

test("sends Bearer authorization and the native WorkspaceId allowlist payload unchanged", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        route: request.url,
        auth: request.headers.authorization,
        body: JSON.parse(body),
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const config = {
      endpoint: `http://127.0.0.1:${address.port}/api/worker`,
      workerId: "test-worker",
    };
    const token = "not-a-real-secret-local-test-only";
    const result = await workerRequest(config, token, "register", {
      workspace_allowlist: ["workspace-a", "workspace-b"],
    }, new AbortController().signal);
    assert.equal(result.route, "/api/worker/register");
    assert.equal(result.auth, `Bearer ${token}`);
    assert.equal(result.body.worker_id, "test-worker");
    assert.deepEqual(result.body.workspace_allowlist, ["workspace-a", "workspace-b"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("heartbeat carries only explicit Workspace identity metadata", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const config = {
      endpoint: `http://127.0.0.1:${address.port}/api/worker`,
      workerId: "test-worker",
    };
    const result = await workerRequest(config, "local-test-token", "heartbeat", {
      state: "online",
      workspace_allowlist: ["workspace-a"],
      workspaces: [{ id: "workspace-a", name: "Project A" }],
      client_version: "0.3.3-preview.2",
    }, new AbortController().signal);
    assert.deepEqual(result.workspaces, [{ id: "workspace-a", name: "Project A" }]);
    assert.deepEqual(result.workspace_allowlist, ["workspace-a"]);
    assert.equal(Object.hasOwn(result, "path"), false);
    assert.equal(Object.hasOwn(result, "cwd"), false);
    assert.equal(Object.hasOwn(result, "token"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});