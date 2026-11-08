const { Pool } = require("pg"),
  fs = require("node:fs"),
  { performance } = require("node:perf_hooks");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const result = {
    scenario: "Last 1000 pending documents with pre-drain statistics",
  };
  if (
    Number(
      (await db.query("SELECT count(*) n FROM catalog_text_pending")).rows[0].n,
    )
  )
    throw Error("Drain the isolated index queue first");
  await db.query("BEGIN");
  await db.query(
    "INSERT INTO catalog_text_pending SELECT work_id FROM catalog_documents",
  );
  await db.query("ANALYZE catalog_text_pending");
  await db.query(
    "DELETE FROM catalog_text_pending WHERE work_id NOT IN(SELECT work_id FROM catalog_documents ORDER BY work_id DESC LIMIT 1000)",
  );
  for (const [name, q] of Object.entries({
    before:
      "SELECT d.* FROM catalog_text_pending p JOIN catalog_documents d USING(work_id) ORDER BY p.work_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED",
    after:
      "SELECT d.* FROM catalog_text_pending p JOIN LATERAL (SELECT d.* FROM catalog_documents d WHERE d.work_id=p.work_id OFFSET 0) d ON true ORDER BY p.work_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED",
  })) {
    result[name] = {
      plan: (await db.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + q))
        .rows[0]["QUERY PLAN"],
    };
  }
  await db.query("ROLLBACK");
  fs.writeFileSync("/results/index-plan.json", JSON.stringify(result, null, 2));
  await db.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
