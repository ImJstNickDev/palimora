// Release measurements against a disposable database and canonical store only.
const fs = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
if (!process.env.ARCHIVE_ROOT?.startsWith("/benchmark/"))
  throw Error("Isolated /benchmark storage required");
const { pool, migrate, transaction } = require("../apps/api/dist/db");
const archive = require("../apps/api/dist/archive");
const mode = process.argv[2];
const start = performance.now();
const result = {
  mode,
  started_at: new Date().toISOString(),
  configuration: {
    parsers: process.env.INGEST_PARSER_WORKERS,
    commits: process.env.INGEST_COMMIT_CONCURRENCY,
    zstd: process.env.ARCHIVE_ZSTD_LEVEL,
  },
};
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    mean_ms: a.reduce((x, y) => x + y, 0) / a.length,
    p50_ms: a[Math.ceil(a.length * 0.5) - 1],
    p95_ms: a[Math.ceil(a.length * 0.95) - 1],
    p99_ms: a[Math.ceil(a.length * 0.99) - 1],
    max_ms: a.at(-1),
  };
};
async function measure(n, fn, concurrency = 1) {
  const times = [];
  let i = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < n) {
        const k = i++;
        const t = performance.now();
        await fn(k);
        times.push(performance.now() - t);
      }
    }),
  );
  return { ...stats(times), seconds: (performance.now() - start) / 1000 };
}
async function counts() {
  return (
    await pool.query(
      `SELECT (SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_object_data) objects,(SELECT count(*) FROM archive_packs) packs,(SELECT sum(size) FROM archive_object_data) raw_bytes,(SELECT sum(length) FROM archive_object_data) record_bytes,(SELECT pg_database_size(current_database())) database_bytes`,
    )
  ).rows[0];
}
(async () => {
  await migrate();
  if (["ingest", "reingest", "resume", "incremental"].includes(mode)) {
    const finish = await require("./ingest-profiler.cjs").start({
      archive,
      pool,
    });
    let records = 0;
    const original = archive.ingestRecords;
    archive.ingestRecords = async (...args) => {
      await original(...args);
      records += args[1].length;
      if (
        Number(process.env.BENCH_STOP_AFTER) > 0 &&
        records >= Number(process.env.BENCH_STOP_AFTER)
      )
        process.emit("SIGTERM");
    };
    const { tick } = require("../apps/api/dist/ingest-worker");
    let id;
    if (mode === "resume") {
      id = (
        await pool.query(
          "SELECT id FROM ingest_batches ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0].id;
      await pool.query(
        "UPDATE ingest_batches SET state='pending' WHERE id=$1 AND state='paused'",
        [id],
      );
    } else {
      id = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,$3)",
        [
          id,
          [process.env.BENCH_SOURCE || "queue119_archive05.zip"],
          mode === "reingest",
        ],
      );
    }
    const t = performance.now();
    await tick(id);
    result.engine_seconds = (performance.now() - t) / 1000;
    result.records = records;
    result.works_per_second = records / result.engine_seconds;
    result.profile = await finish();
    result.batch = (
      await pool.query("SELECT state,error FROM ingest_batches WHERE id=$1", [
        id,
      ])
    ).rows[0];
    result.sources = (
      await pool.query(
        "SELECT path,state,checkpoint,imported,duplicates,gaps FROM ingest_sources WHERE batch_id=$1",
        [id],
      )
    ).rows;
    assert.ok(
      [
        "completed",
        "completed_with_gaps",
        "paused",
        ...(Number(process.env.BENCH_STOP_AFTER) > 0 ? ["running"] : []),
      ].includes(result.batch.state),
      JSON.stringify(result.batch),
    );
  } else if (mode === "project") {
    const { projectCatalog, projectText } = require("../apps/api/dist/catalog");
    let n = 0,
      t = performance.now();
    while (await projectCatalog()) {
      n++;
      if (n % 100 === 0) console.error("catalog batches", n);
    }
    result.catalog_seconds = (performance.now() - t) / 1000;
    t = performance.now();
    n = 0;
    let count;
    while ((count = await projectText())) {
      n += count;
      if (n % 1024 === 0) console.error("indexed", n);
    }
    result.indexed = n;
    result.index_seconds = (performance.now() - t) / 1000;
    result.index_works_per_second = n / result.index_seconds;
    const {
      searchRequest,
      SEARCH_INDEX,
    } = require("../apps/api/dist/catalog-search");
    await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
    result.index_stats = (
      await searchRequest("/" + SEARCH_INDEX + "/_stats", undefined, "GET")
    )._all;
  } else if (mode === "queries") {
    const {
      catalogOperation,
      loadSnapshot,
      chapterBytes,
    } = require("../apps/api/dist/catalog");
    const {
      searchWorks,
      searchRequest,
    } = require("../apps/api/dist/catalog-search");
    const pits = new Set();
    const search = async (db, q) => {
      const r = await searchWorks(db, q);
      if (r.next) pits.add(JSON.parse(Buffer.from(r.next, "base64url")).p);
      return r;
    };
    const closePits = async () => {
      if (pits.size)
        await searchRequest(
          "/_search/point_in_time",
          { pit_id: [...pits] },
          "DELETE",
        );
      pits.clear();
    };
    const work = (
      await pool.query(
        "SELECT work_id FROM catalog_documents WHERE snapshot_id IS NOT NULL ORDER BY work_id LIMIT 1",
      )
    ).rows[0].work_id;
    result.postgres = {};
    result.plans = {};
    const queries = {
      head: ["SELECT * FROM archive_work_heads WHERE id=$1", [work]],
      catalog_page: [
        "SELECT work_id,title FROM catalog_documents ORDER BY work_id LIMIT 20",
        [],
      ],
      title: [
        "SELECT work_id,title FROM catalog_documents WHERE title ILIKE $1 ORDER BY work_id LIMIT 20",
        ["%love%"],
      ],
      history: [
        "SELECT * FROM archive_snapshots WHERE work_id=$1 ORDER BY imported_at DESC",
        [work],
      ],
      pending: [
        "SELECT p.work_id FROM catalog_pending p ORDER BY p.work_id LIMIT 20 FOR UPDATE SKIP LOCKED",
        [],
      ],
    };
    for (const [name, [sql, params]] of Object.entries(queries)) {
      for (let i = 0; i < 3; i++) await pool.query(sql, params);
      result.postgres[name] = await measure(300, () => pool.query(sql, params));
      result.plans[name] = (
        await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, params)
      ).rows[0]["QUERY PLAN"];
    }
    result.search = {};
    const searches = {
      all: {},
      simple: { q: "love" },
      advanced: { title: "love", words: ">1000", sort: "words" },
      fulltext: { fulltext: '"I love you"' },
      combined: {
        language: "English",
        words: "1000-50000",
        exclude: "Major Character Death",
        sort: "kudos",
      },
      complex: {
        q: "(love OR home) AND -war",
        fulltext: '("I love you" OR "she said")',
        sort: "updated",
      },
    };
    for (const [name, q] of Object.entries(searches)) {
      let total;
      for (let i = 0; i < 3; i++) await transaction((db) => search(db, q));
      result.search[name] = await measure(100, () =>
        transaction(async (db) => {
          const r = await search(db, q);
          total = r.total;
        }),
      );
      result.search[name].total = total;
      await closePits();
    }
    result.search_concurrency = {};
    for (const c of [1, 4, 8]) {
      result.search_concurrency[c] = await measure(
        120,
        () => transaction((db) => search(db, searches.combined)),
        c,
      );
      await closePits();
    }
    result.chapter = await measure(200, () =>
      transaction(async (db) => {
        const { manifest } = await loadSnapshot(db, work);
        await chapterBytes(db, manifest, manifest.chapters[0]);
      }),
    );
    result.tables = (
      await pool.query(
        "SELECT relname,pg_total_relation_size(relid) total_bytes,pg_indexes_size(relid) index_bytes,n_live_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20",
      )
    ).rows;
  } else if (mode === "packs") {
    const locators = (
      await pool.query(
        `SELECT encode(o.hash,'hex') hash,k.name kind,p.name pack,o.byte_offset,o.length,o.size FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id JOIN archive_packs p ON p.id=o.pack_id WHERE k.name='chapter_html' ORDER BY o.hash LIMIT 1000`,
      )
    ).rows.map((r) => ({
      ...r,
      offset: Number(r.byte_offset),
      length: Number(r.length),
      size: Number(r.size),
    }));
    result.reads = {};
    for (const c of [1, 4, 8]) {
      let bytes = 0;
      const r = await measure(
        1000,
        async (i) => {
          const data = await archive.store.read(
            locators[(i * 73) % locators.length],
          );
          bytes += data.length;
        },
        c,
      );
      result.reads[c] = {
        ...r,
        bytes,
        mib_per_second: bytes / 1048576 / r.seconds,
      };
    }
    const codec = require("../apps/api/native/build/codec.node");
    const data = await Promise.all(
      locators.slice(0, 256).map((r) => archive.store.read(r)),
    );
    const bytes = data.reduce((n, b) => n + b.length, 0);
    result.codec = {};
    for (const level of [1, 3]) {
      const t = performance.now();
      const encoded = await codec.batch(data, level, false);
      const e = (performance.now() - t) / 1000;
      const t2 = performance.now();
      const decoded = await codec.batch(
        encoded,
        data.map((b) => b.length),
        true,
      );
      const d = (performance.now() - t2) / 1000;
      for (let i = 0; i < data.length; i++)
        assert.deepEqual(decoded[i], data[i]);
      result.codec[level] = {
        objects: data.length,
        raw_bytes: bytes,
        compressed_bytes: encoded.reduce((n, b) => n + b.length, 0),
        encode_seconds: e,
        decode_seconds: d,
        encode_mib_s: bytes / 1048576 / e,
        decode_mib_s: bytes / 1048576 / d,
      };
    }
  } else if (mode === "storage") {
    const { findObjects } = require("../apps/api/dist/archive-catalog");
    const rows = (
      await pool.query(
        "SELECT manifest_hash FROM archive_snapshots ORDER BY id",
      )
    ).rows;
    const sizes = new Map(
      (
        await pool.query(
          "SELECT encode(hash,'hex') hash,size FROM archive_object_data",
        )
      ).rows.map((r) => [r.hash, Number(r.size)]),
    );
    let references = 0,
      bytes = 0,
      chapters = 0;
    const hashes = new Set();
    for (let i = 0; i < rows.length; i += 64) {
      const locators = await transaction((db) =>
        findObjects(
          db,
          rows.slice(i, i + 64).map((r) => r.manifest_hash),
        ),
      );
      for (const b of await archive.store.readMany(
        locators.map((r) => ({
          ...r,
          offset: Number(r.byte_offset),
          length: Number(r.length),
          size: Number(r.size),
        })),
      )) {
        const m = JSON.parse(b);
        chapters += m.chapters.length;
        for (const o of m.objects) {
          references++;
          hashes.add(o.hash);
          bytes += sizes.get(o.hash);
        }
      }
    }
    result.components = {
      logical_references: references,
      unique_objects: hashes.size,
      logical_bytes: bytes,
      chapters,
      dedup_percent: 100 * (1 - hashes.size / references),
    };
    result.kinds = (
      await pool.query(
        `SELECT k.name,count(*) objects,sum(o.size) raw_bytes,sum(o.length) record_bytes FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id GROUP BY k.name ORDER BY k.name`,
      )
    ).rows;
    result.metadata = (
      await pool.query(
        `SELECT count(*) works,count(*) FILTER(WHERE NOT(metadata ? 'published')) without_publication,count(*) FILTER(WHERE NOT(metadata ? 'complete')) without_completion,count(*) FILTER(WHERE jsonb_array_length(coalesce(metadata->'creators','[]'))=0) without_author FROM catalog_documents`,
      )
    ).rows[0];
  } else if (mode === "verify") {
    let cursor = "",
      verified = 0;
    const t = performance.now();
    while (true) {
      const rows = (
        await pool.query(
          `SELECT encode(o.hash,'hex') hash,k.name kind,p.name pack,o.byte_offset,o.length,o.size FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id JOIN archive_packs p ON p.id=o.pack_id WHERE o.hash>decode($1,'hex') ORDER BY o.hash LIMIT 256`,
          [cursor],
        )
      ).rows;
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += 8)
        await Promise.all(
          rows.slice(i, i + 8).map((r) =>
            archive.store.read({
              ...r,
              offset: Number(r.byte_offset),
              length: Number(r.length),
              size: Number(r.size),
            }),
          ),
        );
      verified += rows.length;
      cursor = rows.at(-1).hash;
    }
    result.verified = verified;
    result.verify_seconds = (performance.now() - t) / 1000;
  } else throw Error("Unknown measurement mode");
  result.counts = await counts();
  result.seconds = (performance.now() - start) / 1000;
  fs.writeFileSync(
    join("/results", process.env.BENCH_LABEL || mode) + ".json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({ mode, seconds: result.seconds, counts: result.counts }),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
