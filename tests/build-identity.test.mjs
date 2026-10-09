import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONNECTOR_BUILD_HASH, createBuildFingerprint } from "../lib/build-identity.mjs";
import { publicRuntimeStatus } from "../lib/connector-config.mjs";

test("runtime build fingerprint is stable and identifies the loaded package sources", () => {
  assert.match(CONNECTOR_BUILD_HASH, /^[a-f0-9]{64}$/u);
  assert.equal(createBuildFingerprint(), CONNECTOR_BUILD_HASH);
  assert.equal(publicRuntimeStatus({ currentBuildHash: CONNECTOR_BUILD_HASH }).currentBuildHash, CONNECTOR_BUILD_HASH);
  assert.equal(publicRuntimeStatus({ currentBuildHash: "not-a-hash" }).currentBuildHash, null);
});

test("fingerprint covers bootstrap, routing and native execution and stays fixed after load", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsw-build-identity-"));
  const source = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const name of ["package.json", "index.js", "client.js", "lib"]) {
      await cp(join(source, name), join(root, name), { recursive: true });
    }
    const original = createBuildFingerprint(root);
    assert.equal(original, CONNECTOR_BUILD_HASH);
    for (const name of ["lib/bridge-bootstrap.mjs", "lib/wake-coordinator.mjs", "lib/native-session.mjs", "client.js"]) {
      const path = join(root, name);
      const bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n// identity regression\n")]));
      assert.notEqual(createBuildFingerprint(root), original, name);
      assert.equal(CONNECTOR_BUILD_HASH, original, "loaded identity never follows later disk changes");
      await writeFile(path, bytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
