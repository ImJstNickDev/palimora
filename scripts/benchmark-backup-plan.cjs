const { Pool } = require("pg"),
  fs = require("node:fs"),
  { performance } = require("node:perf_hooks");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const hashes = (
      await db.query(
        "SELECT encode(hash,'hex') hash FROM archive_object_data ORDER BY hash LIMIT 12",
      )
    ).rows.map((r) => r.hash),
    result = {};
  for (const [name, q, args] of [
    [
      "before",
      "SELECT count(*) FROM archive_objects WHERE hash=ANY($1::text[])",
      [hashes],
    ],
    [
      "after",
      "SELECT count(*) FROM archive_object_data WHERE hash=ANY($1::bytea[])",
      [hashes.map((h) => Buffer.from(h, "hex"))],
    ],
  ]) {
    let row;
    const samples = [];
    for (let i = 0; i < 22; i++) {
      const t = performance.now();
      row = (await db.query(q, args)).rows[0];
      if (i >= 2) samples.push(performance.now() - t);
    }
    if (row.count !== "12") throw Error("Mismatch");
    result[name] = {
      samples_ms: samples,
      plan: (await db.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + q, args))
        .rows[0]["QUERY PLAN"],
    };
  }
  fs.writeFileSync(
    "/results/backup-plan.json",
    JSON.stringify(result, null, 2),
  );
  await db.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
