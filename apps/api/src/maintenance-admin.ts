import { DB } from "./db";
import { fail } from "./security";
export async function maintenanceOperation(
  db: DB,
  op: string,
  x: any,
  user: any,
): Promise<any> {
  if (op === "maintenanceSet") {
    await db.query("UPDATE instance SET maintenance_mode=$1", [x.mode]);
    return { ok: true };
  }
  if (op === "auditList")
    return {
      items: (
        await db.query(
          `SELECT a.id::text,a.actor_id,u.username AS actor,a.effective_user_id,e.username AS effective_user,a.session_id,a.ip,a.action,a.target,a.details,a.outcome,a.created_at,a.request_id FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users e ON e.id=a.effective_user_id WHERE ($1::bigint IS NULL OR a.id<$1) AND ($2::uuid IS NULL OR a.actor_id=$2) AND ($3::text IS NULL OR a.target=$3) AND ($4::text IS NULL OR a.action=$4) AND ($5::text IS NULL OR a.outcome=$5) ORDER BY a.id DESC LIMIT 51`,
          [
            x.cursor ?? null,
            x.actor ?? null,
            x.target ?? null,
            x.action ?? null,
            x.outcome ?? null,
          ],
        )
      ).rows,
    }.items.reduce(
      (a: any, r: any, i: number) => {
        if (i < 50) a.items.push(r);
        else a.next = a.items.at(-1).id;
        return a;
      },
      { items: [], next: null },
    );
  if (op === "integrityStatus")
    return {
      jobs: (
        await db.query(
          "SELECT id,kind,state,progress,result,created_at,updated_at,started_at,finished_at FROM archive_jobs WHERE kind IN('scrub','repair') AND (id=$1::uuid OR id IN(SELECT id FROM archive_jobs WHERE kind IN('scrub','repair') ORDER BY created_at DESC,id DESC LIMIT 50)) ORDER BY created_at DESC,id DESC",
          [x.job ?? null],
        )
      ).rows,
      schedule: (
        await db.query(
          "SELECT enabled,every_days,next_at FROM integrity_schedule",
        )
      ).rows[0],
    };
  if (op === "integrityIssues") {
    const rows = (
      await db.query(
        "SELECT *,code = ANY(ARRAY['PACK_MISSING','PACK_CORRUPT','PACK_VERSION','PACK_HEADER','PACK_TRUNCATED','OBJECT_CORRUPT','LOCATOR_MISMATCH','PACK_LOCATOR','REFERENCE_MISSING']) AS repairable FROM integrity_issues WHERE job_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51",
        [x.job, x.cursor ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].id : null,
    };
  }
  if (op === "integritySchedule") {
    await db.query(
      "UPDATE integrity_schedule SET enabled=$1,every_days=$2::integer,next_at=now()+$2::integer*interval '1 day',actor_id=$3",
      [x.enabled, x.every_days, user.id],
    );
    return { ok: true };
  }
  if (op === "integrityControl") {
    const job = (
      await db.query(
        "SELECT * FROM archive_jobs WHERE id=$1 AND kind IN('scrub','repair') FOR UPDATE",
        [x.id],
      )
    ).rows[0];
    if (!job) fail("NOT_FOUND", 404);
    if (job.kind === "repair" && user.role !== "Owner") fail("FORBIDDEN", 403);
    if (x.action === "pause") {
      if (
        !["pending", "running", "paused", "pause_requested"].includes(job.state)
      )
        fail("CONFLICT", 409);
      await db.query(
        "UPDATE archive_jobs SET state=CASE WHEN state='running' THEN 'pause_requested' ELSE 'paused' END,updated_at=now() WHERE id=$1",
        [x.id],
      );
    } else {
      if (!["failed", "paused", "pause_requested"].includes(job.state))
        fail("CONFLICT", 409);
      await db.query(
        "UPDATE archive_jobs SET state='pending',result=NULL,finished_at=NULL,updated_at=now() WHERE id=$1",
        [x.id],
      );
    }
    return { ok: true };
  }
  if (op === "integrityStart" || op === "integrityRepair") {
    const old = (
      await db.query("SELECT kind,checkpoint FROM archive_jobs WHERE id=$1", [
        x.requestId,
      ])
    ).rows[0];
    const kind = op === "integrityStart" ? "scrub" : "repair";
    if (old) {
      if (
        old.kind !== kind ||
        (kind === "repair" &&
          (old.checkpoint.issue !== x.issue ||
            old.checkpoint.backup !== x.backup))
      )
        fail("CONFLICT", 409);
      return { id: x.requestId };
    }
    if (kind === "repair") {
      const issue = (
        await db.query(
          "SELECT * FROM integrity_issues WHERE id=$1 AND state<>'repaired' FOR UPDATE",
          [x.issue],
        )
      ).rows[0];
      if (
        !issue?.object_hash ||
        ![
          "PACK_MISSING",
          "PACK_CORRUPT",
          "PACK_VERSION",
          "PACK_HEADER",
          "PACK_TRUNCATED",
          "OBJECT_CORRUPT",
          "LOCATOR_MISMATCH",
          "PACK_LOCATOR",
          "REFERENCE_MISSING",
        ].includes(issue.code)
      )
        fail("CONFLICT", 409);
      if (
        !(
          await db.query(
            "SELECT 1 FROM backup_runs WHERE id=$1 AND kind IN('full','export') AND state='completed' FOR SHARE",
            [x.backup],
          )
        ).rowCount
      )
        fail("CONFLICT", 409);
    }
    await db.query(
      "INSERT INTO archive_jobs(id,kind,actor_id,checkpoint) VALUES($1,$2,$3,$4)",
      [
        x.requestId,
        kind,
        user.id,
        kind === "repair" ? { issue: x.issue, backup: x.backup } : {},
      ],
    );
    return { id: x.requestId };
  }
  fail("NOT_FOUND", 404);
}
