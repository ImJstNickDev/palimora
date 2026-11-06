/** Bounded parallel groups, ordered work dependencies and FIFO acknowledgements.
 * DB receipts, not this in-memory queue, are the resume authority. */
export class IngestPipeline {
  private queue: { done: boolean; promise: Promise<void> }[] = [];
  private dependencies = new Map<string, Promise<void>>();
  private failure: any;
  constructor(
    private limit: number,
    private acknowledge: () => void,
    private failed: (error: any) => void = () => {},
  ) {}
  async add(keys: string[], execute: () => Promise<void>) {
    while (this.queue.length >= this.limit && !this.failure)
      await this.queue[0].promise;
    if (this.failure) throw this.failure;
    const preceding = [
      ...new Set(keys.map((k) => this.dependencies.get(k)).filter(Boolean)),
    ];
    const task = { done: false, promise: Promise.resolve() };
    task.promise = Promise.all(preceding)
      .then(async () => {
        if (this.failure) return;
        await execute();
        task.done = true;
      })
      .catch((error) => {
        if (!this.failure) {
          this.failure = error;
          this.failed(error);
        }
      })
      .finally(() => {
        for (const key of keys)
          if (this.dependencies.get(key) === task.promise)
            this.dependencies.delete(key);
        while (this.queue[0]?.done) {
          this.queue.shift();
          this.acknowledge();
        }
      });
    this.queue.push(task);
    for (const key of keys) this.dependencies.set(key, task.promise);
  }
  async drain() {
    await Promise.all(this.queue.map((t) => t.promise));
    if (this.failure) throw this.failure;
  }
}
