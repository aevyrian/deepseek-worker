import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyConnectionError,
  executionMode,
  publicRuntimeStatus,
  redactSecret,
  snapshotConnectorInput,
  workerTokenFromBytes,
  workspaceEntriesToAllowlist,
} from "../lib/connector-config.mjs";
import { WorkerApiError, normalizeConfig } from "../lib/protocol.mjs";

test("validates workspace IDs, absolute paths, and duplicates", () => {
  assert.throws(() => workspaceEntriesToAllowlist([{ id: "", path: "E:/Projects/a" }]), /ID/);
  assert.throws(() => workspaceEntriesToAllowlist([{ id: "a", path: "relative/path" }]), /absolute/);
  assert.throws(() => workspaceEntriesToAllowlist([{ id: "a", path: "E:/Projects/a" }, { id: "a", path: "E:/Projects/b" }]), /Duplicate/);
  assert.deepEqual(workspaceEntriesToAllowlist([{ id: "novel", path: "E:/项目/deep" }]), { novel: "E:\\项目\\deep" });
});

test("normalizes Windows and POSIX absolute workspace paths while requiring HTTPS", () => {
  const windows = normalizeConfig({ endpoint: "https://example.test/api/worker", workspaceAllowlist: { win: "E:/Projects/repo" } });
  assert.equal(windows.workspaceAllowlist.win, "E:\\Projects\\repo");
  const posix = normalizeConfig({ endpoint: "https://example.test/api/worker", workspaceAllowlist: { unix: "/srv/repo" } });
  assert.equal(posix.workspaceAllowlist.unix, "/srv/repo");
  assert.throws(() => normalizeConfig({ endpoint: "http://example.test/api/worker" }), /HTTPS/);
});

test("generates a 64-hex-character worker token from at least 32 random bytes", () => {
  const token = workerTokenFromBytes(Uint8Array.from({ length: 32 }, (_, index) => index));
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.throws(() => workerTokenFromBytes(new Uint8Array(31)), /32 bytes/);
});

test("public status never returns the credential value", () => {
  const secret = "super-secret-value";
  const status = publicRuntimeStatus({ connector: "loaded", execution: "native", credential: secret, worker: "online" }, { credentialConfigured: true, workerId: "w", workspaceCount: 1 });
  assert.equal(status.credential, "configured");
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(Object.hasOwn(status, "token"), false);
});

test("connector config serialization ignores token-shaped input", () => {
  const secret = "should-never-serialize";
  const snapshot = snapshotConnectorInput({ endpoint: "https://example.test/api/worker", workspaceAllowlist: {}, LOCAL_WORKER_TOKEN: secret, token: secret });
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(Object.hasOwn(snapshot, "LOCAL_WORKER_TOKEN"), false);
  assert.equal(Object.hasOwn(snapshot, "token"), false);
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

test("reports Native Harness separately from Headless fallback", () => {
  assert.equal(executionMode(true), "native");
  assert.equal(executionMode(false), "headless");
});
