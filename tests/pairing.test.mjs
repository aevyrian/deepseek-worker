import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { credentialValue, hashWorkerToken, pairingRequest } from "../lib/pairing.mjs";

test("credentialValue accepts the current Harness resolve shape", () => {
  assert.equal(credentialValue({ value: "secret", source: "file" }), "secret");
  assert.equal(credentialValue("legacy-string"), "legacy-string");
  assert.equal(credentialValue(undefined), "");
});

test("hashWorkerToken returns a deterministic SHA-256 hash without exposing the token", () => {
  const token = "a".repeat(64); const hash = hashWorkerToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/); assert.notEqual(hash, token);
});

test("pair/start sends only the token hash and no Bearer secret", async () => {
  const server = createServer((request, response) => { let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ url: request.url, auth: request.headers.authorization || null, body: JSON.parse(body), state: "pending", code: "ABCD-EFGH", approval_url: "https://example.test/pair?code=ABCD-EFGH" })); });
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { const port = server.address().port; const token = "b".repeat(64); const config = { endpoint: `http://127.0.0.1:${port}/api/worker`, workerId: "worker-test" };
    const result = await pairingRequest(config, undefined, "start", { token_hash: hashWorkerToken(token), hostname: "test-host", workspace_allowlist: ["workspace-a"] }, new AbortController().signal);
    assert.equal(result.url, "/api/pair/start"); assert.equal(result.auth, null); assert.equal(result.body.worker_id, "worker-test"); assert.equal(result.body.token_hash, hashWorkerToken(token)); assert.equal(JSON.stringify(result.body).includes(token), false);
  } finally { server.close(); await once(server, "close"); }
});

test("pair/status authenticates with the local per-worker credential", async () => {
  const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ auth: request.headers.authorization, body: JSON.parse(body), state: "paired" })); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { const port = server.address().port; const token = "c".repeat(64); const config = { endpoint: `http://127.0.0.1:${port}/api/worker`, workerId: "worker-test" }; const result = await pairingRequest(config, token, "status", {}, new AbortController().signal); assert.equal(result.auth, `Bearer ${token}`); assert.equal(result.body.worker_id, "worker-test");
  } finally { server.close(); await once(server, "close"); }
});
