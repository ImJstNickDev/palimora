import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pool } from "pg";

const GiB = 1024 ** 3;
export type PressureMode = "conservative" | "throughput-first";
export type PressureSample = {
  at: number;
  disks: { name: string; free: number; total: number }[];
  staging: number;
  queues: number;
  queueLimit: boolean;
  database: number;
  wal: number;
};
export type PressureDecision = {
  state: "ready" | "warn" | "slow" | "wait" | "stop";
  reason: string;
};
export function pressureConfig(env = process.env) {
  const mode = env.INGEST_PRESSURE_MODE ?? "conservative";
  if (!["conservative", "throughput-first"].includes(mode))
    throw Error(
      "INGEST_PRESSURE_MODE must be conservative or throughput-first",
    );
  function gib(name: string, fallback: number) {
    const n = Number(env[name] ?? fallback);
    if (!Number.isFinite(n) || n < 0.25 || n > 1024)
      throw Error(`${name} must be 0.25–1024 GiB`);
    return n * GiB;
  }
  return {
    mode: mode as PressureMode,
    reserve: gib("INGEST_DISK_RESERVE_GIB", 8),
    backlog: gib("INGEST_BACKLOG_GIB", 8),
    staging: gib("INGEST_STAGING_GIB", 4),
  };
}
export type PressureConfig = ReturnType<typeof pressureConfig>;

