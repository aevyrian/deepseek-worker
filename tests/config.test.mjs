import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyConnectionError,
  executionMode,
  missingAuthorizedWorkspaceIds,
  normalizeAuthorizedWorkspaceIds,
  publicRuntimeStatus,
  reconcileAuthorizedWorkspaceIds,
  redactSecret,
  snapshotConnectorInput,
  workerTokenFromBytes,
} from "../lib/connector-config.mjs";
import { WorkerApiError } from "../lib/protocol.mjs";

test("normalizes authorized Harness Workspace IDs without local path data", () => {
  assert.deepEqual(
    normalizeAuthorizedWorkspaceIds(["workspace-a", " workspace-b ", "workspace-a"]),
    ["workspace-a", "workspace-b"],
  );
  assert.throws(() => normalizeAuthorizedWorkspaceIds([""]), /non-empty/);
  assert.throws(() => normalizeAuthorizedWorkspaceIds({}), /array/);
});

test("reconciles deleted Harness Workspaces from a persisted selection", () => {
  const selected = ["workspace-a", "workspace-old", "workspace-b"];
  const available = ["workspace-a", "workspace-b"];
  assert.deepEqual(reconcileAuthorizedWorkspaceIds(selected, available), ["workspace-a", "workspace-b"]);
  assert.deepEqual(missingAuthorizedWorkspaceIds(selected, available), ["workspace-old"]);
});

test("generates a 64-hex-character worker token from at least 32 random bytes", () => {
  const token = workerTokenFromBytes(Uint8Array.from({ length: 32 }, (_, index) => index));
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.throws(() => workerTokenFromBytes(new Uint8Array(31)), /32 bytes/);
});

test("public status never returns the credential value and preserves unknown execution", () => {
  const secret = "super-secret-value";
  const status = publicRuntimeStatus(
    { connector: "loaded", execution: "unknown", credential: secret, worker: "paused" },
    {
      credentialConfigured: true,
      workerId: "worker-a",
      workspaceCount: 1,
      missingWorkspaceIds: ["workspace-old"],
      trustedWorkspaceMode: true,
    },
  );
  assert.equal(status.credential, "configured");
  assert.equal(status.execution, "unknown");
  assert.deepEqual(status.missingWorkspaceIds, ["workspace-old"]);
  assert.equal(status.trustedWorkspaceMode, true);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(Object.hasOwn(status, "token"), false);
});

test("connector config serialization contains WorkspaceIds but ignores token and local path maps", () => {
  const secret = "should-never-serialize";
  const snapshot = snapshotConnectorInput({
    endpoint: "https://example.test/api/worker",
    authorizedWorkspaceIds: ["workspace-a"],
    trustedWorkspaceMode: true,
    LOCAL_WORKER_TOKEN: secret,
    token: secret,
    workspaceAllowlist: { alias: "E:/secret/project" },
  });
  const json = JSON.stringify(snapshot);
  assert.deepEqual(snapshot.authorizedWorkspaceIds, ["workspace-a"]);
  assert.equal(snapshot.trustedWorkspaceMode, true);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes("E:/secret/project"), false);
  assert.equal(Object.hasOwn(snapshot, "workspaceAllowlist"), false);
});

test("redacts explicit secrets and Bearer authorization", () => {
  const secret = "abc123-secret";
  const text = redactSecret(`request failed: ${secret}; Authorization: Bearer ${secret}`, secret);
  assert.equal(text.includes(secret), false);
  assert.match(text, /REDACTED/);
});

test("maps 401, 403, network, and TLS failures to user-facing connection states", () => {
  assert.equal(classifyConnectionError(new WorkerApiError(401)).code, "token_mismatch");
  assert.equal(classifyConnectionError(new WorkerApiError(403, "worker_not_paired")).code, "worker_unpaired");
  assert.equal(classifyConnectionError(new Error("fetch failed: ECONNREFUSED")).code, "network");
  assert.equal(classifyConnectionError(new Error("unable to verify TLS certificate")).code, "tls");
});

test("reports Native, Headless, and Unknown execution distinctly", () => {
  assert.equal(executionMode(true), "native");
  assert.equal(executionMode(false), "headless");
  assert.equal(executionMode(undefined), "unknown");
});
