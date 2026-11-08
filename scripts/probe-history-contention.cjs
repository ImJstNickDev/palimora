// Targeted shared-budget test; no ingest, indexing or interactive/end-to-end campaign.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const mode = process.argv[2],
  url = new URL(process.env.DATABASE_URL),
  schema = "p1c_contention_" + mode;
if (!["old", "new"].includes(mode) || !url.pathname.endsWith("_test"))
  throw Error("Test only");
url.searchParams.set("options", "-c search_path=" + schema + ",public");
process.env.DATABASE_URL = url.toString();
const { pool } = require("../apps/api/dist/db"),
  { projectCatalog } = require("../apps/api/dist/catalog");
(async () => {
  const db = await pool.connect(),
    results = [];
  const works = (
      await db.query(
        "SELECT id FROM public.archive_work_heads ORDER BY id LIMIT 256",
      )
    ).rows.map((r) => r.id),
    snapshots = (
      await db.query(
        "SELECT id FROM public.archive_snapshots ORDER BY id LIMIT 256",
      )
    ).rows.map((r) => r.id);
  for (const scenario of ["current_only", "mixed"]) {
    await db.query(`CREATE SCHEMA ${schema}`);
    for (const table of [
      "catalog_tags",
      "catalog_entities",
      "catalog_work_tags",
      "catalog_work_filters",
      "catalog_entity_works",
      "catalog_documents",
      "catalog_snapshot_views",
      "catalog_pending",
      "catalog_snapshot_pending",
      "catalog_text_pending",
      "catalog_graph_pending",
    ]) {
      await db.query(
        `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
      if (!table.endsWith("pending"))
        await db.query(
          `INSERT INTO ${schema}.${table} SELECT * FROM public.${table}`,
        );
    }
    for (const table of [
      "catalog_tags",
      "catalog_entities",
      "catalog_work_tags",
      "catalog_work_filters",
      "catalog_entity_works",
      "catalog_documents",
      "catalog_snapshot_views",
    ])
      await db.query(`ANALYZE ${schema}.${table}`);
    await db.query(
      "DELETE FROM catalog_snapshot_views WHERE snapshot_id=ANY($1::uuid[])",
      [snapshots],
    );
    await db.query("INSERT INTO catalog_pending SELECT unnest($1::uuid[])", [
      works,
    ]);
    if (scenario === "mixed")
      await db.query(
        "INSERT INTO catalog_snapshot_pending SELECT unnest($1::uuid[])",
        [snapshots],
      );
    const warm = await pool.connect();
    warm.release();
    const spans = [],
      start = performance.now();
    for (let i = 0; i < 256; i += 20) {
      const t = performance.now();
      assert.equal(
        await projectCatalog(20, scenario === "mixed" ? 20 : 0),
        Math.min(20, 256 - i) * (scenario === "mixed" ? 2 : 1),
      );
      spans.push((performance.now() - t) / 1000);
    }
    const seconds = (performance.now() - start) / 1000;
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_snapshot_pending"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_text_pending"))
        .rows[0].n,
      256,
    );
    spans.sort((a, b) => a - b);
    results.push({
      scenario,
      current: 256,
      historical: scenario === "mixed" ? 256 : 0,
      seconds,
      commits: 13,
      batch_seconds_p95: spans[Math.ceil(0.95 * spans.length) - 1],
      batch_seconds_max: spans.at(-1),
      both_queues_drained: true,
    });
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  }
  fs.writeFileSync(
    "/results/history-contention-" + mode + ".json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
  db.release();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
