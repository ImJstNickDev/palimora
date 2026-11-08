const { Pool } = require("pg");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test DB required");
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const ids = (
    await db.query("SELECT id FROM archive_work_heads ORDER BY id LIMIT 256")
  ).rows.map((r) => r.id);
  const params = ["queue119_archive05.zip", ids];
  const sql = {
    before:
      "SELECT id,work_id,locator,parser,fingerprint FROM archive_observations WHERE source_path=$1 AND work_id=ANY($2::uuid[])",
    after: `SELECT o.id,o.work_id,e.locator,r.name AS parser,encode(o.result_hash,'hex') AS fingerprint FROM unnest($2::uuid[]) ids(work_id) JOIN LATERAL (SELECT * FROM archive_observation_data o WHERE o.work_id=ids.work_id OFFSET 0) o ON true JOIN archive_entries e ON e.id=o.entry_id JOIN archive_paths p ON p.id=e.path_id JOIN archive_parsers r ON r.id=o.parser_id WHERE p.path=$1`,
  };
  const result = {};
  let reference;
  for (const [name, q] of Object.entries(sql)) {
    let rows;
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      rows = (await db.query(q, params)).rows;
      if (i >= 2) samples.push(performance.now() - t);
    }
    const sorted = JSON.stringify(
      rows.sort((a, b) => a.id.localeCompare(b.id)),
    );
    if (reference && reference !== sorted) throw Error("Different result");
    reference = sorted;
    result[name] = {
      samples_ms: samples,
      rows: rows.length,
      plan: (
        await db.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + q, params)
      ).rows[0]["QUERY PLAN"],
    };
  }
  fs.writeFileSync(
    "/results/observation-plan.json",
    JSON.stringify(result, null, 2),
  );
  await db.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