/** Pure policy; injection is a constructor dependency, never an environment fake. */
export class IngestPressure {
  private sample?: PressureSample;
  private pending?: Promise<void>;
  private checked = 0;
  private held = false;
  private last = "";
  private reportedAt = 0;
  private previous?: PressureSample;
  readonly metrics = { checks: 0, checkMs: 0, waitMs: 0, slowMs: 0 };
  constructor(
    readonly config: PressureConfig,
    private collect: () => Promise<PressureSample>,
    private now = Date.now,
  ) {}
  async inspect(): Promise<PressureDecision> {
    if (!this.pending && this.now() - this.checked >= 1000) {
      this.checked = this.now();
      this.pending = this.collect()
        .then((s) => {
          this.sample = s;
        })
        .catch(() => {
          this.sample = undefined;
        })
        .finally(() => {
          this.metrics.checks++;
          this.metrics.checkMs += this.now() - this.checked;
          this.pending = undefined;
        });
    }
    await this.pending;
    const s = this.sample;
    let decision: PressureDecision = { state: "ready", reason: "capacity" };
    if (!s || this.now() - s.at > 5000)
      decision = { state: "wait", reason: "capacity_unavailable" };
    else if (this.config.mode === "conservative") {
      if (s.queueLimit)
        decision = { state: "wait", reason: "downstream_count" };
    } else {
      const reserve = this.config.reserve;
      const ratios = s.disks.map((d) => {
        const before = this.previous?.disks.find((p) => p.name === d.name);
        const elapsed = this.previous ? (s.at - this.previous.at) / 1000 : 0;
        // Ten seconds of observed filesystem consumption, including WAL and
        // other writers. Never subtract the configured durable reserve.
        const growth =
          before && elapsed > 0
            ? Math.max(0, (before.free - d.free) / elapsed) * 10
            : 0;
        const base =
          d.name === "temporary" ? Math.min(reserve, d.total * 0.1) : reserve;
        return d.free / Math.max(base, growth);
      });
      if (!this.previous || s.at > this.previous.at) this.previous = s;
      const free = Math.min(...ratios);
      const backlog = s.queues / this.config.backlog;
      if (!ratios.length || ratios.some((n) => !Number.isFinite(n)))
        decision = { state: "wait", reason: "capacity_unavailable" };
      else if (s.staging >= this.config.staging)
        decision = { state: "stop", reason: "staging_budget" };
      else if (
        free <= 1 ||
        backlog >= 1 ||
        (this.held && (free < 2.5 || backlog > 0.8))
      )
        decision = {
          state: "wait",
          reason: free < 2.5 ? "disk_reserve" : "backlog_bytes",
        };
      else if (
        free < 2 ||
        backlog >= 0.85 ||
        s.staging >= this.config.staging * 0.85
      )
        decision = {
          state: "slow",
          reason: free < 2 ? "disk_headroom" : "byte_budget",
        };
      else if (
        free < 3 ||
        backlog >= 0.7 ||
        s.staging >= this.config.staging * 0.7
      )
        decision = { state: "warn", reason: "capacity_margin" };
    }
    this.held = decision.state === "wait";
    const key = decision.state + ":" + decision.reason;
    if (key !== this.last || (s && s.at - this.reportedAt >= 30000)) {
      this.reportedAt = s?.at ?? this.now();
      this.last = key;
      console.log(
        JSON.stringify({
          event: "ingest_pressure",
          ...decision,
          sample: s,
          metrics: this.metrics,
        }),
      );
    }
    return decision;
  }
  async admit(cancelled: () => boolean | Promise<boolean>) {
    while (!(await cancelled())) {
      const d = await this.inspect();
      if (d.state === "stop")
        throw Object.assign(Error(d.reason), { code: "INGEST_CAPACITY" });
      if (d.state !== "wait") {
        if (d.state === "slow") {
          await new Promise((r) => setTimeout(r, 250));
          this.metrics.slowMs += 250;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
      this.metrics.waitMs += 250;
    }
  }
}
export async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const e of await readdir(root, { withFileTypes: true }).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    const path = join(root, e.name);
    if (e.isDirectory()) bytes += await directoryBytes(path);
    else if (e.isFile())
      bytes += await stat(path)
        .then((s) => s.size)
        .catch((e) => {
          if (e.code === "ENOENT") return 0;
          throw e;
        });
  }
  return bytes;
}
export function createIngestPressure(pool: Pool, root: string) {
  const config = pressureConfig();
  const configured = JSON.parse(
    process.env.INGEST_CAPACITY_PATHS ||
      '{"postgres":"/capacity/postgres","wal":"/capacity/postgres","search":"/capacity/search"}',
  );
  if (
    !configured ||
    ["postgres", "wal", "search"].some(
      (k) =>
        typeof configured[k] !== "string" || !configured[k].startsWith("/"),
    )
  )
    throw Error(
      "INGEST_CAPACITY_PATHS requires absolute postgres, wal and search paths",
    );
  const paths: Record<string, string> = {
    ...configured,
    archive: root,
    staging: join(root, "staging"),
    temporary: tmpdir(),
  };
  let sql:
    | Pick<PressureSample, "queues" | "database" | "wal" | "queueLimit">
    | undefined;
  let sqlAt = 0;
  return new IngestPressure(config, async () => {
    const at = Date.now();
    if (config.mode === "conservative") {
      // Visits at most the legacy limit, regardless of the total backlog.
      const { rows } = await pool.query(`SELECT
        EXISTS(SELECT 1 FROM catalog_pending OFFSET 65535 LIMIT 1) OR
        EXISTS(SELECT 1 FROM catalog_snapshot_pending OFFSET 65535 LIMIT 1) OR
        EXISTS(SELECT 1 FROM catalog_text_pending OFFSET 65535 LIMIT 1) AS limited`);
      return {
        at,
        disks: [],
        staging: 0,
        queues: 0,
        database: 0,
        wal: 0,
        queueLimit: rows[0].limited,
      };
    }
    // Relation/index allocation includes dead tuples; no unbounded COUNT scan.
    if (!sql || at - sqlAt >= 5000) {
      const tablespaces = await pool.query(
        "SELECT spcname FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')",
      );
      if (tablespaces.rows.some((r) => !configured["tablespace:" + r.spcname]))
        throw Error("Every PostgreSQL tablespace needs a capacity path");
      const { rows } = await pool.query(`SELECT
        pg_total_relation_size('catalog_pending') + pg_total_relation_size('catalog_snapshot_pending') + pg_total_relation_size('catalog_text_pending') AS queues,
        pg_database_size(current_database()) AS database,
        (SELECT wal_bytes FROM pg_stat_wal) AS wal`);
      sql = {
        queues: Number(rows[0].queues),
        database: Number(rows[0].database),
        wal: Number(rows[0].wal),
        queueLimit: false,
      };
      if (
        Object.values(sql).some(
          (v) => typeof v === "number" && !Number.isFinite(v),
        )
      )
        throw Error("Invalid PostgreSQL capacity");
      sqlAt = at;
    }
    const disks = await Promise.all(
      Object.entries(paths).map(async ([name, path]) => {
        const s = await statfs(path);
        return { name, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
      }),
    );
    return {
      at,
      ...sql,
      disks,
      staging: await directoryBytes(join(root, "staging")),
    };
  });
}
