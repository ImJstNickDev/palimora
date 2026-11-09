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
) {
  async function zipGroup(group: T[]) {
    let next = 0;
    let failure: unknown;
    await Promise.all(
      budgets.map(async (budget) => {
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
    if (source.path.endsWith(".zip")) group.push(source);
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
