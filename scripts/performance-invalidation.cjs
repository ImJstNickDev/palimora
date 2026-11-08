// Rollback-only correctness probe; never leaves graph/catalog changes behind.
const { pool } = require("../apps/api/dist/db");
const { projectGraph } = require("../apps/api/dist/catalog-bibliography");
const fs = require("node:fs");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
(async () => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(70210408)");
    const before = Number(
      (await db.query("SELECT count(*) n FROM catalog_pending")).rows[0].n,
    );
    const t = performance.now();
    await db.query("UPDATE archive_tags SET evidence=evidence WHERE false");
    const marker = (
      await db.query("SELECT count(*)::int n FROM catalog_graph_pending")
    ).rows[0].n;
    await projectGraph(db);
    const after = Number(
      (await db.query("SELECT count(*) n FROM catalog_pending")).rows[0].n,
    );
    const result = {
      before,
      marker_after_zero_row_update: marker,
      after,
      seconds: (performance.now() - t) / 1000,
      rolled_back: true,
    };
    await db.query("ROLLBACK");
    fs.writeFileSync("/results/invalidation.json", JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
