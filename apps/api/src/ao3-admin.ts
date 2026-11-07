import { jobExecution } from "./ao3-policy";
import { DB } from "./db";
import { seal, fail } from "./security";
import { enqueueSync } from "./ao3-scheduler";
export async function syncAdmin(db: DB, op: string, x: any) {
  if (op === "ao3Media") {
    const rows = (
      await db.query(
        `SELECT j.id,j.target AS url,j.error,j.started_at AS failed_at,j.attempts,
      m.object_hash IS NOT NULL AS has_local_copy,
      (SELECT count(*)::int FROM archive_media_references r WHERE r.url=j.target) AS work_count,
      coalesce((SELECT jsonb_agg(w) FROM (SELECT h.id,coalesce(d.title,'AO3 · '||h.external_id,h.id::text) AS title FROM archive_media_references r JOIN archive_work_heads h ON h.id=r.work_id LEFT JOIN catalog_documents d ON d.work_id=h.id WHERE r.url=j.target ORDER BY h.id LIMIT 5) w),'[]'::jsonb) AS works,
      (SELECT state FROM ao3_uploads u WHERE u.url=j.target AND state IN ('receiving','queued') ORDER BY created_at DESC LIMIT 1) AS upload_state
      FROM ao3_jobs j LEFT JOIN ao3_media m ON m.url=j.target
      WHERE j.kind='media' AND j.error='MEDIA_UNRECOVERABLE'
      AND ($1::uuid IS NULL OR j.id>$1) AND ($2::text='' OR strpos(lower(j.target),lower($2))>0)
      ORDER BY j.id LIMIT 21`,
        [x.cursor ?? null, x.q ?? ""],
      )
    ).rows;
    return {
      items: rows.slice(0, 20),
      next: rows.length > 20 ? rows[19].id : null,
    };
  }
  if (op === "ao3UploadStart") {
    await db.query(
      "INSERT INTO ao3_uploads(id,url,size,mime) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [x.id, x.url, x.size, x.mime],
    );
    const row = (
      await db.query(
        "SELECT url,size,mime,received FROM ao3_uploads WHERE id=$1",
        [x.id],
      )
    ).rows[0];
    if (row.url !== x.url || Number(row.size) !== x.size || row.mime !== x.mime)
      fail("INVALID_INPUT");
    return { received: Number(row.received) };
  }
  if (op === "ao3UploadChunk") {
    const upload = (
      await db.query("SELECT * FROM ao3_uploads WHERE id=$1 FOR UPDATE", [x.id])
    ).rows[0];
    if (!upload || upload.state !== "receiving") fail("INVALID_INPUT");
    const bytes = Buffer.from(x.data, "base64");
    if (
      !bytes.length ||
      bytes.toString("base64") !== x.data ||
      x.offset + bytes.length > Number(upload.size)
    )
      fail("INVALID_INPUT");
    const prior = (
      await db.query(
        "SELECT data FROM ao3_upload_chunks WHERE upload_id=$1 AND byte_offset=$2",
        [x.id, x.offset],
      )
    ).rows[0];
    if (prior) {
      if (!prior.data.equals(bytes)) fail("INVALID_INPUT");
    } else {
      if (Number(upload.received) !== x.offset) fail("INVALID_INPUT");
      await db.query("INSERT INTO ao3_upload_chunks VALUES($1,$2,$3)", [
        x.id,
        x.offset,
        bytes,
      ]);
      await db.query(
        "UPDATE ao3_uploads SET received=received+$2 WHERE id=$1",
        [x.id, bytes.length],
      );
    }
    return { ok: true };
  }
  if (op === "ao3UploadFinish") {
    const upload = (
      await db.query("SELECT * FROM ao3_uploads WHERE id=$1 FOR UPDATE", [x.id])
    ).rows[0];
    if (!upload || upload.received !== upload.size) fail("INVALID_INPUT");
    if (upload.state !== "receiving") return { ok: true };
    await db.query(
      "UPDATE ao3_uploads SET state='queued',created_at=now() WHERE id=$1",
      [x.id],
    );
    await enqueueSync(db, "media", upload.url, 15);
    await db.query(
      "UPDATE ao3_jobs SET checkpoint=jsonb_build_object('upload',$2::text),state='pending',due_at=now() WHERE kind='media' AND target=$1 AND state<>'running' AND NOT(checkpoint?'upload')",
      [upload.url, x.id],
    );
    return { ok: true };
  }
  if (op === "ao3Account") {
    await db.query(
      "UPDATE ao3_control SET credentials=$1,cookies=NULL,auth_state=$2",
      [
        x.remove
          ? null
          : seal(
              JSON.stringify({ username: x.username, password: x.password }),
            ),
        x.remove ? "anonymous" : "pending",
      ],
    );
    return { ok: true };
  }
  if (op === "ao3Priorities") {
    await db.query("UPDATE ao3_control SET priorities=$1", [x.priorities]);
    await db.query("UPDATE ao3_jobs SET priority=($1::jsonb->>kind)::int", [
      x.priorities,
    ]);
    return { ok: true };
  }
  if (op === "ao3Manual") {
    if (x.kind === "work" && !/^\d+$/.test(x.target)) fail("INVALID_INPUT");
    if (
      x.kind === "entity" &&
      !/^\/(?:tags\/[^/?#]+|series\/\d+|users\/[^/?#]+)$/.test(x.target)
    )
      fail("INVALID_INPUT");
    if (x.kind === "media") {
      let u: URL;
      try {
        u = new URL(x.target);
      } catch {
        fail("INVALID_INPUT");
      }
      if (!["https:", "http:"].includes(u!.protocol)) fail("INVALID_INPUT");
    }
    const target =
      x.kind === "discovery"
        ? "recent"
        : x.kind === "backfill"
          ? "history"
          : x.target;
    // A manual retry is explicit authority to recheck a previously confirmed deletion.
    await db.query(
      "UPDATE ao3_jobs SET availability='unknown',error=NULL,checkpoint=CASE WHEN kind='work' AND state<>'running' THEN '{}'::jsonb ELSE checkpoint END,state=CASE WHEN state='running' THEN 'running' ELSE 'pending' END WHERE kind=$1 AND target=$2",
      [x.kind, target],
    );
    await enqueueSync(db, x.kind, target, x.priority);
    return { ok: true };
  }
  if (op === "ao3JobControl") {
    if (
      !(await db.query("SELECT 1 FROM ao3_jobs WHERE id=$1", [x.id])).rowCount
    )
      fail("NOT_FOUND", 404);
    if (x.action === "pause")
      await db.query(
        "UPDATE ao3_jobs SET state='blocked' WHERE id=$1 AND state<>'running'",
        [x.id],
      );
    else
      await db.query(
        "UPDATE ao3_jobs SET state='pending',due_at=now(),error=NULL,availability='unknown' WHERE id=$1 AND state<>'running'",
        [x.id],
      );
    return { ok: true };
  }
  const control = (
    await db.query(
      "SELECT auth_state,priorities,spacing_ms,seed_complete,paused,mode,observed_state,cooldown_until FROM ao3_control",
    )
  ).rows[0];
  const rows = (
    await db.query(
      `SELECT j.id,j.kind,j.target,j.state,j.priority,j.due_at,j.started_at,j.checked_at,j.attempts,j.error,j.availability,(j.checkpoint-'record'-'seen'-'entity') AS checkpoint,d.title,h.id AS work_id
    FROM ao3_jobs j LEFT JOIN archive_work_heads h ON j.kind='work' AND h.external_id=j.target LEFT JOIN catalog_documents d ON d.work_id=h.id
    WHERE ($1::uuid IS NULL OR j.id>$1) AND ($2::text='all' OR j.state=$2)
    AND ($3::text='all' OR j.kind=$3) AND ($4::text='' OR strpos(lower(j.target),lower($4))>0 OR strpos(lower(d.title),lower($4))>0) ORDER BY j.id LIMIT 51`,
      [x.cursor ?? null, x.state ?? "all", x.kind ?? "all", x.q ?? ""],
    )
  ).rows;
  const jobs = rows
      .slice(0, 50)
      .map((j) => ({ ...j, ...jobExecution(j, control) })),
    counts = (
      await db.query(
        "SELECT state,count(*)::int AS count FROM ao3_jobs GROUP BY state",
      )
    ).rows;
  const runs = (
    await db.query(
      `SELECT r.id,r.job_id,j.kind,j.target,r.started_at,r.finished_at,r.outcome,r.detail FROM ao3_runs r JOIN ao3_jobs j ON j.id=r.job_id
    WHERE ($1::uuid IS NULL OR r.job_id=$1) ORDER BY r.id DESC LIMIT 50`,
      [x.job ?? null],
    )
  ).rows;
  return {
    control,
    jobs,
    counts,
    runs,
    media_unrecoverable: Number(
      (
        await db.query(
          "SELECT count(*) FROM ao3_jobs WHERE kind='media' AND error='MEDIA_UNRECOVERABLE'",
        )
      ).rows[0].count,
    ),
    next: rows.length > 50 ? jobs.at(-1).id : null,
  };
}
