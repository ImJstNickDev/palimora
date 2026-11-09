// Run only on a cold-cloned private fixture, never against an application DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const pg = require("pg");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test DB required");
const label = process.env.P2B2_LABEL;
if (!/^(legacy|serial|p11|p21|p12)-(16|64)(-repeat)?$/.test(label))
  throw Error("Invalid label");
const metrics = {
  sql: 0,
  transactions: 0,
  http: 0,
  document_requests: 0,
  bulk_requests: 0,
  bytes: 0,
  http_ms: 0,
  renewal_queries: 0,
  ack_queries: 0,
};
let measuring = false;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (measuring) {
    metrics.sql++;
    const sql = String(args[0]?.text ?? args[0]);
    if (sql.startsWith("WITH input AS")) metrics.renewal_queries++;
    if (sql.startsWith("DELETE FROM catalog_text_pending p USING"))
      metrics.ack_queries++;

    if (/^BEGIN/i.test(args[0]?.text ?? args[0])) metrics.transactions++;
  }
  return query.apply(this, args);
};
const payloads = [];
const fetch = global.fetch;
global.fetch = async (...args) => {
  const start = performance.now();
  try {
    return await fetch(...args);
  } finally {
    if (measuring) {
      metrics.http++;
      if (String(args[0]).includes("/_doc/")) metrics.document_requests++;
      if (String(args[0]).endsWith("/_bulk")) {
        metrics.bulk_requests++;
        payloads.push(Buffer.byteLength(args[1]?.body ?? ""));
      }
      metrics.bytes += Buffer.byteLength(args[1]?.body ?? "");
      metrics.http_ms += performance.now() - start;
    }
  }
};
const extra = {
  pack_calls: 0,
  pack_objects: 0,
  pack_compressed_bytes: 0,
  pack_decoded_bytes: 0,
  pack_open: 0,
  pack_read_calls: 0,
  pack_read_bytes: 0,
  plain_calls: 0,
  plain_ms: 0,
};
const fsp = require("node:fs/promises");
const open = fsp.open;
fsp.open = async function (path, ...args) {
  const file = await open.call(this, path, ...args);
  if (String(path).endsWith(".pmpack")) {
    if (measuring) extra.pack_open++;
    const read = file.read.bind(file);
    file.read = async (...a) => {
      const r = await read(...a);
      if (measuring) {
        extra.pack_read_calls++;
        extra.pack_read_bytes += r.bytesRead;
      }
      return r;
    };
  }
  return file;
};
const { PackStore } = require("../apps/api/dist/pack");
const readMany = PackStore.prototype.readMany;
PackStore.prototype.readMany = async function (records, ...args) {
  if (measuring) {
    extra.pack_calls++;
    extra.pack_objects += records.length;
    extra.pack_compressed_bytes += records.reduce((s, r) => s + r.length, 0);
    extra.pack_decoded_bytes += records.reduce((s, r) => s + r.size, 0);
  }
  return readMany.call(this, records, ...args);
};
const bibliography = require("../apps/api/dist/catalog-bibliography");
const plain = bibliography.plain;
bibliography.plain = (...args) => {
  const start = performance.now();
  try {
    return plain(...args);
  } finally {
    if (measuring) {
      extra.plain_calls++;
      extra.plain_ms += performance.now() - start;
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
  await migrate();
  const profile = label.split("-")[0];
  const pipeline = {
    groups: 8,
    prepareLanes: profile === "p21" ? 2 : 1,
    publishLanes: profile === "p12" ? 2 : 1,
    overlap: profile !== "serial",
  };

  await ensureSearchIndex();
  await pool.query(
    "INSERT INTO catalog_text_pending(work_id) SELECT work_id FROM catalog_documents ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
  );
  const wal0 = (await pool.query("SELECT pg_current_wal_lsn() lsn")).rows[0]
    .lsn;
  const started_at = Date.now();
  const osBefore = await searchRequest(
    "/_nodes/stats/process,fs,indices",
    undefined,
    "GET",
  );
  const ioBefore = fs.readFileSync("/proc/self/io", "utf8");
  const statementsBefore = (
    await pool.query(
      "SELECT sum(calls)::text calls,sum(total_exec_time)::text ms FROM pg_stat_statements",
    )
  ).rows[0];
  const databaseBefore = (
    await pool.query(
      "SELECT xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()",
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
    const n = await projectText(
      Number(label.split("-")[1]),
      () => false,
      pipeline,
    );
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
    "/_nodes/stats/process,fs,indices",
    undefined,
    "GET",
  );
  const ioAfter = fs.readFileSync("/proc/self/io", "utf8");
  const statementsAfter = (
    await pool.query(
      "SELECT sum(calls)::text calls,sum(total_exec_time)::text ms FROM pg_stat_statements",
    )
  ).rows[0];
  const databaseAfter = (
    await pool.query(
      "SELECT xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()",
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
  if (label.startsWith("legacy")) {
    if (fs.existsSync("/results/reference.json"))
      assert.deepEqual(
        captured,
        JSON.parse(fs.readFileSync("/results/reference.json")),
      );
    fs.writeFileSync("/results/reference.json", JSON.stringify(captured));
    equivalent = true;
  } else {
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
    databaseBefore,
    databaseAfter,
    payloads,
    label,
    pipeline: profile === "legacy" ? null : pipeline,
    count,
    seconds,
    documents_per_second: count / seconds,
    ...metrics,
    preparation_io: extra,
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
