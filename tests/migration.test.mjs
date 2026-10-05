import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_ORCHESTRATOR_BUNDLE_NAMES,
  migrateLegacyOrchestratorBundles,
} from "../lib/migration.mjs";

const LEGACY = "@local/dsh-orchestrator-worker-preset";

test("legacy orchestrator migration is a no-op when profile is already clean", async () => {
  const calls = [];
  const result = await migrateLegacyOrchestratorBundles({
    listBundles: async () => [{ name: "deepseek-worker-connector", enabled: true }],
    setBundleEnabled: async (...args) => { calls.push(["set", ...args]); },
    removeBundle: async (...args) => { calls.push(["remove", ...args]); },
  });
  assert.equal(result.status, "clean");
  assert.deepEqual(calls, []);
});

test("enabled legacy bundle is disabled then removed live", async () => {
  const calls = [];
  const result = await migrateLegacyOrchestratorBundles({
    listBundles: async () => [{ name: LEGACY, enabled: true, removable: true, installed: true }],
    setBundleEnabled: async (name, enabled) => {
      calls.push(["set", name, enabled]);
      return { application: "applied", changed: true };
    },
    removeBundle: async (name) => {
      calls.push(["remove", name]);
      return { application: "applied", changed: true };
    },
  });
  assert.equal(result.status, "cleaned");
  assert.deepEqual(result.removed, [LEGACY]);
  assert.deepEqual(calls, [["set", LEGACY, false], ["remove", LEGACY]]);
});

test("non-HMR legacy bundle is disabled and cleanup waits for one restart", async () => {
  const calls = [];
  const result = await migrateLegacyOrchestratorBundles({
    listBundles: async () => [{ name: LEGACY, enabled: true, removable: true, installed: true }],
    setBundleEnabled: async (name, enabled) => {
      calls.push(["set", name, enabled]);
      return { application: "restart-required", changed: true };
    },
    removeBundle: async (name) => {
      calls.push(["remove", name]);
      return { application: "restart-required", changed: true };
    },
  });
  assert.equal(result.status, "restart-required");
  assert.deepEqual(result.pending, [{ name: LEGACY, reason: "restart-required" }]);
  assert.deepEqual(calls, [["set", LEGACY, false]]);
});

test("already disabled legacy bundle is removed directly", async () => {
  const calls = [];
  const result = await migrateLegacyOrchestratorBundles({
    listBundles: async () => [{ name: LEGACY, enabled: false, removable: true, installed: true }],
    setBundleEnabled: async () => { throw new Error("must not be called"); },
    removeBundle: async (name) => {
      calls.push(name);
      return { application: "restart-required", changed: true };
    },
  });
  assert.equal(result.status, "cleaned");
  assert.deepEqual(result.removed, [LEGACY]);
  assert.deepEqual(calls, [LEGACY]);
});

test("bundle-in-use is reported as pending instead of breaking Connector startup", async () => {
  const result = await migrateLegacyOrchestratorBundles({
    listBundles: async () => [{ name: LEGACY, enabled: false, removable: true, installed: true }],
    removeBundle: async () => ({
      application: "failed",
      changed: false,
      error: { code: "bundle-in-use" },
    }),
  });
  assert.equal(result.status, "restart-required");
  assert.deepEqual(result.pending, [{ name: LEGACY, reason: "bundle-in-use" }]);
});

test("migration supports both historical legacy package names", () => {
  assert.deepEqual(LEGACY_ORCHESTRATOR_BUNDLE_NAMES, [
    "@local/dsh-orchestrator-worker-preset",
    "dsh-orchestrator-worker-preset",
  ]);
});
