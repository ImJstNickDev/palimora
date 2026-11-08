// Actual projectCatalog(0,batch), private real snapshot corpus, logged shadow dictionaries/views.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const mode = process.argv[2],
  url = new URL(process.env.DATABASE_URL);
if (
  !["old", "new"].includes(mode) ||
  !url.pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Fixture only");
const schema = "p1c_history_" + mode;
url.searchParams.set("options", "-c search_path=" + schema + ",public");
process.env.DATABASE_URL = url.toString();
const { pool } = require("../apps/api/dist/db"),
  bib = require("../apps/api/dist/catalog-bibliography"),
  { projectCatalog } = require("../apps/api/dist/catalog"),
  { store } = require("../apps/api/dist/archive");
let metric;
for (const name of [
  "enrichBibliography",
  "enrichBibliographyBatch",
  "projectBibliography",
  "projectHistoricalBibliographies",
]) {
  const original = bib[name];
  if (!original) continue;
  bib[name] = async (...args) => {
    const start = performance.now();
    try {
      return await original(...args);
    } finally {
      if (metric)
        metric[name] = (metric[name] ?? 0) + (performance.now() - start) / 1000;
    }
  };
}
const fsp = require("node:fs/promises"),
  open = fsp.open;
fsp.open = async function (path, ...args) {
  const file = await open(path, ...args);
  if (metric && String(path).includes("/packs/")) {
    metric.pack_files_opened++;
    const read = file.read.bind(file);
    file.read = async (...args) => {
      const r = await read(...args);
      if (metric) {
        metric.pack_file_reads++;
        metric.pack_file_bytes += r.bytesRead;
      }
      return r;
    };
  }
  return file;
};
const read = store.readMany.bind(store);
store.readMany = async (records, ...args) => {
  const start = performance.now();
  if (metric) {
    metric.pack_calls++;
    metric.pack_objects += records.length;
    metric.pack_raw_bytes += records.reduce((n, r) => n + r.size, 0);
  }
  try {
    return await read(records, ...args);
  } finally {
    if (metric) metric.pack_seconds += (performance.now() - start) / 1000;
  }
};
const codec = require("../apps/api/native/build/codec.node"),
  decode = codec.batch;
codec.batch = async function (input, options, dec, ...args) {
  const start = performance.now();
  if (metric && dec) {
    metric.decode_calls++;
    metric.decode_objects += input.length;
  }
  try {
    return await decode(input, options, dec, ...args);
  } finally {
    if (metric && dec)
      metric.decode_seconds += (performance.now() - start) / 1000;
  }
};
const connect = pool.connect.bind(pool);
pool.connect = async () => {
  const db = await connect(),
    proxy = Object.create(db);
  proxy.release = (...args) => db.release(...args);
  proxy.query = async (sql, args) => {
    if (
      metric &&
      /^(INSERT INTO|UPDATE|DELETE FROM) catalog_(documents|work_tags|work_filters|entity_works|text_pending)/.test(
        sql,
      )
    )
      throw Error("Historical path wrote current state");
    const phase = /INSERT INTO catalog_snapshot_views/.test(sql)
      ? "views"
      : /WITH RECURSIVE closure/.test(sql)
        ? "filters"
        : /catalog_tags/.test(sql)
          ? "tags"
          : /catalog_entities/.test(sql)
            ? "entities"
            : "other";
    const start = performance.now();
    const r = await db.query(sql, args);
    if (metric) {
      metric.queries++;
      metric.sql[phase] =
        (metric.sql[phase] ?? 0) + (performance.now() - start) / 1000;
      if (sql === "COMMIT") metric.commits++;
      if (sql.startsWith("INSERT INTO catalog_snapshot_views"))
        metric.inserted += r.rowCount;
    }
    return r;
  };
  return proxy;
};
(async () => {
  const db = await connect();
  const ids = (
    await db.query(
      "SELECT id FROM public.archive_snapshots ORDER BY id LIMIT 1024",
    )
  ).rows.map((r) => r.id);
  assert.equal(ids.length, 1024);
  const results = [];
  for (const batch of [20, 64, 256]) {
    await db.query(`CREATE SCHEMA ${schema}`);
    for (const table of [
      "catalog_tags",
      "catalog_entities",
      "catalog_snapshot_views",
      "catalog_snapshot_pending",
      "catalog_pending",
      "catalog_graph_pending",
    ])
      await db.query(
        `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    for (const table of ["catalog_tags", "catalog_entities"])
      await db.query(
        `INSERT INTO ${schema}.${table} SELECT * FROM public.${table}`,
      );
    const warm = await pool.connect();
    warm.release();
    for (const phase of ["initial", "regenerate"]) {
      await db.query("TRUNCATE catalog_snapshot_views");
      await db.query(
        "INSERT INTO catalog_snapshot_pending SELECT unnest($1::uuid[])",
        [ids],
      );
      const lsn = (await db.query("SELECT pg_current_wal_insert_lsn() lsn"))
        .rows[0].lsn;
      metric = {
        queries: 0,
        commits: 0,
        inserted: 0,
        sql: {},
        pack_files_opened: 0,
        pack_file_reads: 0,
        pack_file_bytes: 0,
        pack_calls: 0,
        pack_objects: 0,
        pack_raw_bytes: 0,
        pack_seconds: 0,
        decode_calls: 0,
        decode_objects: 0,
        decode_seconds: 0,
      };
      const start = performance.now(),
        cpu = process.cpuUsage();
      for (let i = 0; i < ids.length; i += batch)
        assert.equal(
          await projectCatalog(0, batch),
          Math.min(batch, ids.length - i),
        );
      const seconds = (performance.now() - start) / 1000,
        usage = process.cpuUsage(cpu),
        measured = metric;
      metric = null;
      assert.equal(measured.inserted, 1024);
      assert.ok(
        measured.pack_files_opened > 0,
        "Pack I/O instrumentation active",
      );
      assert.ok(measured.decode_objects > 0, "Codec instrumentation active");
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM catalog_snapshot_pending"))
          .rows[0].n,
        0,
      );
      const wal_bytes = Number(
        (
          await db.query(
            "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) n",
            [lsn],
          )
        ).rows[0].n,
      );
      results.push({
        mode,
        batch,
        phase,
        snapshots: ids.length,
        seconds,
        snapshots_per_second: ids.length / seconds,
        ...measured,
        queries_per_snapshot: measured.queries / ids.length,
        wal_bytes,
        node_cpu_seconds: (usage.user + usage.system) / 1e6,
        rss_mib: process.memoryUsage().rss / 1048576,
        peak_rss_mib: process.resourceUsage().maxRSS / 1024,
      });
      fs.writeFileSync(
        "/results/history-" + mode + ".json",
        JSON.stringify(results, null, 2),
      );
    }
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  }
  db.release();
  await pool.end();
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
