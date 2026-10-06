import assert from "node:assert/strict";
import test from "node:test";

import { AsyncTaskPool, fillTaskPool } from "../lib/task-pool.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("AsyncTaskPool runs independent tasks concurrently up to the configured limit", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const sizes = [];
  const pool = new AsyncTaskPool({ limit: 2, onSizeChange: (size) => sizes.push(size) });

  assert.equal(pool.start("a", () => gates[0].promise), true);
  assert.equal(pool.start("b", () => gates[1].promise), true);
  assert.equal(pool.start("c", () => gates[2].promise), false);
  assert.equal(pool.size, 2);
  assert.deepEqual(pool.snapshotIds().sort(), ["a", "b"]);

  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.size, 1);
  assert.equal(pool.start("c", () => gates[2].promise), true);
  assert.equal(pool.size, 2);

  gates[1].resolve();
  gates[2].resolve();
  await pool.waitForIdle();
  assert.equal(pool.size, 0);
  assert.equal(sizes.at(-1), 0);
});

test("AsyncTaskPool rejects a duplicate live task id", async () => {
  const gate = deferred();
  const pool = new AsyncTaskPool({ limit: 4 });
  assert.equal(pool.start("same-task", () => gate.promise), true);
  assert.equal(pool.start("same-task", async () => {}), false);
  gate.resolve();
  await pool.waitForIdle();
});

test("fillTaskPool claims repeatedly until capacity is full", async () => {
  const gates = new Map();
  const queued = ["a", "b", "c", "d"];
  const pool = new AsyncTaskPool({ limit: 3 });

  const result = await fillTaskPool(
    pool,
    async () => queued.length ? { task: { id: queued.shift() } } : {},
    async (task) => {
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, { started: 3, active: 3, capacity: 3 });
  assert.deepEqual(pool.snapshotIds().sort(), ["a", "b", "c"]);
  assert.deepEqual(queued, ["d"]);

  for (const gate of gates.values()) gate.resolve();
  await pool.waitForIdle();
});

test("fillTaskPool stops when Cloud repeats an already-active lease", async () => {
  const gate = deferred();
  const pool = new AsyncTaskPool({ limit: 3 });
  pool.start("a", () => gate.promise);

  let claims = 0;
  const result = await fillTaskPool(
    pool,
    async () => {
      claims += 1;
      return { task: { id: "a" } };
    },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(result.started, 0);
  assert.equal(claims, 1);
  gate.resolve();
  await pool.waitForIdle();
});

test("task runner errors are contained and release capacity", async () => {
  const errors = [];
  const pool = new AsyncTaskPool({
    limit: 1,
    onTaskError: (error, id) => errors.push([id, error.message]),
  });

  assert.equal(pool.start("bad", async () => { throw new Error("boom"); }), true);
  await pool.waitForIdle();
  assert.deepEqual(errors, [["bad", "boom"]]);
  assert.equal(pool.size, 0);
});
