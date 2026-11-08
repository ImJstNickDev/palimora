import { DB } from "./db";
import { fail } from "./security";
import {
  backupConfig,
  destination,
  restoreReadiness,
  safeBackupError,
} from "./backup-config";
export const runColumns =
  "id,kind,destination,state,source_id,base_id,restore_target,created_at,updated_at,verified_at,progress,result,error";
export async function backupOperation(
  db: DB,
  op: string,
  x: any,
  user: any,
): Promise<any> {
  const one = async () => {
    const r = (
      await db.query("SELECT * FROM backup_runs WHERE id=$1 FOR UPDATE", [x.id])
    ).rows[0];
    if (!r) fail("NOT_FOUND", 404);
    return r;
  };
  if (op === "backupStatus") {
    const rows = (
      await db.query(
        `SELECT ${runColumns.replace("progress,result,error", "progress,result-'files'-'issues' AS result,error")} FROM backup_runs WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM backup_runs WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51`,
        [x.cursor ?? null],
      )
    ).rows;
    return {
      runs: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].id : null,
      destinations: (
        await db.query("SELECT * FROM backup_destinations ORDER BY label,name")
      ).rows,
      schedules: (
        await db.query("SELECT * FROM backup_schedules ORDER BY next_at,id")
      ).rows,
    };
  }
  if (op === "backupDetail") {
    const r = await one();
    delete r.confirmation;
    return r;
  }
  if (op === "backupDestination") {
    await destination(x.name);
    await db.query(
      "UPDATE backup_destinations SET label=$2,enabled=$3 WHERE name=$1",
      [x.name, x.label, x.enabled],
    );
    return { ok: true };
  }
  if (op === "backupSchedule") {
    await destination(x.destination);
    await db.query(
      `INSERT INTO backup_schedules(id,kind,destination,enabled,every_hours,keep,next_at,created_by) VALUES($1,$2,$3,$4,$5,$6,now()+$5::integer*interval '1 hour',$7) ON CONFLICT(id) DO UPDATE SET kind=$2,destination=$3,enabled=$4,every_hours=$5,keep=$6,next_at=now()+$5::integer*interval '1 hour',created_by=$7`,
      [x.id, x.kind, x.destination, x.enabled, x.every_hours, x.keep, user.id],
    );
    return { ok: true };
  }
  if (op === "backupCreate") {
    const d = (
      await db.query(
        "SELECT * FROM backup_destinations WHERE name=$1 AND enabled",
        [x.destination],
      )
    ).rows[0];
    if (!d) fail("INVALID_INPUT", 400);
    await destination(x.destination);
    if (
      x.base &&
      (x.kind !== "export" ||
        !(
          await db.query(
            "SELECT 1 FROM backup_runs WHERE id=$1 AND kind='export' AND state='completed' FOR UPDATE",
            [x.base],
          )
        ).rowCount)
    )
      fail("CONFLICT", 409);
    const old = (
      await db.query(
        "SELECT kind,destination,base_id FROM backup_runs WHERE id=$1",
        [x.requestId],
      )
    ).rows[0];
    if (
      old &&
      (old.kind !== x.kind ||
        old.destination !== x.destination ||
        old.base_id !== (x.base ?? null))
    )
      fail("CONFLICT", 409);
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,base_id,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [x.requestId, x.kind, x.destination, x.base ?? null, user.id],
    );
    return { ok: true };
  }
  const r = await one();
  const repeated = async (kind: string, target: string | null = null) => {
    const previous = (
      await db.query(
        "SELECT kind,source_id,restore_target FROM backup_runs WHERE id=$1",
        [x.requestId],
      )
    ).rows[0];
    if (!previous) return false;
    if (
      previous.kind !== kind ||
      previous.source_id !== r.id ||
      previous.restore_target !== target
    )
      fail("CONFLICT", 409);
    return true;
  };
  if (op === "backupFile") {
    if (
      r.state !== "completed" ||
      !["full", "platform", "export"].includes(r.kind)
    )
      fail("NOT_FOUND", 404);
    if (r.kind !== "export" && user.role !== "Owner") fail("FORBIDDEN", 403);
    return { id: r.id, file: x.file };
  }
  if (op === "backupRestorePreview") {
    if (
      !["full", "platform"].includes(r.kind) ||
      r.state !== "completed" ||
      !r.verified_at ||
      !r.result.hash
    )
      fail("CONFLICT", 409);
    const targets = [];
    for (const t of (await backupConfig()).restores) {
      try {
        targets.push(await restoreReadiness(t.name, r.kind));
      } catch (e) {
        targets.push({
          name: t.name,
          label: t.label,
          ready: false,
          error: safeBackupError(e),
        });
      }
    }
    return { hash: r.result.hash, kind: r.kind, targets };
  }
  if (op === "backupRestore") {
    if (await repeated("restore", x.target)) return { ok: true };
    if (
      !["full", "platform"].includes(r.kind) ||
      r.state !== "completed" ||
      !r.verified_at ||
      x.confirmation !== "RESTORE " + r.result.hash
    )
      fail("CONFLICT", 409);
    if (!(await restoreReadiness(x.target, r.kind)).ready)
      fail("CONFLICT", 409);
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,source_id,restore_target,confirmation,actor_id) VALUES($1,'restore',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [x.requestId, r.destination, r.id, x.target, x.confirmation, user.id],
    );
    return { ok: true };
  }
  if (op === "backupControl") {
    if (r.kind === "restore" && user.role !== "Owner") fail("FORBIDDEN", 403);
    if (["verify", "delete"].includes(x.action) && (await repeated(x.action)))
      return { ok: true };
    if (
      x.action === "pause" &&
      ["pending", "running"].includes(r.state) &&
      ["full", "platform", "export"].includes(r.kind)
    )
      await db.query(
        "UPDATE backup_runs SET state=CASE WHEN state='pending' THEN 'paused' ELSE 'pause_requested' END,updated_at=now() WHERE id=$1",
        [r.id],
      );
    else if (
      x.action === "resume" &&
      ["paused", "failed", "cancelled"].includes(r.state)
    )
      await db.query(
        "UPDATE backup_runs SET state='pending',error=NULL,generation=generation+1,actor_id=$2,updated_at=now() WHERE id=$1",
        [r.id, user.id],
      );
    else if (
      x.action === "cancel" &&
      ["pending", "running", "pause_requested", "paused", "failed"].includes(
        r.state,
      ) &&
      ["full", "platform", "export", "restore"].includes(r.kind)
    )
      await db.query(
        "UPDATE backup_runs SET state=CASE WHEN state IN ('running','pause_requested') THEN 'cancel_requested' ELSE 'cancelled' END,updated_at=now() WHERE id=$1",
        [r.id],
      );
    else if (
      ["verify", "delete"].includes(x.action) &&
      ["full", "platform", "export"].includes(r.kind) &&
      ["completed", "failed", "cancelled", "paused"].includes(r.state)
    ) {
      if(x.action==='delete'&&(await db.query("SELECT 1 FROM archive_jobs WHERE kind='repair' AND state IN('pending','running','paused','pause_requested') AND checkpoint->>'backup'=$1",[r.id])).rowCount)fail('CONFLICT',409);
      if (x.action === "delete" && x.confirmation !== "DELETE " + r.id)
        fail("INVALID_INPUT", 400);
      if (
        x.action === "delete" &&
        (
          await db.query(
            "SELECT 1 FROM backup_runs WHERE (base_id=$1 AND state<>'deleted') OR (source_id=$1 AND state IN ('pending','running','paused','pause_requested','cancel_requested'))",
            [r.id],
          )
        ).rowCount
      )
        fail("CONFLICT", 409);
      await db.query(
        "INSERT INTO backup_runs(id,kind,destination,source_id,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [x.requestId, x.action, r.destination, r.id, user.id],
      );
    } else fail("CONFLICT", 409);
    return { ok: true };
  }
  fail("NOT_FOUND", 404);
}
