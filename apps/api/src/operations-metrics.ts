import { pool, transaction, DB } from "./db";
import { archiveOperation } from "./archive-admin";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { syncGate } from "./ao3-policy";
export const latencyBounds = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  30000,
  Infinity,
];
type HttpBucket = {
  bucket: string;
  kind: string;
  requests: number;
  errors: number;
  total: number;
  max: number;
  histogram: number[];
};
let pending = new Map<string, HttpBucket>();
export function recordRequest(ms: number, status: number, search = false) {
  if (!Number.isFinite(ms)) return;
  for (const kind of search ? ["api", "search"] : ["api"]) {
    const bucket = new Date(
        Math.floor(Date.now() / 60000) * 60000,
      ).toISOString(),
      key = bucket + kind;
    const b = pending.get(key) ?? {
      bucket,
      kind,
      requests: 0,
      errors: 0,
      total: 0,
      max: 0,
      histogram: latencyBounds.map(() => 0),
    };
    b.requests++;
    b.errors += status >= 500 ? 1 : 0;
    b.total += ms;
    b.max = Math.max(b.max, ms);
    b.histogram[latencyBounds.findIndex((n) => ms <= n)]++;
    pending.set(key, b);
  }
  // Bounded ten-minute buffer during database outage; no request or user identifiers.
  for (const [key, b] of pending)
    if (Date.parse(b.bucket) < Date.now() - 600000) pending.delete(key);
}
export async function flushRequests() {
  const batch = pending;
  pending = new Map();
  try {
    await transaction(async (db) => {
      for (const b of batch.values())
        await db.query(
          `INSERT INTO operations_http VALUES($1,60,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(step,bucket,kind) DO UPDATE SET requests=operations_http.requests+excluded.requests,errors=operations_http.errors+excluded.errors,total_ms=operations_http.total_ms+excluded.total_ms,max_ms=greatest(operations_http.max_ms,excluded.max_ms),histogram=operations_histogram_add(operations_http.histogram,excluded.histogram)`,
          [b.bucket, b.kind, b.requests, b.errors, b.total, b.max, b.histogram],
        );
    });
  } catch {
    for (const [key, b] of batch) {
      if (Date.parse(b.bucket) < Date.now() - 600000) continue;
      const newer = pending.get(key);
      if (newer) {
        b.requests += newer.requests;
        b.errors += newer.errors;
        b.total += newer.total;
        b.max = Math.max(b.max, newer.max);
        b.histogram = b.histogram.map((n, i) => n + newer.histogram[i]);
      }
      pending.set(key, b);
    }
  }
}
export async function status(
  db: Pick<DB, "query">,
  name: string,
  value: object,
) {
  await db.query(
    "INSERT INTO operations_status(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=$2,checked_at=now()",
    [name, value],
  );
}
export async function gauges(
  db: DB,
  series: string,
  values: Record<string, unknown>,
  at = new Date(),
) {
  const rows = Object.entries(values)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([metric, v]) => ({ metric, value: v }));
  if (!rows.length) return;
  await db.query(
    `INSERT INTO operations_metrics SELECT date_trunc('minute',$1::timestamptz),60,$2,metric,1,value,value,value FROM jsonb_to_recordset($3::jsonb) AS x(metric text,value double precision)
 ON CONFLICT(step,bucket,series,metric) DO UPDATE SET n=operations_metrics.n+1,total=operations_metrics.total+excluded.total,peak=greatest(operations_metrics.peak,excluded.peak),last=excluded.last`,
    [at, series, JSON.stringify(rows)],
  );
}
export async function compactMetrics(db: DB) {
  await db.query(`INSERT INTO operations_metrics SELECT date_trunc('hour',bucket),3600,series,metric,sum(n),sum(total),max(peak),(array_agg(last ORDER BY bucket DESC))[1] FROM operations_metrics WHERE step=60 AND bucket<date_trunc('hour',now()) GROUP BY 1,series,metric
 ON CONFLICT(step,bucket,series,metric) DO UPDATE SET n=excluded.n,total=excluded.total,peak=excluded.peak,last=excluded.last`);
  await db.query(`INSERT INTO operations_http
 SELECT date_trunc('hour',h.bucket),3600,h.kind,sum(requests),sum(errors),sum(total_ms),max(max_ms),
 ARRAY[${latencyBounds.map((_, i) => `sum(histogram[${i + 1}])::bigint`).join(",")}]
 FROM operations_http h WHERE h.step=60 AND h.bucket<date_trunc('hour',now()) GROUP BY 1,h.kind
 ON CONFLICT(step,bucket,kind) DO UPDATE SET requests=excluded.requests,errors=excluded.errors,total_ms=excluded.total_ms,max_ms=excluded.max_ms,histogram=excluded.histogram`);
  // Delete whole hours only, so a later compaction never replaces a full hour with a partial hour.
  await db.query(
    "DELETE FROM operations_metrics WHERE (step=60 AND bucket<date_trunc('hour',now())-interval '24 hours') OR bucket<now()-interval '30 days'; DELETE FROM operations_http WHERE (step=60 AND bucket<date_trunc('hour',now())-interval '24 hours') OR bucket<now()-interval '30 days'; DELETE FROM operations_index_runs WHERE id NOT IN(SELECT id FROM operations_index_runs ORDER BY id DESC LIMIT 5000) OR finished_at<now()-interval '30 days'",
  );
}
let queues: any[] | undefined;
async function queueCounts() {
  if (!queues) {
    const { Queue } = await import("bullmq");
    queues = ["ingest", "ao3", "archive-events", "backup"].map((name) => {
      const q = new Queue("palimora-" + name + "-v1", {
        connection: {
          host: process.env.REDIS_HOST ?? "redis",
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
        },
      });
      q.on("error", () => {});
      return q;
    });
  }
  return Promise.all(
    queues.map(async (q) => ({
      name: q.name,
      ...(await q.getJobCounts(
        "waiting",
        "prioritized",
        "active",
        "delayed",
        "failed",
        "paused",
      )),
    })),
  );
}
let previous:
  | { at: number; ingest: number; sync: number; index: number }
  | undefined;
