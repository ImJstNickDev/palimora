// Targeted integration regressions: normal search rejects stale generations;
// the existing scheduler continues projection in each maintenance mode.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { pool, transaction } = require("../apps/api/dist/db");
const search = require("../apps/api/dist/catalog-search");
const {
  runProjection,
  startProjections,
} = require("../apps/api/dist/operations-index");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Private fixture only");
(async () => {
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM catalog_text_pending"))
      .rows[0].n,
    0,
  );
  const row = (
    await pool.query(
      "SELECT d.work_id,d.generation,h.external_id FROM catalog_documents d JOIN archive_work_heads h ON h.id=d.work_id ORDER BY d.work_id LIMIT 1",
    )
  ).rows[0];
  const mode = (await pool.query("SELECT maintenance_mode FROM instance"))
    .rows[0].maintenance_mode;
  const query = { q: "id:" + row.external_id };
  const found = async () => transaction((db) => search.searchWorks(db, query));
  const enqueue = () =>
    pool.query(
      "INSERT INTO catalog_text_pending(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
      [row.work_id],
    );
  try {
    assert.ok((await found()).items.some((d) => d.id === row.work_id));
    await transaction(async (db) => {
      await db.query(
        "UPDATE catalog_documents SET generation=$2 WHERE work_id=$1",
        [row.work_id, "p2c-stale-source-probe"],
      );
      await db.query(
        "INSERT INTO catalog_text_pending(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
        [row.work_id],
      );
    });
    const stale = await found();
    assert.ok(stale.indexing);
    assert.ok(stale.items.every((d) => d.id !== row.work_id));
    assert.equal(
      await runProjection("search", () => search.projectText(16)),
      1,
    );
    await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh", {});
    assert.ok(
      (await found()).items.some(
        (d) =>
          d.id === row.work_id && d.generation === "p2c-stale-source-probe",
      ),
    );
    for (const maintenance of [
      "maintenance_light",
      "maintenance_full",
      "normal",
    ]) {
      await pool.query("UPDATE instance SET maintenance_mode=$1", [
        maintenance,
      ]);
      await enqueue();
      const stop = startProjections(
        require("../apps/api/dist/catalog").projectCatalog,
        search.projectText,
      );
      try {
        const deadline = Date.now() + 10000;
        while (
          (await pool.query("SELECT count(*)::int n FROM catalog_text_pending"))
            .rows[0].n
        ) {
          assert.ok(
            Date.now() < deadline,
            "Maintenance scheduler drain deadline",
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await stop();
      }
    }
  } finally {
    await pool.query("UPDATE instance SET maintenance_mode=$1", [mode]);
    await pool.query(
      "UPDATE catalog_documents SET generation=$2 WHERE work_id=$1",
      [row.work_id, row.generation],
    );
    await enqueue();
    await search.projectText(16);
    await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh", {});
  }
  assert.ok(
    (await found()).items.some(
      (d) => d.id === row.work_id && d.generation === row.generation,
    ),
  );
  fs.writeFileSync(
    "/results/p2c-integration.json",
    JSON.stringify({
      stale_source_excluded_from_normal_search: true,
      new_generation_visible_after_ack: true,
      maintenance_modes_preserve_scheduler_projection: true,
      original_generation_restored: true,
    }),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
