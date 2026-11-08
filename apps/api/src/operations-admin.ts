import { DB } from "./db";
import { fail } from "./security";
import { archiveOperation } from "./archive-admin";
import { syncAdmin } from "./ao3-admin";
import { backupOperation } from "./backup-admin";
import { latencyBounds } from "./operations-metrics";
import { jobExecution } from "./ao3-policy";
const sections = ["activity", "containers", "performance", "storage"];
function actions(r: any, owner: boolean) {
  if (r.family === "admin" && ["scrub", "repair"].includes(r.kind))
    return r.kind === "repair" && !owner
      ? []
      : ["pending", "running"].includes(r.state)
        ? ["pause"]
        : ["paused", "pause_requested", "failed"].includes(r.state)
          ? ["resume"]
          : [];
  if (r.family === "ingest")
    return ["pending", "running", "scanning"].includes(r.state)
      ? ["pause"]
      : ["paused", "parser_blocked", "failed_global"].includes(r.state)
        ? ["resume"]
        : [];
  if (["sync", "media"].includes(r.family))
    return r.state === "running"
      ? []
      : r.state === "blocked"
        ? ["resume"]
        : r.state === "retry"
          ? ["pause", "retry"]
          : ["pause", "retry"];
  if (r.family === "index")
    return r.state === "paused" || r.state === "pause_requested"
      ? ["resume"]
      : r.state === "failed"
        ? ["pause", "retry"]
        : ["pause"];
  if (r.family === "backup") {
    if (r.kind === "restore" && !owner) return [];
    return ["paused", "failed", "cancelled"].includes(r.state)
      ? ["resume"]
      : ["pending", "running"].includes(r.state) &&
          ["full", "platform", "export"].includes(r.kind)
        ? ["pause"]
        : [];
  }
  return [];
}
function link(r: any) {
  return r.family === "ingest"
    ? "/admin/ingest/" + r.id
    : r.family === "backup"
      ? "/admin/backups?id=" + r.id
      : ["sync", "media"].includes(r.family)
        ? "/admin/ao3?section=activity&job=" + r.id
        : r.family === "admin"
          ? ["scrub", "repair"].includes(r.kind)
            ? "/admin/integrity?job=" + r.id
            : "/admin/archive/storage"
          : "/admin/operations/jobs?family=index&id=" + r.id;
}
function httpStats(row: any) {
  const n = Number(row.requests);
  let count = 0,
    p95: number | null = null;
  for (let i = 0; i < latencyBounds.length; i++) {
    count += Number(row.histogram[i]);
    if (count >= n * 0.95) {
      p95 = Number.isFinite(latencyBounds[i]) ? latencyBounds[i] : null;
      break;
    }
  }
  return {
    ...row,
    requests: n,
    errors: Number(row.errors),
    mean_ms: n ? Number(row.total_ms) / n : null,
    p95_ms: n ? p95 : null,
    p95_overflow: n > 0 && p95 === null,
    max_ms: Number(row.max_ms),
  };
}
export async function operationsOperation(
  db: DB,
  op: string,
  x: any,
  user: any,
): Promise<any> {
  if (
    ["operationsControl", "operationsHistory"].includes(op) &&
    !(x.family === "index"
      ? ["catalog", "search"].includes(x.id)
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          x.id,
        ))
  )
    fail("INVALID_INPUT", 400);
  if (op === "operationsLayout") {
    if (
      !x.sections.length ||
      new Set(x.sections).size !== x.sections.length ||
      x.sections.some((s: string) => !sections.includes(s))
    )
      fail("INVALID_INPUT", 400);
    await db.query(
      "INSERT INTO operations_layout VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET sections=$2",
      [user.id, x.sections],
    );
    return { ok: true };
  }
  if (op === "operationsOverview")
    return {
      layout:
        (
          await db.query(
            "SELECT sections FROM operations_layout WHERE user_id=$1",
            [user.id],
          )
        ).rows[0]?.sections ?? sections,
      status: (
        await db.query(
          "SELECT name,checked_at,value FROM operations_status WHERE name NOT IN('collector-sample','retention') ORDER BY name",
        )
      ).rows,
    };
  if (op === "operationsMetrics") {
    const hours =
        ({ hour: 1, day: 24, week: 168, month: 720 } as Record<string, number>)[
          x.range
        ] ?? 1,
      step = hours > 24 ? 3600 : 60;
    const data = (
      await db.query(
        "SELECT bucket,series,metric,total/n AS average,peak,last FROM operations_metrics WHERE step=$1 AND bucket>=now()-$2::int*interval '1 hour' AND ($3::text IS NULL OR series=$3) ORDER BY bucket,series,metric",
        [step, hours, x.series ?? "http"],
      )
    ).rows;
    const http =
      x.series && x.series !== "http"
        ? []
        : (
            await db.query(
              "SELECT * FROM operations_http WHERE step=$1 AND bucket>=now()-$2::int*interval '1 hour' ORDER BY bucket,kind",
              [step, hours],
            )
          ).rows.map(httpStats);
    return { step, points: data, http };
  }
  if (op === "operationsJobs") {
    let cursor: any = null;
    try {
      if (x.cursor) {
        cursor = JSON.parse(Buffer.from(x.cursor, "base64url").toString());
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          !Number.isFinite(Date.parse(cursor[0])) ||
          typeof cursor[1] !== "string" ||
          typeof cursor[2] !== "string"
        )
          throw Error();
      }
    } catch {
      fail("INVALID_INPUT", 400);
    }
    const rows = (
      await db.query(
        `SELECT * FROM operations_jobs WHERE ($1='all' OR family=$1) AND ($2='all' OR ($2='active' AND state IN('pending','running','scanning','retry','pause_requested','cancel_requested')) OR ($2='attention' AND (error IS NOT NULL OR state IN('paused','blocked','parser_blocked','failed_global','failed')))) AND ($3::text IS NULL OR id=$3) AND ($4::timestamptz IS NULL OR (created_at,family,id)<($4,$5,$6)) ORDER BY created_at DESC,family DESC,id DESC LIMIT 51`,
        [
          x.family ?? "all",
          x.state ?? "all",
          x.id ?? null,
          cursor?.[0] ?? null,
          cursor?.[1] ?? null,
          cursor?.[2] ?? null,
        ],
      )
    ).rows;
    const items = rows.slice(0, 50);
    const syncRows = items.filter((r) => ["sync", "media"].includes(r.family));
    if (syncRows.length) {
      const control = (
        await db.query(
          "SELECT mode,paused,observed_state,cooldown_until FROM ao3_control",
        )
      ).rows[0];
      const jobs = (
        await db.query(
          "SELECT id,kind,state,availability,due_at,started_at,checkpoint?'upload' AS local_upload FROM ao3_jobs WHERE id=ANY($1::uuid[])",
          [syncRows.map((r) => r.id)],
        )
      ).rows;
      for (const r of syncRows) {
        const job = jobs.find((j) => j.id === r.id);
        if (job)
          r.progress = {
            ...r.progress,
            ...jobExecution(
              { ...job, checkpoint: job.local_upload ? { upload: true } : {} },
              control,
            ),
          };
      }
    }
    for (const r of items) {
      r.actions = actions(r, user.role === "Owner");
      r.url = link(r);
      if (r.family === "admin" && !["scrub", "repair"].includes(r.kind))
        r.progress = Object.fromEntries(
          Object.entries(r.progress).filter(
            ([key, value]) =>
              ["objects", "removed", "freed", "available_bytes"].includes(
                key,
              ) && typeof value === "number",
          ),
        );
      if (r.family === "ingest")
        r.progress = {
          ...r.progress,
          ...(
            await db.query(
              "SELECT coalesce(sum(imported),0)::text AS completed,coalesce(sum(total),0)::text AS total,count(*)::int AS sources FROM ingest_sources WHERE batch_id=$1",
              [r.id],
            )
          ).rows[0],
        };
    }
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > 50
          ? Buffer.from(
              JSON.stringify([last.created_at, last.family, last.id]),
            ).toString("base64url")
          : null,
    };
  }
  if (op === "operationsHistory") {
    if (
      !(
        await db.query(
          "SELECT 1 FROM operations_jobs WHERE family=$1 AND id=$2",
          [x.family, x.id],
        )
      ).rowCount
    )
      fail("NOT_FOUND", 404);
    if (x.family === "index")
      return {
        items: (
          await db.query(
            "SELECT id::text,started_at,finished_at,CASE WHEN error IS NULL THEN 'completed' ELSE 'failed' END AS state,jsonb_build_object('processed',processed,'error',error) AS detail FROM operations_index_runs WHERE kind=$1 ORDER BY id DESC LIMIT 50",
            [x.id],
          )
        ).rows,
      };
    if (["sync", "media"].includes(x.family))
      return {
        items: (
          await db.query(
            "SELECT id::text,started_at,finished_at,outcome AS state,detail FROM ao3_runs WHERE job_id=$1::uuid ORDER BY id DESC LIMIT 50",
            [x.id],
          )
        ).rows,
      };
    const audit = (
      await db.query(
        "SELECT 'audit-'||id::text AS id,created_at AS started_at,created_at AS finished_at,action AS state,details AS detail FROM audit WHERE target=$1 ORDER BY id DESC LIMIT 49",
        [x.id],
      )
    ).rows;
    const execution =
      x.family === "ingest"
        ? (
            await db.query(
              "SELECT 'run-'||id::text AS id,coalesce(started_at,created_at) AS started_at,finished_at,state,jsonb_build_object('processed',(SELECT coalesce(sum(imported),0) FROM ingest_sources WHERE batch_id=$1)) AS detail FROM ingest_batches WHERE id=$1",
              [x.id],
            )
          ).rows
        : x.family === "backup"
          ? (
              await db.query(
                "SELECT 'run-'||id::text AS id,created_at AS started_at,CASE WHEN state IN('completed','failed','cancelled') THEN updated_at END AS finished_at,state,progress AS detail FROM backup_runs WHERE id=$1",
                [x.id],
              )
            ).rows
          : (
              await db.query(
                "SELECT 'run-'||id::text AS id,coalesce(started_at,created_at) AS started_at,finished_at,state,progress AS detail FROM archive_jobs WHERE id=$1",
                [x.id],
              )
            ).rows;
    return {
      items: [...execution, ...audit].sort(
        (a, b) =>
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      ),
    };
  }
  if (op === "operationsControl") {
    const r = (
      await db.query(
        "SELECT * FROM operations_jobs WHERE family=$1 AND id=$2",
        [x.family, x.id],
      )
    ).rows[0];
    if (!r) fail("NOT_FOUND", 404);
    if (
      ((r.family === "backup" && r.kind === "restore") ||
        (r.family === "admin" && r.kind === "repair")) &&
      user.role !== "Owner"
    )
      fail("FORBIDDEN", 403);
    if (!actions(r, user.role === "Owner").includes(x.action))
      fail("CONFLICT", 409);
    if (r.family === "admin" && ["scrub", "repair"].includes(r.kind)) {
      const { maintenanceOperation } = await import("./maintenance-admin");
      return maintenanceOperation(
        db,
        "integrityControl",
        { id: r.id, action: x.action },
        user,
      );
    }
    if (r.family === "ingest")
      return archiveOperation(db, "ingestControl", {
        id: r.id,
        action: x.action,
      });
    if (r.family === "backup")
      return backupOperation(
        db,
        "backupControl",
        { id: r.id, action: x.action, requestId: x.requestId },
        user,
      );
    if (["sync", "media"].includes(r.family))
      return syncAdmin(db, "ao3JobControl", {
        id: r.id,
        action: x.action === "pause" ? "pause" : "retry",
      });
    await db.query(
      "UPDATE operations_index SET paused=$2,retry_at=NULL,updated_at=now() WHERE kind=$1",
      [r.id, x.action === "pause"],
    );
    if (r.id === "search" && x.action === "retry")
      await db.query(
        "UPDATE catalog_text_pending SET retry_at=now(),error=NULL WHERE claim IS NULL OR lease_until<=now()",
      );
    return { ok: true };
  }
  fail("NOT_FOUND", 404);
}