export async function collectOperations() {
  const leader = await pool.connect();
  let owned = false;
  try {
    owned = (await leader.query("SELECT pg_try_advisory_lock(70210470) AS yes"))
      .rows[0].yes;
    if (!owned) return;
    const external = await Promise.allSettled([
      fetch(
        (process.env.OPERATIONS_COLLECTOR_URL ?? "http://collector:9100") +
          "/snapshot",
        { signal: AbortSignal.timeout(5000) },
      ).then(async (r) => {
        if (!r.ok) throw Error();
        return r.json();
      }),
      queueCounts(),
      fetch(
        (process.env.OPENSEARCH_URL ?? "http://opensearch:9200") +
          "/palimora-works-v2/_stats/store",
        { signal: AbortSignal.timeout(3000) },
      ).then(async (r) => {
        if (!r.ok) throw Error();
        return r.json();
      }),
    ]);
    await transaction(async (db) => {
      const [docker, redis, search] = external;
      if (
        docker.status === "fulfilled" &&
        Array.isArray(docker.value.containers) &&
        docker.value.containers.length <= 64
      ) {
        const value = docker.value,
          fresh =
            value.at &&
            Date.now() - Date.parse(value.at) < 45000 &&
            !value.error;
        await status(db, "containers", { ...value, fresh });
        if (fresh) {
          const grouped: Record<string, Record<string, number>> = {};
          for (const c of value.containers) {
            const target = (grouped[c.service] ??= {});
            target.running =
              (target.running ?? 0) + (c.state === "running" ? 1 : 0);
            for (const [k, v] of Object.entries(c.metrics ?? {}))
              if (typeof v === "number" && Number.isFinite(v))
                target[k] = (target[k] ?? 0) + v;
          }
          const old = (
            await db.query(
              "SELECT value FROM operations_status WHERE name='collector-sample'",
            )
          ).rows[0]?.value?.at;
          if (old !== value.at) {
            for (const [service, metrics] of Object.entries(grouped))
              await gauges(
                db,
                "container:" + service,
                metrics,
                new Date(value.at),
              );
            await status(db, "collector-sample", { at: value.at });
          }
        }
      } else
        await status(db, "containers", {
          fresh: false,
          error: "COLLECTOR_UNAVAILABLE",
          containers: [],
        });
      if (redis.status === "fulfilled") {
        await status(db, "queues", { available: true, items: redis.value });
        for (const q of redis.value) {
          q.waiting += q.prioritized;
          await gauges(
            db,
            q.name,
            Object.fromEntries(
              ["waiting", "active", "delayed", "failed", "paused"].map((k) => [
                k,
                q[k],
              ]),
            ),
          );
        }
      } else
        await status(db, "queues", {
          available: false,
          error: "REDIS_UNAVAILABLE",
          items: [],
        });
      await status(db, "search", {
        available: search.status === "fulfilled",
        bytes:
          search.status === "fulfilled"
            ? (search.value._all?.total?.store?.size_in_bytes ?? null)
            : null,
      });
      if (search.status === "fulfilled")
        await gauges(db, "storage", {
          index_bytes: search.value._all?.total?.store?.size_in_bytes,
        });
      const appAt = (
        await db.query(
          "SELECT checked_at FROM operations_status WHERE name='application'",
        )
      ).rows[0]?.checked_at;
      if (!appAt || Date.now() - new Date(appAt).getTime() > 60000) {
        const counts = (
          await db.query(`SELECT
    (SELECT coalesce(sum(imported),0)::float8 FROM ingest_sources) AS ingest,
    (SELECT count(*)::float8 FROM ao3_runs WHERE finished_at IS NOT NULL) AS sync,
    (SELECT sum(processed)::float8 FROM operations_index) AS index,
    (SELECT count(*)::int FROM catalog_pending)+(SELECT count(*)::int FROM catalog_snapshot_pending) AS catalog_pending,
    (SELECT count(*)::int FROM catalog_text_pending) AS search_pending,
    (SELECT count(*)::int FROM users WHERE NOT disabled AND soft_deleted_at IS NULL) AS users`)
        ).rows[0];
        const now = Date.now();
        const rates: Record<string, number | null> = {
          ingest_per_second: null,
          sync_per_minute: null,
          index_per_second: null,
        };
        if (previous && now - previous.at < 180000) {
          const seconds = (now - previous.at) / 1000;
          for (const [key, metric, multiple] of [
            ["ingest", "ingest_per_second", 1],
            ["sync", "sync_per_minute", 60],
            ["index", "index_per_second", 1],
          ] as const)
            if (counts[key] >= previous[key])
              rates[metric] =
                ((counts[key] - previous[key]) / seconds) * multiple;
        }
        previous = {
          at: now,
          ingest: counts.ingest,
          sync: counts.sync,
          index: counts.index,
        };
        await gauges(db, "application", { ...counts, ...rates });
        await status(db, "application", { ...counts, ...rates });
        const countsByKind = (
          await db.query(
            `SELECT family,state,count(*)::int AS count FROM operations_jobs GROUP BY family,state`,
          )
        ).rows;
        await status(db, "jobs", { counts: countsByKind });
        const sync = (
          await db.query(
            "SELECT mode,paused,observed_state,checked_at,cooldown_until FROM ao3_control",
          )
        ).rows[0];
        await status(db, "sync", { ...sync, gate: syncGate(sync) });
      }
      const retention = (
        await db.query(
          "SELECT checked_at FROM operations_status WHERE name='retention'",
        )
      ).rows[0]?.checked_at;
      if (!retention || Date.now() - new Date(retention).getTime() > 900000) {
        await compactMetrics(db);
        await status(db, "retention", {});
      }
    });
  } finally {
    if (owned) await leader.query("SELECT pg_advisory_unlock(70210470)");
    leader.release();
  }
}
export async function collectStorage() {
  const leader = await pool.connect();
  let owned = false;
  try {
    owned = (await leader.query("SELECT pg_try_advisory_lock(70210471) AS yes"))
      .rows[0].yes;
    if (!owned) return;
    await transaction(async (db) => {
      const storage = await archiveOperation(db, "archiveStorage", {});
      let physical: number | null = 0;
      try {
        const dir = await opendir(
          join(process.env.ARCHIVE_ROOT ?? "/storage", "packs"),
        );
        for await (const item of dir)
          if (item.isFile())
            physical += (
              await stat(
                join(
                  process.env.ARCHIVE_ROOT ?? "/storage",
                  "packs",
                  item.name,
                ),
              )
            ).size;
      } catch {
        physical = null;
      }
      const database = Number(
        (
          await db.query(
            "SELECT pg_database_size(current_database())::text AS bytes",
          )
        ).rows[0].bytes,
      );
      const media = storage.kinds
        .filter((k: any) =>
          ["asset", "media", "image", "stylesheet"].includes(k.kind),
        )
        .reduce((n: number, k: any) => n + Number(k.packed_bytes), 0);
      const value = {
        database_bytes: database,
        pack_bytes: physical,
        referenced_pack_bytes: Number(storage.packed_bytes),
        media_bytes: media,
        free_bytes: storage.available_bytes,
        total_bytes: storage.total_bytes,
      };
      await status(db, "storage", value);
      await gauges(db, "storage", value);
    });
  } catch {
    await status(pool, "storage", { error: "STORAGE_SAMPLE_FAILED" });
  } finally {
    if (owned) await leader.query("SELECT pg_advisory_unlock(70210471)");
    leader.release();
  }
}
export function startOperations() {
  let running: Promise<unknown> | undefined,
    flushing: Promise<unknown> | undefined,
    storage: Promise<unknown> | undefined,
    lastStorage = 0;
  const sample = () =>
    (running ??= collectOperations()
      .catch(() =>
        console.error(JSON.stringify({ event: "operations_sample_failed" })),
      )
      .finally(() => {
        running = undefined;
      }));
  const flush = () =>
    (flushing ??= flushRequests().finally(() => {
      flushing = undefined;
    }));
  const tick = () => {
    void sample();
    void flush();
    if (!storage && Date.now() - lastStorage > 300000) {
      lastStorage = Date.now();
      storage = collectStorage()
        .catch(() => {})
        .finally(() => {
          storage = undefined;
        });
    }
  };
  const timer = setInterval(tick, 10000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
    await flushing;
    await storage;
    await flushRequests();
    for (const q of queues ?? []) await q.close();
    queues = undefined;
  };
}
