import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  PairingApiError,
  classifyPairingError,
  cloudBaseFromWorkerEndpoint,
  credentialInfo,
  credentialValue,
  hashWorkerToken,
  isTerminalPairingState,
  normalizeApprovalUrl,
  normalizePairingState,
  pairingRequest,
  setupUrlFromWorkerEndpoint,
} from "../lib/pairing.mjs";

test("credentialValue uses the current Harness resolve object shape", () => {
  assert.equal(credentialValue({ value: "secret", source: "file" }), "secret");
  assert.equal(credentialValue(undefined), "");
  assert.throws(() => credentialValue("legacy-string"), /unexpected value shape/);
  assert.throws(() => credentialValue({ value: "secret" }), /unexpected value shape/);
});

test("credentialInfo validates official describe metadata without exposing a value", () => {
  assert.deepEqual(
    credentialInfo({ configured: true, source: "file", writable: true }),
    { configured: true, source: "file", writable: true },
  );
  assert.deepEqual(
    credentialInfo({ configured: false, writable: true }),
    { configured: false, writable: true },
  );
  assert.throws(() => credentialInfo({ configured: true }), /unexpected value shape/);
});

test("hashWorkerToken returns deterministic SHA-256 without exposing the token", () => {
  const token = "a".repeat(64);
  const hash = hashWorkerToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
});

test("Cloud setup URL is derived from the Worker endpoint without secrets", () => {
  const endpoint = "https://deepseek-worker.sxfdgan.chatgpt.site/api/worker";
  assert.equal(cloudBaseFromWorkerEndpoint(endpoint), "https://deepseek-worker.sxfdgan.chatgpt.site");
  assert.equal(setupUrlFromWorkerEndpoint(endpoint), "https://deepseek-worker.sxfdgan.chatgpt.site/setup");
});

test("approval URLs must be credential-free HTTPS", () => {
  assert.equal(
    normalizeApprovalUrl("https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1"),
    "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=PAIR-1",
  );
  assert.throws(() => normalizeApprovalUrl("http://example.test/setup"), /credential-free HTTPS/);
  assert.throws(() => normalizeApprovalUrl("https://user:pass@example.test/setup"), /credential-free HTTPS/);
  assert.equal(normalizeApprovalUrl(null), null);
});

test("pairing state normalization recognizes pending, paired, expired, revoked and terminal states", () => {
  assert.equal(normalizePairingState("active"), "paired");
  assert.equal(normalizePairingState("pending"), "pending");
  assert.equal(normalizePairingState("expired"), "expired");
  assert.equal(normalizePairingState("revoked"), "revoked");
  assert.equal(normalizePairingState("something-new"), "error");
  assert.equal(isTerminalPairingState("pending"), false);
  assert.equal(isTerminalPairingState("paired"), true);
  assert.equal(isTerminalPairingState("expired"), true);
  assert.equal(isTerminalPairingState("revoked"), true);
});

test("pair/start sends only token_hash and never sends the raw Token or Bearer secret", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        url: request.url,
        auth: request.headers.authorization || null,
        body: JSON.parse(body),
        state: "pending",
        code: "ABCD-EFGH",
        approval_url: "https://deepseek-worker.sxfdgan.chatgpt.site/setup?pair=ABCD-EFGH",
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const token = "b".repeat(64);
    const config = { endpoint: `http://127.0.0.1:${port}/api/worker`, workerId: "worker-test" };
    const result = await pairingRequest(config, undefined, "start", {
      token_hash: hashWorkerToken(token),
      hostname: "test-host",
      workspace_allowlist: ["workspace-a"],
      client_version: "0.3.1",
    }, new AbortController().signal);
    assert.equal(result.url, "/api/pair/start");
    assert.equal(result.auth, null);
    assert.equal(result.body.worker_id, "worker-test");
    assert.equal(result.body.token_hash, hashWorkerToken(token));
    assert.equal(JSON.stringify(result.body).includes(token), false);
    assert.equal(result.url.includes(token), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("pair/status authenticates with the local per-worker credential", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        auth: request.headers.authorization,
        body: JSON.parse(body),
        state: "paired",
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const token = "c".repeat(64);
    const config = { endpoint: `http://127.0.0.1:${port}/api/worker`, workerId: "worker-test" };
    const result = await pairingRequest(config, token, "status", {}, new AbortController().signal);
    assert.equal(result.auth, `Bearer ${token}`);
    assert.equal(result.body.worker_id, "worker-test");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("pairing errors distinguish expired and unavailable APIs", () => {
  assert.deepEqual(
    classifyPairingError(new PairingApiError(410, "pair_expired")),
    { code: "pairing_expired", state: "expired", message: "连接请求已过期，请重新点击安装并连接。" },
  );
  assert.deepEqual(
    classifyPairingError(new PairingApiError(404, "not_found")),
    { code: "pairing_api_unavailable", state: "error", message: "Cloud 配对 API 当前不可用。" },
  );
});

test("revoked pairing is terminal", () => {
  const result = classifyPairingError(new PairingApiError(403, "worker_revoked"));
  assert.equal(result.code, "pairing_revoked");
  assert.equal(result.state, "revoked");
  assert.equal(isTerminalPairingState(result.state), true);
});
