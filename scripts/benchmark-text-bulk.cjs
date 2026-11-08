// Run only on a cold-cloned private fixture, never against an application DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const pg = require("pg");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test DB required");
const label = process.env.P2A_LABEL;
if (!/^(old|bulk)-(16|64|128)$/.test(label)) throw Error("Invalid label");
if (label.startsWith("old"))
  assert.equal(
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(require.resolve("../apps/api/dist/catalog-search")),
      )
      .digest("hex"),
    "0f49f6843c709add3969ceb559590b1a0b830694315cca50e17a094b4c562890",
    "P1B.1 reference engine mismatch",
  );
const metrics = {
  sql: 0,
  transactions: 0,
  http: 0,
  document_requests: 0,
  bulk_requests: 0,
  bytes: 0,
  http_ms: 0,
};
let measuring = false;
let oldPrepareStart = 0;
let oldPrepareMs = 0;
let oldQueueSqlMs = 0;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (measuring) {
    metrics.sql++;
    if (/^BEGIN/i.test(args[0]?.text ?? args[0])) metrics.transactions++;
  }
  const sqlStart = performance.now();
  let result = query.apply(this, args);
  if (
    measuring &&
    label.startsWith("old") &&
    /^(BEGIN|COMMIT|DELETE FROM catalog_text_pending)|SELECT d\.\* FROM catalog_text_pending p/.test(
      String(args[0]),
    )
  )
    result = result.then((r) => {
      oldQueueSqlMs += performance.now() - sqlStart;
      return r;
    });
  if (
    measuring &&
    label.startsWith("old") &&
    String(args[0]).includes("SELECT d.* FROM catalog_text_pending p")
  )
    return result.then((r) => {
      if (r.rows.length) oldPrepareStart = performance.now();
      return r;
    });
  return result;
};
const fetch = global.fetch;
global.fetch = async (...args) => {
  const start = performance.now();
  if (
    measuring &&
    label.startsWith("old") &&
    String(args[0]).includes("/_doc/") &&
    oldPrepareStart
  ) {
    oldPrepareMs += start - oldPrepareStart;
    oldPrepareStart = 0;
  }
  try {
    return await fetch(...args);
  } finally {
    if (measuring) {
      metrics.http++;
      if (String(args[0]).includes("/_doc/")) metrics.document_requests++;
      if (String(args[0]).endsWith("/_bulk")) metrics.bulk_requests++;
      metrics.bytes += Buffer.byteLength(args[1]?.body ?? "");
      metrics.http_ms += performance.now() - start;
    }
  }
};
const { pool, migrate } = require("../apps/api/dist/db");
const {
  projectText,
  ensureSearchIndex,
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
async function capture() {
  await searchRequest("/" + SEARCH_INDEX + "/_refresh");
  let result = await searchRequest("/" + SEARCH_INDEX + "/_search?scroll=1m", {
    size: 128,
    sort: ["_doc"],
  });
  const hashes = {};
  while (result.hits.hits.length) {
    for (const h of result.hits.hits)
      hashes[h._id] = crypto
        .createHash("sha256")
        .update(JSON.stringify(h._source))
        .digest("hex");
    result = await searchRequest("/_search/scroll", {
      scroll: "1m",
      scroll_id: result._scroll_id,
    });
  }
  const queries = [
    { match_all: {} },
    { match: { "text.en": "love" } },
    { match: { title: "love" } },
    { term: { availability: "unknown" } },
    { range: { word_count: { gte: 10000 } } },
  ];
  const searches = [];
  for (const q of queries) {
    const r = await searchRequest("/" + SEARCH_INDEX + "/_search", {
      size: 100,
      query: q,
      sort: [{ id: "asc" }],
      track_total_hits: true,
    });
    searches.push({
      total: r.hits.total.value,
      ids: r.hits.hits.map((h) => h._id),
    });
  }
  return { hashes, searches };
}
(async () => {
  if (label.startsWith("bulk")) await migrate();
  await ensureSearchIndex();
  await pool.query(
    "INSERT INTO catalog_text_pending(work_id) SELECT work_id FROM catalog_documents ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
  );
  const wal0 = (await pool.query("SELECT pg_current_wal_lsn() lsn")).rows[0]
    .lsn;
  const started_at = Date.now();
  const osBefore = await searchRequest(
    "/_nodes/stats/process,fs",
    undefined,
    "GET",
  );
  const ioBefore = fs.readFileSync("/proc/self/io", "utf8");
  const statementsBefore = (
    await pool.query(
      "SELECT sum(calls)::text calls,sum(total_exec_time)::text ms FROM pg_stat_statements",
    )
  ).rows[0];
  const cpu = process.cpuUsage(),
    start = performance.now();
  let rssSum = 0,
    rssN = 0,
    rssMax = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    rssSum += rss;
    rssN++;
    rssMax = Math.max(rssMax, rss);
  }, 100);
  let count = 0;
  measuring = true;
  while (true) {
    const n = await projectText(Number(label.split("-")[1]));
    if (!n) break;
    count += n;
  }
  measuring = false;
  clearInterval(sampler);
  const seconds = (performance.now() - start) / 1000;
  const cpuUsed = process.cpuUsage(cpu);
  const wal = (
    await pool.query(
      "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text bytes",
      [wal0],
    )
  ).rows[0].bytes;
  const ended_at = Date.now();
  const osAfter = await searchRequest(
    "/_nodes/stats/process,fs",
    undefined,
    "GET",
  );
  const ioAfter = fs.readFileSync("/proc/self/io", "utf8");
  const statementsAfter = (
    await pool.query(
      "SELECT sum(calls)::text calls,sum(total_exec_time)::text ms FROM pg_stat_statements",
    )
  ).rows[0];
  assert.equal(count, 11032);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM catalog_text_pending"))
      .rows[0].n,
    0,
  );
  const captured = await capture();
  assert.equal(Object.keys(captured.hashes).length, 11032);
  let equivalent = null;
  if (label.startsWith("old"))
    fs.writeFileSync("/results/reference.json", JSON.stringify(captured));
  else {
    assert.deepEqual(
      captured,
      JSON.parse(fs.readFileSync("/results/reference.json")),
    );
    equivalent = true;
  }
  const output = {
    started_at,
    ended_at,
    osBefore,
    osAfter,
    ioBefore,
    ioAfter,
    statementsBefore,
    statementsAfter,
    label,
    count,
    seconds,
    documents_per_second: count / seconds,
    ...metrics,
    old_queue_sql_ms: label.startsWith("old") ? oldQueueSqlMs : null,
    old_prepare_ms: label.startsWith("old") ? oldPrepareMs : null,
    wal_bytes: wal,
    node_cpu: cpuUsed,
    rss_mean: rssSum / rssN,
    rss_max: rssMax,
    equivalent,
  };
  fs.writeFileSync(
    "/results/" + label + ".json",
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
