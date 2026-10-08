import assert from "node:assert/strict";
import test from "node:test";

import { AsyncTaskPool, fillTaskPool, WorkerClaimGate } from "../lib/task-pool.mjs";

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

test("maintenance drain closes the claim gate atomically and waits for claimed work", async () => {
  const claimResult = deferred();
  const taskResult = deferred();
  const pool = new AsyncTaskPool({ limit: 4 });
  const gate = new WorkerClaimGate();
  gate.setIdleWaiter(() => pool.waitForIdle());
  let claims = 0;

  const filling = fillTaskPool(
    pool,
    async () => { claims += 1; return claimResult.promise; },
    async () => taskResult.promise,
    new AbortController().signal,
    gate,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const draining = gate.drain();
  assert.equal(gate.draining, true);
  assert.equal(claims, 1);

  claimResult.resolve({ task: { id: "leased-before-drain" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pool.snapshotIds(), ["leased-before-drain"]);
  assert.equal(claims, 1, "no second claim starts after maintenance closes the gate");

  taskResult.resolve();
  await Promise.all([filling, draining]);
  assert.equal(pool.size, 0);
  assert.equal(gate.draining, true, "the gate stays closed until updater explicitly resumes it");

  gate.reopen();
  assert.equal(gate.draining, false);
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
