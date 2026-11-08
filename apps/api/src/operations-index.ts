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
    if (!locked) return;
    const row = (
      await db.query("SELECT * FROM operations_index WHERE kind=$1", [kind])
    ).rows[0];
    if (
      row.paused ||
      (row.retry_at && new Date(row.retry_at).getTime() > Date.now())
    )
      return;
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
    } catch {
      const error =
        kind === "search" ? "SEARCH_INDEX_FAILED" : "CATALOG_PROJECTION_FAILED";
      await db.query(
        "UPDATE operations_index SET state='failed',error=$2,retry_at=now()+interval '1 minute',updated_at=now() WHERE kind=$1",
        [kind, error],
      );
      await db.query(
        "INSERT INTO operations_index_runs(kind,started_at,processed,error) VALUES($1,$2,0,$3)",
        [kind, started, error],
      );
    }
  } finally {
    if (locked)
      await db.query("SELECT pg_advisory_unlock($1)", [
        kind === "catalog" ? 70210472 : 70210473,
      ]);
    db.release();
  }
}
