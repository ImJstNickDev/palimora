const fs = require("node:fs"),
  { pool } = require("../apps/api/dist/db");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Private fixture required");
let stop = false;
process.on("SIGTERM", () => (stop = true));
(async () => {
  while (!stop && !fs.existsSync("/results/end-to-end.json")) {
    const start = performance.now();
    const rows = (
      await pool.query(
        `SELECT c.relname,pg_total_relation_size(c.oid)::text bytes,pg_indexes_size(c.oid)::text index_bytes,s.n_live_tup,s.n_dead_tup FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE n.nspname=current_schema() AND c.relname IN ('catalog_pending','catalog_snapshot_pending','catalog_text_pending')`,
      )
    ).rows;
    const wal = (await pool.query("SELECT wal_bytes FROM pg_stat_wal")).rows[0]
      .wal_bytes;
    fs.appendFileSync(
      "/results/p3-capacity.jsonl",
      JSON.stringify({
        at: Date.now(),
        queues: rows,
        wal_bytes: wal,
        probe_ms: performance.now() - start,
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
