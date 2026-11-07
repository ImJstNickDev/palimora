import { syncGate } from "./ao3-policy";
import { pool, DB } from "./db";
import {
  classifyAO3,
  nextProbeDelay,
  retryAfter,
  Availability,
} from "./ao3-availability";

/** One session lock covers the entire request, including database publication.
 * Process death releases it; persisted deadlines remain authoritative. */
export async function monitorAO3(stopped: () => boolean = () => false) {
  if (stopped()) return;
  const db = await pool.connect();
  let locked = false,
    networkLocked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(70210420) AS locked"))
      .rows[0].locked;
    if (!locked || stopped()) return;
    networkLocked = (
      await db.query("SELECT pg_try_advisory_lock(70210421) AS yes")
    ).rows[0].yes;
    if (!networkLocked) return;
    const c = (
      await db.query(`SELECT * FROM ao3_control WHERE mode <> 'force_offline' AND NOT paused
      AND next_request_at<=now() AND next_probe_at<=now() AND (cooldown_until IS NULL OR cooldown_until<=now())`)
    ).rows[0];
    if (!c) return;
    // Reserve a crash recovery interval before network I/O. No crash can cause a probe storm.
    await db.query(
      "UPDATE ao3_control SET next_probe_at=now()+interval '5 minutes',next_request_at=now()+spacing_ms*interval '1 millisecond'",
    );
    const started = new Date();
    let state: Availability = "unreachable",
      status: number | null = null,
      retry: number | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(
          "https://archiveofourown.org/works/search",
          {
            signal: controller.signal,
            redirect: "manual",
            headers: {
              "User-Agent": "Palimora/1.0 (archive availability monitor)",
              Accept: "text/html",
              "Accept-Language": "en",
            },
          },
        );
        status = response.status;
        retry = retryAfter(response.headers.get("retry-after"));
        // Health probes are bounded; an oversized response is never evidence of health.
        const reader = response.body?.getReader();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.length;
              if (bytes > 1_048_576) {
                await reader.cancel();
                throw Error("HEALTH_RESPONSE_TOO_LARGE");
              }
              chunks.push(part.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        state = classifyAO3(status, Buffer.concat(chunks).toString("utf8"));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      state =
        status === 429
          ? "rate_limited"
          : status === 503
            ? "maintenance"
            : "unreachable";
    }
    const failures = state === "online" ? 0 : Math.min(100, c.failures + 1);
    const delay = nextProbeDelay(state, failures, retry);
    // Keep dates representable even if a server returns an absurd Retry-After.
    const next = new Date(Math.min(8_640_000_000_000_000, Date.now() + delay));
    const cooldown =
      status === 429 || status === 503 || retry !== null ? next : null;
    await db.query("BEGIN");
    try {
      await db.query(
        `UPDATE ao3_control SET observed_state=$1,checked_at=now(),failures=$2,
        next_probe_at=$3,cooldown_until=CASE WHEN $4::timestamptz IS NULL THEN cooldown_until
          ELSE greatest(cooldown_until,$4) END`,
        [state, failures, next, cooldown],
      );
      await db.query(
        `INSERT INTO ao3_health_history(started_at,state,http_status,retry_at,duration_ms)
        VALUES($1,$2,$3,$4,$5)`,
        [started, state, status, cooldown, Date.now() - started.getTime()],
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (networkLocked) await db.query("SELECT pg_advisory_unlock(70210421)");
    if (locked) await db.query("SELECT pg_advisory_unlock(70210420)");
    db.release();
  }
}
export async function recordAO3Open(db: DB, workId: string) {
  await db.query(
    `INSERT INTO ao3_watch(work_id,last_open_at,watch_until,next_due_at)
    SELECT id,now(),now()+interval '48 hours',now()+interval '1 hour'
    FROM archive_work_heads h WHERE id=$1 AND external_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM ao3_jobs j WHERE j.kind='work' AND j.target=h.external_id AND j.availability='deleted')
    ON CONFLICT(work_id) DO UPDATE SET last_open_at=now(),
      watch_until=greatest(ao3_watch.watch_until,now()+interval '48 hours')
    WHERE ao3_watch.availability <> 'deleted'`,
    [workId],
  );
}
export async function ao3MonitorOperation(db: DB, op: string, input: any) {
  if (op === "ao3Control") {
    await db.query(
      `UPDATE ao3_control SET mode=$1,paused=$2,updated_at=now()`,
      [input.mode, input.paused],
    );
    return { ok: true };
  }
  const control = (
    await db.query(`SELECT mode,paused,observed_state,checked_at,next_probe_at,cooldown_until,failures,
    CASE WHEN paused OR mode='force_offline' THEN NULL ELSE greatest(next_probe_at,next_request_at,cooldown_until) END AS probe_eligible_at,
    NOT paused AND mode <> 'force_offline' AND (mode='force_online' OR observed_state='online')
      AND (cooldown_until IS NULL OR cooldown_until<=now()) AS eligible FROM ao3_control`)
  ).rows[0];
  control.eligible = syncGate(control) === null;
  control.gate = syncGate(control);
  const history = (
    await db.query("SELECT * FROM ao3_health_history ORDER BY id DESC LIMIT 50")
  ).rows;
  return {
    control,
    history,
    watching: Number(
      (
        await db.query(
          "SELECT count(*) FROM ao3_watch WHERE watch_until>now() AND availability <> 'deleted'",
        )
      ).rows[0].count,
    ),
  };
}
