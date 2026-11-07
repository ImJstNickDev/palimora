import {
  hydrateWorks,
  hydrateEvidence,
  internPayload,
} from "./archive-catalog";
import { stageRows, catalogPrelude, selectionSQL } from "./archive-bulk";
import { statfs } from "node:fs/promises";
import { DB } from "./db";
import { readObject, store } from "./archive";
import { fail } from "./security";
import { devArchiveEnabled } from "./archive-dev-reset";
export async function archiveOperation(
  db: DB,
  op: string,
  x: any,
): Promise<any> {
  if (
    [
      "ingestCreate",
      "ingestControl",
      "archiveResolve",
      "archiveMaintenance",
      "archiveDevReset",
    ].includes(op)
  ) {
    if (op === "archiveResolve")
      await db.query("SELECT pg_advisory_xact_lock(70210405)");
    await db.query("SELECT pg_advisory_xact_lock(70210402)");
    if (
      op !== "archiveDevReset" &&
      (
        await db.query(
          "SELECT 1 FROM archive_jobs WHERE kind='reset_dev' AND state IN ('pending','running','failed') LIMIT 1",
        )
      ).rowCount
    )
      fail("CONFLICT", 409);
  }
  const one = async (sql: string, args: any[]) => {
    const r = (await db.query(sql, args)).rows[0];
    if (!r) fail("NOT_FOUND", 404);
    return r;
  };
  const oneWork = async (id: string, lock = false) =>
    (
      await hydrateWorks(db, [
        await one(
          lock
            ? "SELECT v.* FROM archive_work_heads w JOIN archive_works v ON v.id=w.id WHERE w.id=$1 FOR UPDATE OF w"
            : "SELECT v.*,(SELECT canonical_work_id FROM archive_identity_links WHERE work_id=v.id) AS canonical_work_id FROM archive_works v WHERE v.id=$1",
          [id],
        ),
      ])
    )[0];
  switch (op) {
    case "archiveDevReset": {
      if (!devArchiveEnabled()) fail("NOT_FOUND", 404);
      if (x.confirmation !== "RESET") fail("INVALID_INPUT", 400);
      const previous = (
        await db.query("SELECT kind,state FROM archive_jobs WHERE id=$1", [
          x.requestId,
        ])
      ).rows[0];
      if (previous) {
        if (previous.kind !== "reset_dev") fail("CONFLICT", 409);
        if (previous.state !== "failed") return { ok: true };
      }
      if (
        (
          await db.query(
            "SELECT 1 FROM archive_jobs WHERE kind<>'reset_dev' AND state IN ('pending','running') LIMIT 1",
          )
        ).rowCount
      )
        fail("CONFLICT", 409);
      const reset = (
        await db.query(
          "SELECT id,state FROM archive_jobs WHERE kind='reset_dev' AND state IN ('pending','running','failed') ORDER BY created_at LIMIT 1",
        )
      ).rows[0];
      if (reset) {
        if (reset.state === "failed")
          await db.query(
            "UPDATE archive_jobs SET state='pending' WHERE id=$1",
            [reset.id],
          );
      } else
        await db.query(
          "INSERT INTO archive_jobs(id,kind) VALUES($1,'reset_dev')",
          [x.requestId],
        );
      await db.query(
        "UPDATE ingest_batches SET state='paused',updated_at=now() WHERE state IN ('pending','scanning','running')",
      );
      return { ok: true };
    }
    case "archiveDownload":
      await one(
        "SELECT encode(hash,'hex') AS hash FROM archive_object_data WHERE hash=decode($1,'hex')",
        [x.hash],
      );
      return { hash: x.hash };
    case "archiveInventory":
      return {
        items: (await db.query("SELECT * FROM ingest_inventory ORDER BY path"))
          .rows,
      };
    case "ingestReport": {
      await one("SELECT id FROM ingest_batches WHERE id=$1", [x.id]);
      const summary = (
        await db.query(
          "SELECT count(*)::int AS sources,coalesce(sum(imported),0)::text AS records,coalesce(sum(bytes),0)::text AS bytes,coalesce(sum(duplicates),0)::text AS duplicates,coalesce(sum(gaps),0)::text AS gaps,coalesce(sum(checkpoint),0)::text AS checkpoints,CASE WHEN bool_and(total IS NOT NULL) THEN sum(total)::text ELSE NULL END AS total FROM ingest_sources WHERE batch_id=$1",
          [x.id],
        )
      ).rows[0];
      const b = await one(
        "SELECT state,started_at,finished_at FROM ingest_batches WHERE id=$1",
        [x.id],
      );
      const counts = (
        await db.query(
          "SELECT s.state,count(*)::int AS count FROM archive_snapshots s WHERE EXISTS(SELECT 1 FROM ingest_results r JOIN ingest_sources f ON f.id=r.source_id AND f.fingerprint=r.fingerprint WHERE f.batch_id=$1 AND r.snapshot_id=s.id) GROUP BY s.state",
          [x.id],
        )
      ).rows;
      const issues = (
        await db.query(
          "SELECT i.id::text,s.path,i.fingerprint,i.locator,i.code,i.detail FROM ingest_issues i JOIN ingest_sources s ON s.id=i.source_id WHERE s.batch_id=$1 AND i.id>$2 AND ($3::text IS NULL OR s.path=$3) ORDER BY i.id LIMIT 101",
          [x.id, x.cursor ?? "0", x.path ?? null],
        )
      ).rows;
      const workCounts = (
        await db.query(
          `SELECT state,count(*)::int AS count FROM (SELECT r.work_id,CASE WHEN bool_or(s.state='valid') THEN 'valid' WHEN bool_or(s.state='partial') THEN 'partial' ELSE 'metadata_only' END AS state FROM ingest_results r JOIN archive_snapshots s ON s.id=r.snapshot_id JOIN ingest_sources f ON f.id=r.source_id AND f.fingerprint=r.fingerprint WHERE f.batch_id=$1 GROUP BY r.work_id) grouped GROUP BY state`,
          [x.id],
        )
      ).rows;
      const sourceCounts = (
        await db.query(
          "SELECT state,count(*)::int AS count FROM ingest_sources WHERE batch_id=$1 GROUP BY state",
          [x.id],
        )
      ).rows;
      const seconds = b.started_at
        ? ((b.finished_at ?? new Date()).getTime() - b.started_at.getTime()) /
          1000
        : 0;
      const rate = seconds ? Number(summary.records) / seconds : 0;
      return {
        summary: {
          ...summary,
          ...b,
          content: counts,
          works: workCounts,
          sources_by_state: sourceCounts,
          elapsed_seconds: seconds,
          records_per_second: rate,
          eta_seconds:
            summary.total && rate
              ? Math.max(
                  0,
                  (Number(summary.total) - Number(summary.checkpoints)) / rate,
                )
              : null,
        },
        issues: issues.slice(0, 100),
        next: issues.length > 100 ? issues[99].id : null,
      };
    }
    case "archiveConflicts": {
      const conflicts = (
        await db.query(
          "SELECT id,kind,detail FROM archive_reconciliations WHERE work_id=$1 AND resolved_at IS NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101",
          [x.id, x.cursor ?? null],
        )
      ).rows;
      const evidence = await hydrateEvidence(
        db,
        (
          await db.query(
            "SELECT id::text,field,payload_hash,source_path,locator,parser FROM archive_evidence_observations WHERE work_id=$1 AND id>$2::bigint ORDER BY id LIMIT 101",
            [x.id, x.evidenceCursor ?? "0"],
          )
        ).rows,
      );
      return {
        items: conflicts.slice(0, 100),
        next: conflicts.length > 100 ? conflicts[99].id : null,
        evidence: evidence.slice(0, 100),
        nextEvidence: evidence.length > 100 ? evidence[99].id : null,
      };
    }
    case "archiveResolve": {
      if (
        ["head", "identity"].includes(x.kind) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          x.target,
        )
      )
        fail("INVALID_INPUT", 400);
      if (x.kind === "metadata" && (!x.field || !/^[0-9]+$/.test(x.target)))
        fail("INVALID_INPUT", 400);

      await db.query("SELECT pg_advisory_xact_lock(70210402)");
      if (
        (
          await db.query("SELECT 1 FROM archive_admin_requests WHERE id=$1", [
            x.requestId,
          ])
        ).rowCount
      )
        return { ok: true };
      const w = await oneWork(x.id, true);
      const oldAlias =
        (
          await db.query(
            "SELECT canonical_work_id FROM archive_identity_links WHERE work_id=$1",
            [x.id],
          )
        ).rows[0]?.canonical_work_id ?? null;
      if (x.kind === "unlink") {
        await db.query("DELETE FROM archive_identity_links WHERE work_id=$1", [
          x.id,
        ]);
      } else if (x.kind === "head") {
        const snapshot = await one(
          "SELECT id FROM archive_snapshots WHERE id=$1 AND work_id=$2 AND state='valid'",
          [x.target, x.id],
        );
        await db.query(
          "UPDATE archive_work_heads SET current_snapshot_id=$2,head_reason=$3 WHERE id=$1",
          [x.id, snapshot.id, "admin: " + x.reason],
        );
      } else if (x.kind === "metadata") {
        const ev = (
          await hydrateEvidence(db, [
            await one(
              "SELECT field,payload_hash,source_path,locator FROM archive_evidence_observations WHERE work_id=$1 AND field=$2 AND id=$3::bigint",
              [x.id, x.field, x.target],
            ),
          ])
        )[0];
        const selected =
          (
            await db.query(
              "SELECT fields FROM archive_selection_docs WHERE work_id=$1",
              [x.id],
            )
          ).rows[0]?.fields ?? {};
        selected[x.field] = {
          confidence: "admin",
          source_path: ev.source_path,
          locator: ev.locator,
          reason: x.reason,
        };
        await stageRows(db, {
          selections: [{ work_id: x.id, fields: selected }],
        });
        await db.query([...catalogPrelude(), selectionSQL()].join(";"));
        const metadata = { ...w.metadata, [x.field]: ev.value };
        const hash = await internPayload(db, metadata);
        await db.query(
          "UPDATE archive_work_heads SET metadata_hash=$2,title=($3::jsonb)::text WHERE id=$1",
          [
            x.id,
            hash,
            JSON.stringify(metadata.title ?? metadata.Title) ?? null,
          ],
        );
      } else if (x.kind === "external_id") {
        if (!/^[0-9]+$/.test(x.target)) fail("INVALID_INPUT", 400);
        await db.query(
          "UPDATE archive_work_heads SET external_id=$2 WHERE id=$1",
          [x.id, x.target],
        );
      } else {
        const target = await oneWork(x.target, true);
        if (
          target.id === w.id ||
          (w.external_id &&
            target.external_id &&
            w.external_id !== target.external_id)
        )
          fail("CONFLICT", 409);
        if (
          (
            await db.query(
              "SELECT 1 FROM archive_identity_links WHERE canonical_work_id=$1 OR work_id=$2",
              [w.id, target.id],
            )
          ).rowCount
        )
          fail("CONFLICT", 409);
        await db.query(
          "INSERT INTO archive_identity_links(work_id,canonical_work_id) VALUES($1,$2) ON CONFLICT(work_id) DO UPDATE SET canonical_work_id=excluded.canonical_work_id",
          [w.id, target.id],
        );
      }
      await db.query(
        "UPDATE archive_reconciliations SET resolved_at=now(),resolution=$2 WHERE work_id=$1 AND kind=$3 AND resolved_at IS NULL AND ($3<>'metadata' OR detail->>'field'=$4::text)",
        [
          x.id,
          x,
          x.kind === "head"
            ? "chronology"
            : ["external_id", "unlink"].includes(x.kind)
              ? "identity"
              : x.kind,
          x.field ?? null,
        ],
      );
      await db.query(
        "INSERT INTO archive_outbox(event,payload) VALUES($1,$2)",
        [
          "archive.admin.resolved",
          {
            ...x,
            before: {
              canonical_work_id: oldAlias,
              metadata: w.metadata,
              external_id: w.external_id,
              current_snapshot_id: w.current_snapshot_id,
            },
            after: (({ metadata, external_id, current_snapshot_id }) => ({
              metadata,
              external_id,
              current_snapshot_id,
            }))(await oneWork(x.id)),
          },
        ],
      );
      await db.query(
        "INSERT INTO archive_admin_requests(id,result) VALUES($1,$2)",
        [x.requestId, { ok: true }],
      );
      return { ok: true };
    }
    case "archiveMaintenance":
      await db.query(
        "INSERT INTO archive_jobs(id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [x.requestId, x.kind],
      );
      return { ok: true };
    case "archiveStorage": {
      const disk = await statfs(store.root).catch(() => null);
      const totals = (
        await db.query(`
        WITH grouped AS (
          SELECT kind,pack,count(*) AS objects,sum(size) AS bytes,sum(length) AS packed_bytes
          FROM archive_objects GROUP BY GROUPING SETS ((kind),(pack))
        ) SELECT count(*) FILTER(WHERE kind IS NULL)::text AS packs,
          coalesce(sum(objects) FILTER(WHERE kind IS NOT NULL),0)::text AS objects,
          coalesce(sum(bytes) FILTER(WHERE kind IS NOT NULL),0)::text AS bytes,
          coalesce(sum(packed_bytes) FILTER(WHERE kind IS NOT NULL),0)::text AS packed_bytes,
          coalesce(jsonb_agg(jsonb_build_object('kind',kind,'objects',objects::text,'bytes',bytes::text,'packed_bytes',packed_bytes::text)
            ORDER BY packed_bytes DESC) FILTER(WHERE kind IS NOT NULL),'[]'::jsonb) AS kinds
          FROM grouped`)
      ).rows[0];
      return {
        dev_reset_available: devArchiveEnabled(),
        available_bytes: disk ? disk.bavail * disk.bsize : null,
        total_bytes: disk ? disk.blocks * disk.bsize : null,
        reserve_bytes: Number(process.env.ARCHIVE_RESERVE_BYTES ?? 268435456),
        ...totals,
        jobs: (
          await db.query(
            "SELECT id,kind,state,result,created_at FROM archive_jobs ORDER BY created_at DESC,id DESC LIMIT 50",
          )
        ).rows,
      };
    }
    case "ingestBatches": {
      const items = (
        await db.query(
          `
        SELECT b.*,s.* FROM ingest_batches b
        CROSS JOIN LATERAL (SELECT count(*)::int AS sources,coalesce(sum(imported),0)::text AS processed,
          coalesce(sum(gaps),0)::text AS gaps,count(*) FILTER(WHERE state IN ('ingested','missing_source','incomplete_transfer','corrupt_source'))::int AS done_sources
          FROM ingest_sources WHERE batch_id=b.id) s
        WHERE b.source_kind='dump' AND ($1::uuid IS NULL OR (b.created_at,b.id)<(SELECT created_at,id FROM ingest_batches WHERE id=$1))
          AND ($2='all' OR ($2='active' AND b.state IN ('pending','scanning','running'))
          OR ($2='attention' AND b.state IN ('paused','parser_blocked','failed_global','completed_with_gaps'))
          OR ($2='finished' AND b.state IN ('completed','completed_with_gaps')))
          AND ($3='' OR b.id::text ILIKE '%'||$3||'%' OR EXISTS(SELECT 1 FROM unnest(b.selection) p WHERE p ILIKE '%'||$3||'%'))
        ORDER BY b.created_at DESC,b.id DESC LIMIT 51`,
          [x.cursor ?? null, x.filter ?? "all", (x.q ?? "").trim()],
        )
      ).rows;
      return {
        items: items.slice(0, 50),
        next: items.length > 50 ? items[49].id : null,
      };
    }
    case "ingestCreate":
      return one(
        "INSERT INTO ingest_batches(id,state,reprocess,selection,metadata_scope,reconcile_batch_id) VALUES($1,'pending',$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET id=excluded.id RETURNING *",
        [
          x.requestId,
          x.reprocess,
          x.selection ?? [],
          x.metadataScope ?? [],
          x.reconcileBatchId ?? null,
        ],
      );
    case "ingestDetail":
      return {
        batch: await one("SELECT * FROM ingest_batches WHERE id=$1", [x.id]),
        sources: (
          await db.query(
            "SELECT * FROM ingest_sources WHERE batch_id=$1 ORDER BY path",
            [x.id],
          )
        ).rows,
      };
    case "ingestControl": {
      const b = await one(
        "SELECT * FROM ingest_batches WHERE id=$1 FOR UPDATE",
        [x.id],
      );
      if (x.action === "pause") {
        if (!["pending", "scanning", "running", "paused"].includes(b.state))
          fail("CONFLICT", 409);
        await db.query(
          "UPDATE ingest_batches SET state='paused',updated_at=now() WHERE id=$1",
          [x.id],
        );
      } else {
        if (!["paused", "parser_blocked", "failed_global"].includes(b.state))
          fail("CONFLICT", 409);
        await db.query(
          "UPDATE ingest_sources SET state='retry_pending',error=NULL WHERE batch_id=$1 AND state IN ('parser_unsupported','valid')",
          [x.id],
        );
        await db.query(
          "UPDATE ingest_batches SET state='pending',error=NULL,updated_at=now(),generation=generation+1 WHERE id=$1",
          [x.id],
        );
      }
      return { ok: true };
    }
    case "archiveWorks": {
      const query = (x.q ?? "").trim();
      const filter = /^[0-9]+$/.test(query)
        ? "external_id=$2"
        : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              query,
            )
          ? "id=$2::uuid"
          : "($2='' OR title ILIKE '%'||$2||'%')";
      const items = await hydrateWorks(
        db,
        (
          await db.query(
            `SELECT w.*,
            (SELECT count(*)::int FROM archive_snapshots WHERE work_id=w.id OR work_id IN (SELECT work_id FROM archive_identity_links WHERE canonical_work_id=w.id)) AS snapshots,
            (SELECT count(*)::int FROM archive_reconciliations WHERE work_id=w.id AND resolved_at IS NULL) AS conflicts
            FROM archive_works w WHERE NOT EXISTS(SELECT 1 FROM archive_identity_links WHERE work_id=w.id)
            AND ($1::uuid IS NULL OR id>$1) AND ` +
              filter +
              ` AND ($3='all' OR ($3='current' AND current_snapshot_id IS NOT NULL) OR ($3='missing' AND current_snapshot_id IS NULL)
              OR ($3='conflicts' AND EXISTS(SELECT 1 FROM archive_reconciliations WHERE work_id=w.id AND resolved_at IS NULL))) ORDER BY id LIMIT 51`,
            [x.cursor ?? null, query, x.filter ?? "all"],
          )
        ).rows,
      );
      return {
        items: items.slice(0, 50),
        next: items.length > 50 ? items[49].id : null,
      };
    }
    case "archiveWork": {
      const snapshots = (
        await db.query(
          "SELECT * FROM archive_snapshots WHERE (work_id=$1 OR work_id IN (SELECT work_id FROM archive_identity_links WHERE canonical_work_id=$1)) AND ($2::uuid IS NULL OR (imported_at,id)<(SELECT imported_at,id FROM archive_snapshots WHERE id=$2)) ORDER BY imported_at DESC,id DESC LIMIT 51",
          [x.id, x.cursor ?? null],
        )
      ).rows;
      return {
        work: await oneWork(x.id),
        snapshots: snapshots.slice(0, 50),
        next: snapshots.length > 50 ? snapshots[49].id : null,
      };
    }
    case "archiveSnapshot": {
      const s = await one(
        "SELECT manifest_hash FROM archive_snapshots WHERE id=$1",
        [x.id],
      );
      return {
        manifest: JSON.parse(
          (await readObject(db, s.manifest_hash)).toString(),
        ),
      };
    }
    case "archiveObject": {
      const object = await one(
        "SELECT k.name AS kind,o.size FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id WHERE o.hash=decode($1,'hex')",
        [x.hash],
      );
      const preview = [
        "chapter_html",
        "notes_html",
        "document_html",
        "css",
        "manifest",
        "metadata",
        "observation",
        "source_text",
        "package_metadata",
        "chunk_manifest",
      ].includes(object.kind);
      return {
        ...object,
        base64: preview
          ? (await readObject(db, x.hash)).subarray(0, 65536).toString("base64")
          : null,
        truncated: preview && Number(object.size) > 65536,
      };
    }
  }
  throw Error("UNKNOWN_ARCHIVE_OPERATION");
}
