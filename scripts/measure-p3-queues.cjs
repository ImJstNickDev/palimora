// Isolated relation-shape probe. Synthetic UUIDs, no corpus text or live queue mutations.
const fs = require("node:fs"),
  { Pool } = require("pg");
const url = new URL(process.env.DATABASE_URL);
if (!url.pathname.endsWith("_test")) throw Error("Private database required");
const pool = new Pool({ connectionString: url.toString(), max: 1 });
(async () => {
  const db = await pool.connect();
  const schema = "probe_p3_" + Date.now();
  const results = [];
  const lsn = async () =>
    (await db.query("SELECT pg_current_wal_insert_lsn() lsn")).rows[0].lsn;
  const delta = async (start) =>
    Number(
      (
        await db.query(
          "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) n",
          [start],
        )
      ).rows[0].n,
    );
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    for (const [name, key] of [
      ["catalog_pending", "work_id"],
      ["catalog_snapshot_pending", "snapshot_id"],
      ["catalog_text_pending", "work_id"],
    ]) {
      const table = schema + "." + name;
      await db.query(`CREATE TABLE ${table} (LIKE ${name} INCLUDING ALL)`);
      const size = async () =>
        (
          await db.query(
            `SELECT pg_total_relation_size('${table}')::float bytes,pg_indexes_size('${table}')::float index_bytes,pg_relation_size('${table}')::float heap_bytes`,
          )
        ).rows[0];
      const empty = await size();
      const before = await lsn(),
        start = performance.now();
      await db.query(
        `INSERT INTO ${table}(${key}${name === "catalog_text_pending" ? ",revision" : ""}) SELECT md5(i::text)::uuid${name === "catalog_text_pending" ? ",i" : ""} FROM generate_series(1,100000) i`,
      );
      const enqueue_ms = performance.now() - start,
        enqueue_wal = await delta(before),
        full = await size();
      const overhead = {};
      for (const [label, sql] of Object.entries({
        bytes: `SELECT pg_total_relation_size('${table}')`,
        bounded: `SELECT EXISTS(SELECT 1 FROM ${table} OFFSET 65535 LIMIT 1)`,
        count: `SELECT count(*) FROM ${table}`,
      })) {
        const t = performance.now();
        for (let i = 0; i < 20; i++) await db.query(sql);
        overhead[label + "_mean_ms"] = (performance.now() - t) / 20;
      }
      const del = await lsn(),
        d = performance.now();
      await db.query(`DELETE FROM ${table}`);
      const dequeue_ms = performance.now() - d,
        dequeue_wal = await delta(del),
        deleted = await size();
      const vacuumStart = performance.now();
      await db.query(`VACUUM (ANALYZE) ${table}`);
      const vacuum_ms = performance.now() - vacuumStart,
        vacuumed = await size();
      const refillStart = await lsn();
      await db.query(
        `INSERT INTO ${table}(${key}${name === "catalog_text_pending" ? ",revision" : ""}) SELECT md5(i::text)::uuid${name === "catalog_text_pending" ? ",i" : ""} FROM generate_series(1,100000) i`,
      );
      const reused = await size();
      results.push({
        queue: name,
        rows: 100000,
        empty,
        full,
        bytes_per_pending: (full.bytes - empty.bytes) / 100000,
        enqueue_ms,
        enqueue_wal,
        dequeue_ms,
        dequeue_wal,
        deleted,
        vacuum_ms,
        vacuumed,
        refill_wal: await delta(refillStart),
        reused,
        probe: overhead,
        extrapolated_1000000_bytes:
          (full.bytes - empty.bytes) * 10 + empty.bytes,
      });
    }
    fs.writeFileSync(
      "/results/p3-queue-cost.json",
      JSON.stringify(
        {
          rows_direct: 100000,
          results,
          limits: [
            "Logged clones retain actual columns, defaults and indexes, but have no foreign keys or product triggers. UUID-only synthetic rows; not canonical ingest throughput.",
            "WAL is cluster-wide during this otherwise idle isolated fixture; full-page images/checkpoint phase affect bytes.",
            "One-million estimates are linear extrapolations, not a dump-wide forecast.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    db.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
