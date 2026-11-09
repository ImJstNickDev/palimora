// Read-only analysis and warm handler timings on the private heterogeneous fixture.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
const {
  searchWorks,
  searchRequest,
} = require("../apps/api/dist/catalog-search");
const { catalogOperation } = require("../apps/api/dist/catalog");
function distribution(values) {
  values.sort((a, b) => a - b);
  return {
    requests: values.length,
    p50_ms: values[Math.ceil(values.length * 0.5) - 1],
    p95_ms: values[Math.ceil(values.length * 0.95) - 1],
    max_ms: values.at(-1),
  };
}
(async () => {
  const bibliography = (
    await pool.query(`WITH all_views AS (
    SELECT metadata,bibliography FROM catalog_documents UNION ALL
    SELECT metadata,bibliography FROM catalog_snapshot_views
  ), grouped AS (SELECT metadata,bibliography,count(*) n FROM all_views GROUP BY metadata,bibliography)
  SELECT sum(n)::int rows,count(*)::int distinct_payloads,
    sum(n*octet_length(jsonb_build_array(metadata,bibliography)::text))::float repeated_json_bytes,
    sum(octet_length(jsonb_build_array(metadata,bibliography)::text))::float interned_json_bytes FROM grouped`)
  ).rows[0];
  const cache = (
    await pool.query(`SELECT count(*)::int rows,sum(raw_size)::float raw_bytes,sum(octet_length(data))::float compressed_bytes,
    pg_total_relation_size('archive_cache_data')::float relation_bytes FROM archive_cache_data`)
  ).rows[0];
  const fieldwiseInterning = (
    await pool.query(`WITH all_views AS (
    SELECT metadata,bibliography FROM catalog_documents UNION ALL SELECT metadata,bibliography FROM catalog_snapshot_views
  ), fields AS (SELECT 'metadata' kind,metadata value FROM all_views UNION ALL SELECT 'bibliography',bibliography FROM all_views),
  grouped AS (SELECT kind,value,count(*) n FROM fields GROUP BY kind,value)
  SELECT kind,sum(n)::int rows,count(*)::int distinct_payloads,sum(n*octet_length(value::text))::float repeated_json_bytes,
    sum(octet_length(value::text))::float interned_json_bytes FROM grouped GROUP BY kind ORDER BY kind`)
  ).rows;
  const closure = (
    await pool.query(
      `SELECT count(*)::int total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM catalog_work_tags t WHERE t.work_id=f.work_id AND t.tag_id=f.tag_id))::int direct_overlap FROM catalog_work_filters f`,
    )
  ).rows[0];
  const work = (
    await pool.query(
      "SELECT id FROM archive_work_heads WHERE external_id='899999999999'",
    )
  ).rows[0].id;
  const searchTimes = [],
    readerTimes = [];
  const queries = [
    { sort: "title" },
    { fulltext: "love" },
    { fulltext: '"I love you"' },
  ];
  async function search(q) {
    const r = await searchWorks(pool, q);
    if (r.next)
      await searchRequest(
        "/_search/point_in_time",
        { pit_id: [JSON.parse(Buffer.from(r.next, "base64url").toString()).p] },
        "DELETE",
      );
    return r;
  }
  for (const q of queries) await search(q);
  await catalogOperation(pool, "readerContent", { id: work });
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let i = 0; i < 10; i++) {
        let start = performance.now();
        await search(queries[i % queries.length]);
        searchTimes.push(performance.now() - start);
        start = performance.now();
        const r = await catalogOperation(pool, "readerContent", { id: work });
        assert.ok(r.document.length > 100);
        readerTimes.push(performance.now() - start);
      }
    }),
  );
  fs.writeFileSync(
    "/results/storage-post-analysis.json",
    JSON.stringify(
      {
        bibliography,
        fieldwise_interning: fieldwiseInterning,
        cache,
        closure,
        latency: {
          clients: 3,
          warm: true,
          http: false,
          search_includes_pit_cleanup: true,
          search: distribution(searchTimes),
          reader_256_chapters: distribution(readerTimes),
        },
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
