import assert from "node:assert/strict";
import test from "node:test";

import { publicRuntimeStatus, snapshotConnectorInput } from "../lib/connector-config.mjs";
import { normalizeConfig } from "../lib/protocol.mjs";

test("normalizeConfig defaults outer worker concurrency to 24", () => {
  const config = normalizeConfig({ endpoint: "https://example.com/api/worker" });
  assert.equal(config.maxConcurrentTasks, 24);
});

test("normalizeConfig accepts 1 through 24 outer worker tasks", () => {
  assert.equal(normalizeConfig({
    endpoint: "https://example.com/api/worker",
    maxConcurrentTasks: 1,
  }).maxConcurrentTasks, 1);
  assert.equal(normalizeConfig({
    endpoint: "https://example.com/api/worker",
    maxConcurrentTasks: 24,
  }).maxConcurrentTasks, 24);
});

test("normalizeConfig rejects outer concurrency outside 1 through 24", () => {
  assert.throws(() => normalizeConfig({
    endpoint: "https://example.com/api/worker",
    maxConcurrentTasks: 0,
  }), /1–24/);
  assert.throws(() => normalizeConfig({
    endpoint: "https://example.com/api/worker",
    maxConcurrentTasks: 25,
  }), /1–24/);
});

test("snapshotConnectorInput preserves maxConcurrentTasks wrappers", () => {
  const snapshot = snapshotConnectorInput({
    maxConcurrentTasks: { get: () => 18 },
  });
  assert.equal(snapshot.maxConcurrentTasks, 18);
});

test("public runtime status reports active task usage", () => {
  const status = publicRuntimeStatus({
    activeTaskCount: 7,
    maxConcurrentTasks: 24,
  });
  assert.equal(status.activeTaskCount, 7);
  assert.equal(status.maxConcurrentTasks, 24);
});
