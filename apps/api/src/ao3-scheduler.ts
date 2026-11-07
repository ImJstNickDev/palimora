import { syncGate } from "./ao3-policy";
import { DB, pool, transaction } from "./db";
export type SyncKind = "discovery" | "backfill" | "work" | "entity" | "media";
export async function enqueueSync(
  db: DB,
  kind: SyncKind,
  target: string,
  priority?: number,
) {
  await db.query(
    `INSERT INTO ao3_jobs(kind,target,priority)
    SELECT $1,$2,coalesce($3,(priorities->>$1)::int) FROM ao3_control
    ON CONFLICT(kind,target) DO UPDATE SET
      due_at=CASE WHEN ao3_jobs.state='running' THEN ao3_jobs.due_at ELSE least(ao3_jobs.due_at,now()) END,
      state=CASE WHEN ao3_jobs.state IN ('running','blocked') THEN ao3_jobs.state ELSE 'pending' END,
      priority=least(ao3_jobs.priority,excluded.priority)
    WHERE ao3_jobs.availability <> 'deleted'`,
    [kind, target, priority ?? null],
  );
}
export function adaptiveHours(
  complete: boolean | null,
  unchangedDays: number,
  watching: boolean,
) {
  if (watching) return 1;
  if (complete) return unchangedDays > 90 ? 720 : 168;
  return unchangedDays > 90 ? 168 : unchangedDays > 30 ? 24 : 6;
}
export async function scheduleSync() {
  await transaction(async (db) => {
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(70210422) AS yes"))
        .rows[0].yes
    )
      return;
    // Incremental seeding never scans the entire corpus on every tick.
    const c = (await db.query("SELECT * FROM ao3_control FOR UPDATE")).rows[0];
    // Watched works must not wait for the historical seed cursor to reach them.
    await db.query(`INSERT INTO ao3_jobs(kind,target,priority,due_at,started_at)
      SELECT 'work',h.external_id,15,w.next_due_at,w.last_started_at FROM ao3_watch w
      JOIN archive_work_heads h ON h.id=w.work_id WHERE w.watch_until>now() AND w.availability<>'deleted' AND h.external_id IS NOT NULL
      ON CONFLICT DO NOTHING`);
    const works = (
      await db.query(
        `SELECT h.id,h.external_id,h.current_snapshot_id,d.metadata->>'complete' AS complete FROM archive_work_heads h LEFT JOIN catalog_documents d ON d.work_id=h.id
      WHERE h.external_id IS NOT NULL AND ($1::uuid IS NULL OR h.id>$1) ORDER BY h.id LIMIT 256`,
        [c.seed_cursor],
      )
    ).rows;
    for (const w of works)
      await db.query(
        `INSERT INTO ao3_jobs(kind,target,priority)
      VALUES('work',$1,$2) ON CONFLICT DO NOTHING`,
        [
          w.external_id,
          w.complete === "true" ? c.priorities.backfill : c.priorities.work,
        ],
      );
    await db.query("UPDATE ao3_control SET seed_cursor=$1,seed_complete=$2", [
      works.at(-1)?.id ?? null,
      works.length === 0,
    ]);
    await db.query(`UPDATE ao3_jobs j SET checkpoint=jsonb_build_object('upload',u.id::text),state='pending',due_at=now()
      FROM (SELECT DISTINCT ON(url) * FROM ao3_uploads WHERE state='queued' ORDER BY url,created_at,id) u WHERE j.kind='media' AND j.target=u.url AND j.state<>'running' AND NOT(j.checkpoint?'upload')`);
    // Capture recent inserts even if UUID is before the scan cursor; scanning wraps.
    await db.query(`UPDATE ao3_jobs j SET due_at=least(j.due_at,w.next_due_at),priority=least(j.priority,15)
      FROM ao3_watch w JOIN archive_work_heads h ON h.id=w.work_id
      WHERE j.kind='work' AND j.target=h.external_id AND w.watch_until>now()
        AND w.availability<>'deleted' AND j.availability<>'deleted' AND j.state<>'running'`);
  });
}
export async function syncAllowed(db: Pick<DB, "query">) {
  return (
    syncGate(
      (
        await db.query(
          "SELECT paused,mode,observed_state,cooldown_until FROM ao3_control",
        )
      ).rows[0],
    ) === null
  );
}
/** PostgreSQL jobs are the replayable outbox; Redis is only the dispatch transport. */
export async function runSyncQueue(
  execute: (id: string) => Promise<void>,
  stopped: () => boolean,
) {
  const { Queue, Worker } = await import("bullmq");
  const connection = {
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  };
  const q = new Queue("palimora-ao3-v1", {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  const worker = new Worker(
    "palimora-ao3-v1",
    async (job) => execute(job.data.id),
    { connection, concurrency: 1 },
  );
  q.on("error", () => {});
  worker.on("error", () => {});
  let nextSchedule = 0;
  try {
    while (!stopped()) {
      try {
        if (Date.now() >= nextSchedule) {
          await scheduleSync();
          nextSchedule = Date.now() + 60000;
        }
        const permitted = await syncAllowed(pool);
        const jobs = (
          await pool.query(
            `SELECT id,generation FROM ao3_jobs WHERE due_at<=now() AND NOT (SELECT paused FROM ao3_control) AND ($1::boolean OR (kind='media' AND checkpoint?'upload'))
          AND state IN ('pending','retry','idle','running') AND availability<>'deleted'
          AND (kind<>'work' OR started_at IS NULL OR started_at<=now()-interval '1 hour')
          ORDER BY priority-least(100,extract(epoch FROM (now()-due_at))/3600),due_at LIMIT 32`,
            [!!permitted],
          )
        ).rows;
        for (const j of jobs) {
          const jobId = j.id + "-" + j.generation;
          const existing = await q.getJob(jobId);
          if (
            existing &&
            ["completed", "failed"].includes(await existing.getState())
          )
            await existing.remove();
          await q.add(
            "sync",
            { id: j.id },
            { jobId, removeOnComplete: true, removeOnFail: 100 },
          );
        }
      } catch {
        console.error(JSON.stringify({ event: "ao3_dispatch_retry" }));
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await worker.close();
    await q.close();
  }
}
