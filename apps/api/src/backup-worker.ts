import { jobAudit } from "./admin-audit";
import { processingPolicy } from "./maintenance";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "./db";
import {
  backupConfig,
  destination,
  probeDestination,
  safeBackupError,
  restoreConnection,
} from "./backup-config";
import { openBackupTarget } from "./backup-target";
import { createBackup, inspectBackup, restoreBackup } from "./backup-engine";
import { exportCorpus } from "./archive-export";
import { openChain, verify, loadManifest } from "@palimora/archive-format";
export async function backupHousekeeping() {
  const config = await backupConfig();
  await pool.query(
    "UPDATE backup_destinations SET health=$2,checked_at=now() WHERE NOT(name=ANY($1::text[]))",
    [
      config.destinations.map((d) => d.name),
      {
        available: false,
        writable: false,
        error: "BACKUP_DESTINATION_UNKNOWN",
      },
    ],
  );
  for (const d of config.destinations) {
    await pool.query(
      "INSERT INTO backup_destinations(name,label) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [d.name, d.label],
    );
    const health = await probeDestination(d.name);
    await pool.query(
      "UPDATE backup_destinations SET health=$2,checked_at=now() WHERE name=$1",
      [d.name, health],
    );
  }
  await transaction(async (db) => {
    const due = (
      await db.query(
        "SELECT s.* FROM backup_schedules s JOIN backup_destinations d ON d.name=s.destination JOIN users u ON u.id=s.created_by AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.soft_deleted_at IS NULL WHERE s.enabled AND d.enabled AND s.next_at<=now() FOR UPDATE OF s SKIP LOCKED",
      )
    ).rows;
    for (const s of due) {
      await db.query(
        "INSERT INTO backup_runs(id,kind,destination,schedule_id,actor_id) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), s.kind, s.destination, s.id, s.created_by],
      );
      await db.query(
        "UPDATE backup_schedules SET next_at=now()+every_hours*interval '1 hour' WHERE id=$1",
        [s.id],
      );
    }
  });
  // Retention never removes incremental bases or files used by active operations.
  const schedules = (
    await pool.query("SELECT * FROM backup_schedules WHERE enabled")
  ).rows;
  for (const s of schedules) {
    const old = (
      await pool.query(
        "SELECT id FROM backup_runs WHERE schedule_id=$1 AND state='completed' AND kind IN ('full','platform','export') ORDER BY created_at DESC OFFSET $2",
        [s.id, s.keep],
      )
    ).rows;
    for (const r of old)
      await pool.query(
        `INSERT INTO backup_runs(id,kind,destination,source_id,schedule_id,actor_id) SELECT gen_random_uuid(),'delete',$2,$1,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM backup_runs WHERE (base_id=$1 AND state<>'deleted') OR (source_id=$1 AND (kind='delete' OR state IN ('pending','running','pause_requested','cancel_requested','paused'))))`,
        [r.id, s.destination, s.id, s.created_by],
      );
  }
}
export async function exportChain(id: string) {
  const handles: Awaited<ReturnType<typeof openBackupTarget>>[] = [],
    paths: string[] = [],
    seen = new Set();
  try {
    while (id) {
      if (seen.has(id)) throw Error("BACKUP_CHAIN_CYCLE");
      seen.add(id);
      const r = (
        await pool.query(
          "SELECT * FROM backup_runs WHERE id=$1 AND state='completed' AND kind='export'",
          [id],
        )
      ).rows[0];
      if (!r) throw Error("BACKUP_BASE_UNAVAILABLE");
      const h = await openBackupTarget(await destination(r.destination), {
        readOnly: true,
      });
      handles.unshift(h);
      paths.unshift(join(h.path, r.id, "archive"));
      id = r.base_id;
    }
    return {
      paths,
      check: async () => {
        for (const h of handles) await h.check();
      },
      close: async () => {
        for (const h of handles) await h.close();
      },
    };
  } catch (e) {
    for (const h of handles) await h.close();
    throw e;
  }
}
export async function executeBackup(
  id: string,
  shutdown: () => boolean = () => false,
) {
  const leader = await pool.connect();
  let timer: NodeJS.Timeout | undefined,
    chain: Awaited<ReturnType<typeof exportChain>> | undefined;
  let control = "running",
    polling: Promise<void> | undefined;
  let locked = false;
  try {
    if (
      !(await leader.query("SELECT pg_try_advisory_lock(70210462) AS yes"))
        .rows[0].yes
    )
      return;
    locked = true;
    const r = (await pool.query("SELECT * FROM backup_runs WHERE id=$1", [id]))
      .rows[0];
    if (
      !r ||
      !["pending", "running", "pause_requested", "cancel_requested"].includes(
        r.state,
      )
    )
      return;
    if (["pause_requested", "cancel_requested"].includes(r.state)) {
      await pool.query(
        "UPDATE backup_runs SET state=$2,updated_at=now() WHERE id=$1",
        [id, r.state === "pause_requested" ? "paused" : "cancelled"],
      );
      return;
    }
    const actor = (
      await pool.query(
        "SELECT role,disabled,soft_deleted_at FROM users WHERE id=$1",
        [r.actor_id],
      )
    ).rows[0];
    if (
      !actor ||
      actor.disabled ||
      actor.soft_deleted_at ||
      !["Owner", "Admin"].includes(actor.role) ||
      (r.kind === "restore" && actor.role !== "Owner")
    )
      throw Error("BACKUP_AUTHORITY_REVOKED");
    await pool.query(
      "UPDATE backup_runs SET state='running',error=NULL,updated_at=now() WHERE id=$1",
      [id],
    );
    const poll = () =>
      polling ??
      (polling = pool
        .query("SELECT state FROM backup_runs WHERE id=$1", [id])
        .then((v) => {
          control = v.rows[0]?.state ?? "cancel_requested";
        })
        .finally(() => {
          polling = undefined;
        }));
    timer = setInterval(
      () =>
        void poll().catch(() => {
          control = "pause_requested";
        }),
      250,
    );
    const stopped = () => shutdown() || control !== "running";
    const progress = async (p: object) => {
      await pool.query(
        "UPDATE backup_runs SET progress=$2,updated_at=now() WHERE id=$1",
        [id, p],
      );
    };
    await progress({ phase: r.kind === "restore" ? "restore" : "preparing" });
    const target = await destination(r.destination);
    let result: any = {};
    if (r.kind === "full" || r.kind === "platform") {
      const authKey = process.env.AUTH_KEY_FILE
        ? (await readFile(process.env.AUTH_KEY_FILE, "utf8")).trim()
        : process.env.AUTH_KEY!;
      result = await createBackup({
        database: pool,
        storage: process.env.ARCHIVE_ROOT ?? "/storage",
        target,
        id,
        kind: r.kind,
        config: {
          authKey,
          origin: process.env.APP_ORIGIN!,
          settings: Object.fromEntries(
            [
              "ARCHIVE_ZSTD_LEVEL",
              "ARCHIVE_PACK_MIB",
              "ARCHIVE_RESERVE_BYTES",
              "INGEST_GROUP_RECORDS",
              "INGEST_PARSER_WORKERS",
              "INGEST_COMMIT_CONCURRENCY",
              "VAPID_SUBJECT",
            ].flatMap((key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key]!]],
            ),
          ),
        },
        stopped,
        volumeBytes: Number(process.env.BACKUP_VOLUME_BYTES ?? 2147483648),
        progress,
      });
    } else if (r.kind === "export") {
      chain = await exportChain(r.base_id);
      result = await exportCorpus({
        id,
        destination: r.destination,
        basePaths: chain.paths,
        stopped,
        progress,
      });
    } else {
      const source = (
        await pool.query("SELECT * FROM backup_runs WHERE id=$1", [r.source_id])
      ).rows[0];
      if (!source || source.state === "deleted")
        throw Error("BACKUP_SOURCE_UNAVAILABLE");
      if (r.kind === "delete") {
        await transaction(async (db) => {
          await db.query("SELECT * FROM backup_runs WHERE id=$1 FOR UPDATE", [
            source.id,
          ]);
          if (
            (
              await db.query(
                "SELECT 1 FROM backup_runs WHERE (base_id=$1 AND state<>'deleted') OR (source_id=$1 AND id<>$2 AND state IN ('pending','running','paused','pause_requested','cancel_requested'))",
                [source.id, id],
              )
            ).rowCount
          )
            throw Error("BACKUP_DEPENDENCY");
          if (
            (
              await db.query(
                "SELECT 1 FROM archive_jobs WHERE kind='repair' AND state IN('pending','running','paused','pause_requested') AND checkpoint->>'backup'=$1",
                [source.id],
              )
            ).rowCount
          )
            throw Error("BACKUP_DEPENDENCY");
          const h = await openBackupTarget(target, { readOnly: true });
          try {
            await rm(join(h.path, source.id), { recursive: true, force: true });
          } finally {
            await h.close();
          }
          await db.query(
            "UPDATE backup_runs SET state='deleted',updated_at=now() WHERE id=$1",
            [source.id],
          );
        });
      } else if (r.kind === "verify") {
        if (source.kind === "export") {
          chain = await exportChain(source.id);
          const c = await openChain(chain.paths);
          await verify(c);
          result = { hash: c.hash };
        } else result = await inspectBackup(target, source.id);
        await pool.query(
          "UPDATE backup_runs SET verified_at=now(),error=NULL WHERE id=$1",
          [source.id],
        );
      } else if (r.kind === "restore") {
        const targetConnection = await restoreConnection(r.restore_target);
        try {
          const report = await restoreBackup({
            database: targetConnection.database,
            target,
            id: source.id,
            storage: targetConnection.config.storage,
            storageTarget: targetConnection.config.storageTarget,
            confirmation: r.confirmation,
            stopped,
          });
          result = {
            restored: report.restored,
            unresolved: report.unresolved.length,
            issues: report.unresolved
              .map((v: any) => ({ table: v.table, reason: v.reason }))
              .slice(0, 100),
          };
        } finally {
          await targetConnection.database.end();
        }
      }
    }
    if (["full", "platform", "export"].includes(r.kind)) {
      const h = await openBackupTarget(target, { readOnly: true });
      try {
        const a = await loadManifest(join(h.path, id, "archive"));
        result = {
          hash: a.hash,
          files: [
            {
              name: "manifest.json",
              size: (await stat(join(h.path, id, "archive", "manifest.json")))
                .size,
            },
            { name: "manifest.sha256", size: 65 },
            ...a.manifest.volumes.map((v) => ({
              name: v.name,
              size: v.size,
              sha256: v.sha256,
            })),
          ],
          bytes: a.manifest.volumes.reduce((n, v) => n + v.size, 0),
        };
      } finally {
        await h.close();
      }
    }
    await pool.query(
      "UPDATE backup_runs SET state='completed',progress=$2,result=$3,verified_at=CASE WHEN kind IN ('full','platform','export','verify') THEN now() ELSE verified_at END,updated_at=now() WHERE id=$1",
      [id, { phase: "completed" }, result],
    );
    await jobAudit(pool, r, "backup.completed", {
      kind: r.kind,
      before: { state: "running" },
      after: { state: "completed" },
    });
  } catch (e) {
    await polling;
    await pool.query(
      "UPDATE backup_runs SET verified_at=NULL,error=$2 WHERE id=(SELECT source_id FROM backup_runs WHERE id=$1 AND kind='verify')",
      [id, safeBackupError(e)],
    );
    await pool.query(
      "UPDATE backup_runs SET state=$2,error=$3,updated_at=now() WHERE id=$1",
      [
        id,
        shutdown()
          ? "pending"
          : control === "pause_requested"
            ? "paused"
            : control === "cancel_requested"
              ? "cancelled"
              : "failed",
        shutdown() || control !== "running" ? null : safeBackupError(e),
      ],
    );
    const stopped = (
      await pool.query(
        "SELECT id,kind,actor_id,state,error FROM backup_runs WHERE id=$1",
        [id],
      )
    ).rows[0];
    await jobAudit(
      pool,
      stopped,
      "backup.stopped",
      {
        kind: stopped.kind,
        before: { state: "running" },
        after: { state: stopped.state, error: stopped.error },
      },
      stopped.state === "failed" ? "failure" : "success",
    );
  } finally {
    if (timer) clearInterval(timer);
    await polling;
    await chain?.close();
    if (locked) await leader.query("SELECT pg_advisory_unlock(70210462)");
    leader.release();
  }
}
export async function runBackups(stopped: () => boolean) {
  const { Queue, Worker } = await import("bullmq");
  const connection = {
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  };
  const queue = new Queue("palimora-backup-v1", {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  const worker = new Worker(
    "palimora-backup-v1",
    (job) => executeBackup(job.data.id, stopped),
    { connection, concurrency: 1 },
  );
  queue.on("error", () => {});
  worker.on("error", () => {});
  let checked = 0;
  try {
    while (!stopped()) {
      try {
        if (Date.now() - checked > 15000) {
          await backupHousekeeping();
          checked = Date.now();
        }
        for (const r of (
          await pool.query(
            "SELECT id,generation FROM backup_runs WHERE state IN ('pending','running','pause_requested','cancel_requested') ORDER BY created_at LIMIT 20",
          )
        ).rows) {
          const jobId = r.id + "-" + r.generation,
            old = await queue.getJob(jobId);
          if (old && ["completed", "failed"].includes(await old.getState()))
            await old.remove();
          await queue.add(
            "backup",
            { id: r.id },
            { jobId, removeOnComplete: true, removeOnFail: 20 },
          );
        }
      } catch {
        console.error(JSON.stringify({ event: "backup_dispatch_retry" }));
      }
      await new Promise((resolve) => {
        void processingPolicy().then(
          (p) => setTimeout(resolve, p.dispatchMs),
          () => setTimeout(resolve, 1000),
        );
      });
    }
  } finally {
    await worker.close();
    await queue.close();
  }
}
