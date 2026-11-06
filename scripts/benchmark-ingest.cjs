const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const { readFileSync, mkdirSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!process.env.BENCH_STORAGE_ROOT)
  throw Error("BENCH_STORAGE_ROOT must point to isolated benchmark storage");
const { Pool } = require("pg");
if (!new URL(process.env.DATABASE_URL).pathname.includes("_test"))
  throw Error("Test database required");
const schema =
  process.env.BENCH_SCHEMA ||
  "bench_ingest_" + randomUUID().replaceAll("-", "");
if (!/^bench_ingest_[a-z0-9]+$/.test(schema))
  throw Error("Test schema required");
if (process.env.BENCH_VERIFY_ONLY && !process.env.BENCH_SCHEMA)
  throw Error("Verification requires an existing benchmark schema");
process.env.ARCHIVE_ROOT = join(
  resolve(process.env.BENCH_STORAGE_ROOT),
  schema,
);
mkdirSync(process.env.ARCHIVE_ROOT, { recursive: true, mode: 0o700 });
if (process.env.BENCH_GROUP_MIB) {
  const mib = Number(process.env.BENCH_GROUP_MIB);
  if (!Number.isInteger(mib) || mib < 1 || mib > 128)
    throw Error("BENCH_GROUP_MIB must be 1–128");
  const child = require("node:child_process"),
    spawn = child.spawn;
  child.spawn = function (command, args, options) {
    if (command === "python3" && options?.env?.PALIMORA_ADAPTER_GROUP_BYTES)
      options = {
        ...options,
        env: {
          ...options.env,
          PALIMORA_ADAPTER_GROUP_BYTES: String(mib * 1024 * 1024),
          ...(process.env.BENCH_CACHE_LOOKUP === "0"
            ? { PALIMORA_ADAPTER_CACHE: "0" }
            : {}),
        },
      };
    return spawn(command, args, options);
  };
}
const source = process.env.BENCH_SOURCE ?? "queue119_archive05.zip";
if (!/^[^/\\]+\.(zip|sqlite3)$/.test(source))
  throw Error("Expected a source basename");
