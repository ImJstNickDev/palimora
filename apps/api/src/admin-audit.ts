import { DB } from "./db";
/** Positive field lists: secret-looking key filtering is not a security boundary. */
export async function auditState(db: DB, op: string, x: any, userId?: string) {
  if (["maintenanceSet"].includes(op))
    return (await db.query("SELECT maintenance_mode FROM instance")).rows[0];
  if (["integritySchedule"].includes(op))
    return (
      await db.query(
        "SELECT enabled,every_days,next_at FROM integrity_schedule",
      )
    ).rows[0];
  if (["integrityControl"].includes(op))
    return (
      (
        await db.query("SELECT id,kind,state FROM archive_jobs WHERE id=$1", [
          x.id,
        ])
      ).rows[0] ?? null
    );
  if (["userUpdate", "userReset", "userDelete", "userRestore"].includes(op))
    return (
      (
        await db.query(
          "SELECT id,role,disabled,soft_deleted_at FROM users WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (op === "operationsLayout")
    return (
      (
        await db.query(
          "SELECT sections FROM operations_layout WHERE user_id=$1",
          [userId],
        )
      ).rows[0] ?? null
    );
  if (op === "operationsControl")
    return (
      (
        await db.query(
          "SELECT family,id,state,priority FROM operations_jobs WHERE family=$1 AND id=$2",
          [x.family, x.id],
        )
      ).rows[0] ?? null
    );
  if (op === "ingestControl")
    return (
      (
        await db.query(
          "SELECT id,state,generation FROM ingest_batches WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (op === "ao3JobControl")
    return (
      (
        await db.query(
          "SELECT id,state,priority,generation FROM ao3_jobs WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (["ao3Control", "ao3Priorities"].includes(op))
    return (await db.query("SELECT mode,paused,priorities FROM ao3_control"))
      .rows[0];
  if (op === "backupControl")
    return (
      (
        await db.query(
          "SELECT id,kind,state,generation FROM backup_runs WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (op === "backupDestination")
    return (
      (
        await db.query(
          "SELECT name,label,enabled FROM backup_destinations WHERE name=$1",
          [x.name],
        )
      ).rows[0] ?? null
    );
  if (op === "backupSchedule")
    return (
      (
        await db.query(
          "SELECT id,kind,destination,enabled,every_hours,keep,next_at FROM backup_schedules WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (["integrityStart", "integrityRepair"].includes(op))
    return (
      (
        await db.query("SELECT id,kind,state FROM archive_jobs WHERE id=$1", [
          x.requestId,
        ])
      ).rows[0] ?? null
    );
  if (["backupCreate", "backupRestore"].includes(op))
    return (
      (
        await db.query(
          "SELECT id,kind,state,destination,source_id,base_id,restore_target FROM backup_runs WHERE id=$1",
          [x.requestId],
        )
      ).rows[0] ?? null
    );
  if (["archiveResolve"].includes(op))
    return (
      (
        await db.query(
          "SELECT id,current_snapshot_id,head_reason FROM archive_works WHERE id=$1",
          [x.id],
        )
      ).rows[0] ?? null
    );
  if (op === "libraryLater")
    return (
      (
        await db.query(
          "SELECT later FROM library_readings WHERE user_id=$1 AND work_id=$2",
          [userId, x.id],
        )
      ).rows[0] ?? { later: false }
    );
  if (op === "collectionMember")
    return (
      (
        await db.query(
          "SELECT m.user_id,m.role,m.accepted FROM library_members m JOIN users u ON u.id=m.user_id WHERE m.collection_id=$1 AND lower(u.username)=lower($2)",
          [x.id, x.username],
        )
      ).rows[0] ?? null
    );
  if (op === "collectionRespond")
    return (
      (
        await db.query(
          "SELECT role,accepted FROM library_members WHERE collection_id=$1 AND user_id=$2",
          [x.id, userId],
        )
      ).rows[0] ?? null
    );
  return undefined;
}

export async function jobAudit(
  db: Pick<DB, "query">,
  job: any,
  action: string,
  details: object,
  outcome = "success",
  target = job.id,
) {
  await db.query(
    `INSERT INTO audit(actor_id,effective_user_id,session_id,ip,action,target,details,outcome,request_id)
    SELECT $1,$1,a.session_id,coalesce(a.ip,''),$3,$4,$5,$6,$2::uuid FROM (SELECT 1) v LEFT JOIN LATERAL
    (SELECT session_id,ip FROM audit WHERE target=$2::text AND actor_id=$1 AND outcome='success' ORDER BY id LIMIT 1) a ON true`,
    [
      job.actor_id,
      job.id,
      action,
      target,
      { job: job.id, ...details },
      outcome,
    ],
  );
}
