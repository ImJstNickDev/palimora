/** Fixed lanes partition existing budgets; completing a source immediately frees
 * its lane. A non-ZIP source is a barrier (metadata cache/dependency semantics). */
export function sourceBudgets(
  sources: number,
  parsers: number,
  commits: number,
) {
  const count = Math.min(sources, parsers, commits);
  return Array.from({ length: count }, (_, i) => ({
    parsers: Math.floor(parsers / count) + (i < parsers % count ? 1 : 0),
    commits: Math.floor(commits / count) + (i < commits % count ? 1 : 0),
  }));
}
export async function scheduleSources<T extends { path: string }>(
  sources: T[],
  budgets: ReturnType<typeof sourceBudgets>,
  run: (
    source: T,
    budget: ReturnType<typeof sourceBudgets>[number],
  ) => Promise<void>,
  exclusive: (source: T) => boolean = () => false,
) {
  async function zipGroup(group: T[]) {
    let next = 0;
    let failure: unknown;
    await Promise.all(
      sourceBudgets(
        Math.min(group.length, budgets.length),
        budgets.reduce((n, b) => n + b.parsers, 0),
        budgets.reduce((n, b) => n + b.commits, 0),
      ).map(async (budget) => {
        while (!failure && next < group.length) {
          const source = group[next++];
          try {
            await run(source, budget);
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    // Never release the leader while another lane is still draining.
    if (failure) throw failure;
  }
  let group: T[] = [];
  for (const source of sources) {
    if (source.path.endsWith(".zip") && !exclusive(source)) group.push(source);
    else {
      await zipGroup(group);
      group = [];
      await run(source, {
        parsers: budgets.reduce((n, b) => n + b.parsers, 0),
        commits: budgets.reduce((n, b) => n + b.commits, 0),
      });
    }
  }
  await zipGroup(group);
}

/** FIFO shared permits. Hold until the source's ordered ACK, bounding even
 * completed groups retained behind an earlier slow group. */
export class IngestSlots {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) {}
  async acquire() {
    if (this.active >= this.limit)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
