export class AsyncTaskPool {
  constructor({ limit = 1, onSizeChange = () => {}, onTaskError = () => {} } = {}) {
    this.active = new Map();
    this.onSizeChange = onSizeChange;
    this.onTaskError = onTaskError;
    this.setLimit(limit);
  }

  get size() {
    return this.active.size;
  }

  has(taskId) {
    return this.active.has(taskId);
  }

  setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new Error("Task pool limit must be an integer between 1 and 64");
    }
    this.limit = limit;
  }

  start(taskId, runner) {
    if (typeof taskId !== "string" || !taskId.trim()) throw new Error("Task id is required");
    if (typeof runner !== "function") throw new Error("Task runner must be a function");
    if (this.active.size >= this.limit || this.active.has(taskId)) return false;

    const id = taskId.trim();
    const promise = Promise.resolve()
      .then(() => runner())
      .catch((error) => {
        this.onTaskError(error, id);
      })
      .finally(() => {
        this.active.delete(id);
        this.onSizeChange(this.active.size);
      });

    this.active.set(id, promise);
    this.onSizeChange(this.active.size);
    return true;
  }

  async waitForIdle() {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  snapshotIds() {
    return [...this.active.keys()];
  }
}

// Serializes the claim-and-register window with maintenance drains. A claim
// already in flight is allowed to register its lease before drain completes;
// after close() returns, no new claim can begin.
export class WorkerClaimGate {
  constructor() {
    this.draining = false;
    this.inFlight = 0;
    this.waiters = [];
    this.waitForIdle = async () => {};
  }

  setIdleWaiter(waitForIdle) {
    if (typeof waitForIdle !== "function") throw new TypeError("waitForIdle must be a function");
    this.waitForIdle = waitForIdle;
  }

  async claimAndAccept(claim, accept) {
    if (this.draining) return { entered: false, claimed: null, accepted: false };
    this.inFlight += 1;
    try {
      const claimed = await claim();
      const accepted = await accept(claimed);
      return { entered: true, claimed, accepted: accepted === true };
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.waiters.splice(0)) resolve();
      }
    }
  }

  async close() {
    this.draining = true;
    if (this.inFlight === 0) return;
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  async drain() {
    await this.close();
    await this.waitForIdle();
  }

  reopen() {
    this.draining = false;
  }
}

export async function fillTaskPool(pool, claim, startTask, signal, claimGate = null) {
  if (!(pool instanceof AsyncTaskPool)) throw new Error("pool must be an AsyncTaskPool");
  if (typeof claim !== "function" || typeof startTask !== "function") {
    throw new Error("claim and startTask must be functions");
  }

  let started = 0;
  while (!signal?.aborted && pool.size < pool.limit) {
    let accepted = false;
    const registerClaim = (claimed) => {
      const task = claimed?.task;
      if (!task) return false;

      const id = typeof task.id === "string" ? task.id.trim() : "";
      if (!id) throw new Error("Claimed task is missing id");

      accepted = pool.start(id, () => startTask(task));
      return accepted;
    };
    const result = claimGate
      ? await claimGate.claimAndAccept(claim, registerClaim)
      : { entered: true, claimed: await claim(), accepted: false };
    if (!result.entered) break;
    const task = result.claimed?.task;
    if (!task) break;

    if (!(claimGate ? result.accepted : registerClaim(result.claimed))) {
      // A duplicate active task means the Cloud repeated a live lease. Stop
      // filling this cycle instead of spinning on the same claim response.
      break;
    }
    started += 1;
  }

  return { started, active: pool.size, capacity: pool.limit };
}
