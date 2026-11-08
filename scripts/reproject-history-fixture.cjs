// Controlled regeneration of derived historical views only, on the private corpus copy.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { pool } = require("../apps/api/dist/db"),
  { projectCatalog } = require("../apps/api/dist/catalog");
const mode = process.argv[2];
if (
  !["old", "new"].includes(mode) ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Fixture only");
(async () => {
  const state = async () =>
    (
      await pool.query(
        `SELECT (SELECT md5(string_agg(to_jsonb(d)::text,'' ORDER BY work_id)) FROM catalog_documents d) documents_including_generations,(SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY work_id,tag_id)) FROM catalog_work_tags t) tags,(SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY work_id,entity_id)) FROM catalog_entity_works t) entities,(SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY work_id,tag_id)) FROM catalog_work_filters t) filters,(SELECT count(*) FROM catalog_pending) current_pending,(SELECT count(*) FROM catalog_text_pending) text_pending,(SELECT count(*) FROM archive_snapshot_data) canonical_snapshots`,
      )
    ).rows[0];
  const before = await state();
  assert.equal(before.canonical_snapshots, "11032");
  assert.equal(before.current_pending, "0");
  assert.equal(before.text_pending, "0");
  await pool.query("TRUNCATE catalog_snapshot_views");
  await pool.query(
    "INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshots ON CONFLICT DO NOTHING",
  );
  let projected = 0;
  while (true) {
    const n = await projectCatalog(0, 64);
    if (!n) break;
    projected += n;
  }
  assert.equal(projected, 11032);
  assert.deepEqual(await state(), before);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM catalog_snapshot_views"))
      .rows[0].n,
    11032,
  );
  fs.writeFileSync(
    "/results/historical-regeneration-" + mode + ".json",
    JSON.stringify({
      projected,
      current_and_generation_fingerprint: before,
      current_state_unchanged: true,
    }),
  );
  console.log(JSON.stringify({ projected, current_state_unchanged: true }));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
