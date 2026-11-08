// Private aggregate diagnostics: deliberately exclude SQL text and document contents.
const fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
(async () => {
  const result = {};
  for (const [key, sql] of Object.entries({
    settings:
      "SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','work_mem','track_io_timing','max_connections')",
    queue_departures:
      "SELECT CASE WHEN query LIKE 'DELETE FROM catalog_pending%' THEN 'catalog' WHEN query LIKE 'DELETE FROM catalog_snapshot_pending%' THEN 'historical' ELSE 'text' END queue,sum(rows)::text departures FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND (query LIKE 'DELETE FROM catalog_pending%' OR query LIKE 'DELETE FROM catalog_snapshot_pending%' OR query LIKE 'DELETE FROM catalog_text_pending%') GROUP BY 1",
    database:
      "SELECT xact_commit,xact_rollback,blks_read,blks_hit,blk_read_time,blk_write_time,deadlocks,temp_bytes FROM pg_stat_database WHERE datname=current_database()",
    wal: "SELECT wal_records,wal_fpi,wal_bytes FROM pg_stat_wal",
    queries:
      "SELECT queryid,calls,total_exec_time,rows,shared_blks_hit,shared_blks_read,shared_blks_dirtied,wal_bytes FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())",
    io: "SELECT * FROM pg_stat_io",
    sizes:
      "SELECT relname,pg_total_relation_size(relid) bytes,pg_indexes_size(relid) index_bytes FROM pg_stat_user_tables",
    queues:
      "SELECT (SELECT count(*) FROM catalog_pending) catalog,(SELECT count(*) FROM catalog_snapshot_pending) historical,(SELECT count(*) FROM catalog_text_pending) text",
  }))
    result[key] = (await pool.query(sql)).rows;
  try {
    result.search_settings = await searchRequest(
      "/" +
        SEARCH_INDEX +
        "/_settings?include_defaults=true&flat_settings=true",
      undefined,
      "GET",
    );
    result.search = await searchRequest(
      "/" + SEARCH_INDEX + "/_stats",
      undefined,
      "GET",
    );
    result.nodes = await searchRequest("/_nodes/stats", undefined, "GET");
  } catch {}
  fs.writeFileSync(
    "/results/" + process.argv[2] + ".json",
    JSON.stringify(result),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
