import assert from "node:assert/strict";
import test from "node:test";

import { CONNECTOR_BUILD_HASH, createBuildFingerprint } from "../lib/build-identity.mjs";
import { publicRuntimeStatus } from "../lib/connector-config.mjs";

test("runtime build fingerprint is stable and identifies the loaded package sources", () => {
  assert.match(CONNECTOR_BUILD_HASH, /^[a-f0-9]{64}$/u);
  assert.equal(createBuildFingerprint(), CONNECTOR_BUILD_HASH);
  assert.equal(publicRuntimeStatus({ currentBuildHash: CONNECTOR_BUILD_HASH }).currentBuildHash, CONNECTOR_BUILD_HASH);
  assert.equal(publicRuntimeStatus({ currentBuildHash: "not-a-hash" }).currentBuildHash, null);
});
