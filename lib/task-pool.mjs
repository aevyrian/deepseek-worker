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

export async function fillTaskPool(pool, claim, startTask, signal) {
  if (!(pool instanceof AsyncTaskPool)) throw new Error("pool must be an AsyncTaskPool");
  if (typeof claim !== "function" || typeof startTask !== "function") {
    throw new Error("claim and startTask must be functions");
  }

  let started = 0;
  while (!signal?.aborted && pool.size < pool.limit) {
    const claimed = await claim();
    const task = claimed?.task;
    if (!task) break;

    const id = typeof task.id === "string" ? task.id.trim() : "";
    if (!id) throw new Error("Claimed task is missing id");

    const accepted = pool.start(id, () => startTask(task));
    if (!accepted) {
      // A duplicate active task means the Cloud repeated a live lease. Stop
      // filling this cycle instead of spinning on the same claim response.
      break;
    }
    started += 1;
  }

  return { started, active: pool.size, capacity: pool.limit };
}
