// Read-only post-measurement aggregates. Never include archived text or identities.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Isolated test DB required");
(async () => {
  const report = {};
  const queries = {
    counts: `SELECT (SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM catalog_documents) documents,(SELECT count(*) FROM catalog_snapshot_views) historical_views,(SELECT count(*) FROM catalog_tags) tags,(SELECT count(*) FROM catalog_entities) entities,(SELECT count(*) FROM catalog_work_tags) work_tags,(SELECT count(*) FROM catalog_entity_works) work_entities,(SELECT count(*) FROM catalog_work_filters) filters,(SELECT count(*) FROM catalog_tag_edges) edges,(SELECT count(*) FROM catalog_documents WHERE indexed_at IS NULL) unindexed`,
    queues: `SELECT (SELECT count(*) FROM catalog_pending) current,(SELECT count(*) FROM catalog_snapshot_pending) historical,(SELECT count(*) FROM catalog_text_pending) text,(SELECT count(*) FROM catalog_graph_pending) graph`,
    seeding: `SELECT kind,availability,count(*) jobs FROM ao3_jobs GROUP BY kind,availability`,
    ingest: `SELECT state,count(*) sources,sum(imported) imported,sum(duplicates) duplicates,sum(gaps) gaps FROM ingest_sources GROUP BY state`,
    scheduler: `WITH spans AS (SELECT *,greatest(0,extract(epoch FROM started_at-lag(finished_at) OVER(PARTITION BY kind ORDER BY id))) gap FROM operations_index_runs) SELECT kind,count(*) batches,sum(processed) processed,count(*) FILTER(WHERE error IS NOT NULL) errors,sum(extract(epoch FROM finished_at-started_at)) service_seconds,sum(gap) inter_batch_seconds,max(gap) max_gap_seconds,percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM finished_at-started_at)) p95_batch_seconds FROM spans GROUP BY kind`,
    operations: `SELECT kind,state,paused,processed,error FROM operations_index`,
    legacy_sql: `SELECT coalesce(sum(calls) FILTER(WHERE query LIKE 'INSERT INTO catalog_tags%VALUES%'),0) individual_tags,coalesce(sum(calls) FILTER(WHERE query LIKE 'INSERT INTO catalog_entities%VALUES%'),0) individual_entities,coalesce(sum(calls) FILTER(WHERE query LIKE 'INSERT INTO catalog_work_tags%VALUES%'),0) individual_work_tags,coalesce(sum(calls) FILTER(WHERE query LIKE 'INSERT INTO catalog_entity_works%VALUES%'),0) individual_work_entities,coalesce(sum(calls) FILTER(WHERE query LIKE 'INSERT INTO catalog_snapshot_views VALUES%'),0) individual_views FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    canonical_fingerprint: `SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) snapshots FROM archive_snapshots s`,
  };
  for (const [name, sql] of Object.entries(queries))
    report[name] = (await pool.query(sql)).rows;
  for (const n of Object.values(report.queues[0])) assert.equal(Number(n), 0);
  for (const name of ["works", "snapshots", "documents", "historical_views"])
    assert.equal(Number(report.counts[0][name]), 11032);
  assert.equal(Number(report.counts[0].unindexed), 0);
  assert.ok(report.scheduler.every((r) => Number(r.errors) === 0));
  fs.writeFileSync(
    "/results/integration.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      integration_verified: true,
      counts: report.counts[0],
      seeding: report.seeding,
    }),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