function cpu() {
  try {
    return (
      Number(
        readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(
          /usage_usec (\d+)/,
        )[1],
      ) / 1e6
    );
  } catch {
    return null;
  }
}
(async () => {
  const init = new Pool({ connectionString: process.env.DATABASE_URL });
  if (!process.env.BENCH_SCHEMA) await init.query(`CREATE SCHEMA ${schema}`);
  await init.end();
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + schema);
  process.env.DATABASE_URL = url.toString();
  const { pool, migrate } = require("../apps/api/dist/db");
  const archive = require("../apps/api/dist/archive");
  if (!process.env.BENCH_VERIFY_ONLY) await migrate();
  const finishProfile =
    process.env.BENCH_DETAIL === "1" && !process.env.BENCH_VERIFY_ONLY
      ? await require("./ingest-profiler.cjs").start({ archive, pool })
      : null;
  let stopped = false;
  const stages = {},
    sql = {};
  let records = 0;
  function record(name, ms) {
    const v = (stages[name] ??= { calls: 0, ms: 0 });
    v.calls++;
    v.ms += ms;
  }
  const connect = pool.connect.bind(pool);
  pool.connect = function (cb) {
    const prep = (c) => {
      if (!c.__profile) {
        c.__profile = true;
        const query = c.query.bind(c);
        c.query = function (...args) {
          if (
            process.env.BENCH_SQL_SPLIT === "1" &&
            typeof args[0] === "string" &&
            args[0].startsWith("INSERT INTO archive_paths") &&
            args[0].includes(";")
          )
            return (async () => {
              const results = [];
              for (const statement of args[0].split(";"))
                results.push(await c.query(statement));
              return results;
            })();

          const key = String(args[0]).replace(/\s+/g, " ").slice(0, 100),
            start = performance.now();
          const last = args.at(-1);
          const done = () => {
            const v = (sql[key] ??= { calls: 0, ms: 0 });
            v.calls++;
            v.ms += performance.now() - start;
          };
          if (typeof last === "function") {
            args[args.length - 1] = (...v) => {
              done();
              last(...v);
            };
            return query(...args);
          }
          const result = query(...args);
          if (result && typeof result.finally === "function")
            return result.finally(done);
          result.once("finish", done);
          return result;
        };
      }
      return c;
    };
    if (cb)
      return connect((err, c, release) => cb(err, err ? c : prep(c), release));
    return connect().then(prep);
  };
  const write = archive.store.write.bind(archive.store);
  archive.store.write = async (...args) => {
    const start = performance.now();
    try {
      return await write(...args);
    } finally {
      record("pack_write_seal_verify", performance.now() - start);
    }
  };
  const ingest = archive.ingestRecord;
  archive.ingestRecord = async (...args) => {
    const start = performance.now();
    await ingest(...args);
    record("ingest_record", performance.now() - start);
    records++;
    if (
      Number(process.env.BENCH_LIMIT) > 0 &&
      records >= Number(process.env.BENCH_LIMIT)
    ) {
      stopped = true;
      process.emit("SIGTERM");
    }
  };
  if (archive.ingestRecords) {
    const many = archive.ingestRecords;
    archive.ingestRecords = async (source, entries) => {
      const remaining =
        Number(process.env.BENCH_LIMIT) > 0
          ? Number(process.env.BENCH_LIMIT) - records
          : entries.length;
      const actual = entries.slice(0, remaining);
      const start = performance.now();
      await many(source, actual);
      record("ingest_group", performance.now() - start);
      records += actual.length;
      if (
        Number(process.env.BENCH_LIMIT) > 0 &&
        records >= Number(process.env.BENCH_LIMIT)
      ) {
        stopped = true;
        process.emit("SIGTERM");
      }
    };
    const factory = archive.store.writer.bind(archive.store);
    archive.store.writer = () => {
      const writer = factory();
      for (const name of ["append", "finish"]) {
        const fn = writer[name].bind(writer);
        writer[name] = async (...args) => {
          const start = performance.now();
          try {
            return await fn(...args);
          } finally {
            record("pack_" + name, performance.now() - start);
          }
        };
      }
      return writer;
    };
  }
  if (process.env.BENCH_VERIFY_ONLY) {
    const start = performance.now();
    let cursor = "",
      verified = 0,
      canonicalVerified = 0;
    while (true) {
      const rows = (
        await pool.query(
          "SELECT encode(o.hash,'hex') AS hash,k.name AS kind,p.name AS pack,o.byte_offset,o.length,o.size FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id JOIN archive_packs p ON p.id=o.pack_id WHERE o.hash>decode($1,'hex') ORDER BY o.hash LIMIT 256",
          [cursor],
        )
      ).rows;
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += 4)
        await Promise.all(
          rows.slice(i, i + 4).map(async (r) => {
            const bytes = await archive.store.read({
              ...r,
              offset: Number(r.byte_offset),
              length: Number(r.length),
              size: Number(r.size),
            });
            if (["metadata", "manifest", "observation"].includes(r.kind)) {
              const { canonical, sha } = require("../apps/api/dist/pack");
              const value = JSON.parse(bytes);
              if (!canonical(value).equals(bytes))
                throw Error("CANONICAL_BYTES_MISMATCH");
              if (
                r.kind === "manifest" &&
                value.metadata_hash !==
                  sha(
                    canonical({
                      schema: "palimora-metadata-v1",
                      metadata: value.metadata,
                    }),
                  )
              )
                throw Error("MANIFEST_METADATA_MISMATCH");
              canonicalVerified++;
            }
          }),
        );
      verified += rows.length;
      cursor = rows.at(-1).hash;
    }
    const {
      readPayloads,
      readParseCache,
    } = require("../apps/api/dist/archive-catalog");
    const db = await pool.connect();
    let payloads = 0,
      caches = 0;
    try {
      let after = Buffer.alloc(0);
      while (true) {
        const rows = (
          await db.query(
            "SELECT hash FROM archive_payloads WHERE hash>$1 ORDER BY hash LIMIT 256",
            [after],
          )
        ).rows;
        if (!rows.length) break;
        await readPayloads(
          db,
          rows.map((r) => r.hash),
        );
        payloads += rows.length;
        after = rows.at(-1).hash;
      }
      for (const parser of (
        await db.query("SELECT id,name FROM archive_parsers")
      ).rows) {
        let after = Buffer.alloc(0);
        while (true) {
          const rows = (
            await db.query(
              "SELECT source_hash FROM archive_cache_data WHERE parser_id=$1 AND source_hash>$2 ORDER BY source_hash LIMIT 256",
              [parser.id, after],
            )
          ).rows;
          if (!rows.length) break;
          const found = await readParseCache(
            db,
            parser.name,
            rows.map((r) => r.source_hash.toString("hex")),
          );
          if (found.length !== rows.length) throw Error("CACHE_COUNT");
          caches += rows.length;
          after = rows.at(-1).source_hash;
        }
      }
    } finally {
      db.release();
    }
    console.log(
      JSON.stringify(
        {
          schema,
          verified,
          canonical_verified: canonicalVerified,
          payloads_verified: payloads,
          caches_verified: caches,
          seconds: (performance.now() - start) / 1000,
          source_available: existsSync(
            join(process.env.AO3_DUMP_ROOT ?? "/dumps/ao3_stories", source),
          ),
        },
        null,
        2,
      ),
    );
    await pool.end();
    return;
  }
  const { tick } = require("../apps/api/dist/ingest-worker");
  let batch;
  if (process.env.BENCH_RESUME)
    batch = (
      await pool.query(
        "SELECT id FROM ingest_batches ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0].id;
  else {
    batch = randomUUID();
    await pool.query(
      "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,$3)",
      [batch, [source], process.env.BENCH_REPROCESS === "1"],
    );
  }
  const start = performance.now(),
    startCpu = cpu();
  if (process.env.BENCH_QUEUE === "1") {
    const { runQueue } = require("../apps/api/dist/archive-queue");
    const monitor = setInterval(
      () =>
        void pool
          .query(
            "SELECT state,NOT EXISTS(SELECT 1 FROM archive_outbox WHERE NOT EXISTS(SELECT 1 FROM archive_dispatch WHERE event_id=archive_outbox.id)) AS delivered FROM ingest_batches WHERE id=$1",
            [batch],
          )
          .then((r) => {
            if (
              [
                "completed",
                "completed_with_gaps",
                "failed_global",
                "parser_blocked",
                "paused",
              ].includes(r.rows[0]?.state) &&
              (!r.rows[0].state.startsWith("completed") || r.rows[0].delivered)
            )
              stopped = true;
          })
          .catch(() => {
            stopped = true;
          }),
      500,
    );
    try {
      await runQueue(tick, () => stopped);
    } finally {
      clearInterval(monitor);
    }
  } else await tick(batch);
  const seconds = (performance.now() - start) / 1000;
  const detail = finishProfile ? await finishProfile() : undefined;
  const result = {
    detail,
    configuration: {
      records: process.env.INGEST_GROUP_RECORDS ?? 256,
      workers: process.env.INGEST_PARSER_WORKERS ?? 2,
      group_mib: process.env.BENCH_GROUP_MIB ?? 16,
    },
    schema,
    batch,
    queue: process.env.BENCH_QUEUE === "1",
    seconds,
    cpu_seconds: cpu() - startCpu,
    records,
    rate: records / seconds,
    stages,
    sql_total_calls: Object.values(sql).reduce((n, v) => n + v.calls, 0),
    sql: Object.entries(sql)
      .map(([query, v]) => ({ query, ...v }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, process.env.BENCH_DETAIL === "1" ? 100 : 18),
    batch_state: (
      await pool.query(
        "SELECT state,error,extract(epoch from (finished_at-started_at)) AS seconds FROM ingest_batches WHERE id=$1",
        [batch],
      )
    ).rows[0],
    sources: (
      await pool.query(
        "SELECT path,state,imported,checkpoint,gaps,duplicates FROM ingest_sources WHERE batch_id=$1",
        [batch],
      )
    ).rows,
    outbox: (
      await pool.query(
        "SELECT count(*) AS total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM archive_dispatch WHERE event_id=archive_outbox.id)) AS delivered FROM archive_outbox",
      )
    ).rows[0],
    catalog: (
      await pool.query(`SELECT sum(pg_total_relation_size(c.oid))::text AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`)
    ).rows[0],
    counts: (
      await pool.query(
        "SELECT count(*) AS objects,count(DISTINCT pack) AS packs,sum(length) AS packed_bytes,(SELECT count(*) FROM archive_works) AS works,(SELECT count(*) FROM archive_snapshots) AS snapshots FROM archive_objects",
      )
    ).rows[0],
  };
  try {
    result.memory_peak_bytes = Number(
      readFileSync("/sys/fs/cgroup/memory.peak", "utf8"),
    );
    result.io = readFileSync("/sys/fs/cgroup/io.stat", "utf8");
  } catch {}
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
