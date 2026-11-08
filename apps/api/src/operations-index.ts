import { pool } from "./db";
/** Wrap the existing projection ticks; SQL queues and transactions stay authoritative. */
export async function runProjection(
  kind: "catalog" | "search",
  project: () => Promise<number | void>,
) {
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (
      await db.query("SELECT pg_try_advisory_lock($1) AS yes", [
        kind === "catalog" ? 70210472 : 70210473,
      ])
    ).rows[0].yes;
    if (!locked) return 0;
    const row = (
      await db.query("SELECT * FROM operations_index WHERE kind=$1", [kind])
    ).rows[0];
    if (
      row.paused ||
      (row.retry_at && new Date(row.retry_at).getTime() > Date.now())
    )
      return 0;
    const started = new Date();
    await db.query(
      "UPDATE operations_index SET state='running',updated_at=now() WHERE kind=$1",
      [kind],
    );
    try {
      const processed = (await project()) ?? 0;
      await db.query(
        "UPDATE operations_index SET state='idle',processed=processed+$2,error=NULL,retry_at=NULL,updated_at=now() WHERE kind=$1",
        [kind, processed],
      );
      if (processed || row.error)
        await db.query(
          "INSERT INTO operations_index_runs(kind,started_at,processed) VALUES($1,$2,$3)",
          [kind, started, processed],
        );
      return processed;
    } catch (cause) {
      const completed = (cause as { processed?: number })?.processed;
      const processed =
        Number.isSafeInteger(completed) && completed! > 0 ? completed! : 0;
      const error =
        kind === "search" ? "SEARCH_INDEX_FAILED" : "CATALOG_PROJECTION_FAILED";
      await db.query(
        "UPDATE operations_index SET state='failed',processed=processed+$3,error=$2,retry_at=now()+interval '1 minute',updated_at=now() WHERE kind=$1",
        [kind, error, processed],
      );
      await db.query(
        "INSERT INTO operations_index_runs(kind,started_at,processed,error) VALUES($1,$2,$4,$3)",
        [kind, started, error, processed],
      );
      return 0;
    }
  } finally {
    if (locked)
      await db.query("SELECT pg_advisory_unlock($1)", [
        kind === "catalog" ? 70210472 : 70210473,
      ]);
    db.release();
  }
}

export function projectionSettings() {
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw Error(`Invalid ${name}`);
    return value;
  };
  return {
    catalogBatch: integer("PROJECTION_CATALOG_BATCH", 20, 256),
    historicalBatch: integer("PROJECTION_HISTORICAL_BATCH", 20, 256),
    textBatch: integer("PROJECTION_TEXT_BATCH", 16, 256),
    concurrency: integer("PROJECTION_CONCURRENCY", 2, 2),
    budgetMs: integer("PROJECTION_BUDGET_MS", 100, 5000),
    idleMs: integer("PROJECTION_IDLE_MS", 1000, 60000),
    textHighWater: integer("PROJECTION_TEXT_HIGH_WATER", 2048, 1000000),
  };
}

/** One bounded scheduler for the existing engines. No in-memory claims/checkpoints. */
export function startProjections(
  catalog: (current: number, historical: number) => Promise<number>,
  search: (limit: number, stopped: () => boolean) => Promise<number>,
) {
  const settings = projectionSettings();
  let stopped = false;
  const wakes = new Set<() => void>();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakes.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakes.add(done);
    });
  let serial = Promise.resolve();
  const step = async (kind: "catalog" | "search") => {
    if (stopped) return 0;
    return runProjection(kind, async () => {
      if (stopped) return 0;
      if (kind === "search") return search(settings.textBatch, () => stopped);
      // Bound downstream backlog without withholding historical materialization.
      const full = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM catalog_text_pending OFFSET $1 LIMIT 1) AS full",
          [settings.textHighWater - 1],
        )
      ).rows[0].full;
      return catalog(
        full ? 0 : settings.catalogBatch,
        settings.historicalBatch,
      );
    });
  };
  const lane = async (kind: "catalog" | "search") => {
    let deadline = performance.now() + settings.budgetMs;
    while (!stopped) {
      let processed = 0;
      try {
        if (settings.concurrency === 2) processed = await step(kind);
        else {
          const turn = serial.then(() => step(kind));
          serial = turn.then(
            () => {},
            () => {},
          );
          processed = await turn;
        }
      } catch {
        console.error(
          JSON.stringify({ event: "projection_scheduler_failed", kind }),
        );
      }
      if (stopped) break;
      if (!processed) await wait(settings.idleMs);
      else if (performance.now() >= deadline) {
        // Budget is cooperative: finish the atomic batch, then yield to I/O/HTTP.
        await wait(0);
        const { processingPolicy } = await import("./maintenance");
        const policy = await processingPolicy().catch(() => ({
          projectionPasses: 1,
        }));
        deadline =
          performance.now() + settings.budgetMs * policy.projectionPasses;
      }
    }
  };
  const finished = Promise.all([lane("catalog"), lane("search")]);
  return async () => {
    stopped = true;
    for (const wake of wakes) wake();
    await finished;
  };
}
