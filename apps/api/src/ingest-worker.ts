import { readParseCache } from "./archive-catalog";
import { IngestPipeline } from "./ingest-pipeline";
import { progressKey } from "./ingest-progress";
import { runQueue } from "./archive-queue";
import { readdir, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pool, migrate, transaction } from "./db";
import {
  ingestRecord,
  ingestRecords,
  archiveTransaction,
  objectBytes,
  preserve,
  store,
} from "./archive";
function validateEnvelope(e: any) {
  if (
    e.schema !== "palimora.ingest.v1" ||
    e.parser !== "ao3-dump-4" ||
    !Number.isSafeInteger(e.cursor) ||
    e.cursor < 0 ||
    typeof e.locator !== "string"
  )
    throw Error("Invalid adapter envelope");
  if (
    e.record &&
    (!Array.isArray(e.record.objects) ||
      !Array.isArray(e.record.chapters) ||
      !e.record.metadata ||
      (e.record.source_hash != null &&
        (typeof e.record.source_hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(e.record.source_hash))) ||
      !["valid", "partial", "metadata_only"].includes(e.record.state))
  )
    throw Error("Invalid adapter record");
}
async function ingestTags(source: any, records: any[]) {
  await transaction(async (db) => {
    const tags = JSON.stringify(
      records.map((e) => ({ source_id: String(e.tag.id), evidence: e.tag })),
    );
    await db.query(
      "INSERT INTO archive_tag_observations(source_path,fingerprint,source_id,evidence) SELECT $1,$2,source_id,evidence FROM jsonb_to_recordset($3::jsonb) r(source_id text,evidence jsonb) ON CONFLICT DO NOTHING",
      [source.path, source.fingerprint, tags],
    );
    await db.query(
      "INSERT INTO archive_tags(source_id,evidence) SELECT source_id,evidence FROM jsonb_to_recordset($1::jsonb) r(source_id text,evidence jsonb) ON CONFLICT DO NOTHING",
      [tags],
    );
    await db.query(
      "UPDATE ingest_sources SET checkpoint=$2,imported=imported+$3 WHERE id=$1",
      [source.id, records[records.length - 1].cursor, records.length],
    );
  });
}
const commitConcurrency = Number(process.env.INGEST_COMMIT_CONCURRENCY ?? 2);
if (
  !Number.isInteger(commitConcurrency) ||
  commitConcurrency < 1 ||
  commitConcurrency > 4
)
  throw Error("INGEST_COMMIT_CONCURRENCY must be 1–4");
const groupRecords = Number(process.env.INGEST_GROUP_RECORDS ?? 256);
if (
  !Number.isSafeInteger(groupRecords) ||
  groupRecords < 1 ||
  groupRecords > 1024
)
  throw Error("INGEST_GROUP_RECORDS must be an integer from 1 to 1024");
const root = process.env.AO3_DUMP_ROOT ?? "/dumps/ao3_stories";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
export async function tick(batchId?: string) {
  const lock = await pool.connect();
  let ownsLeader = false;
  try {
    if (
      !(await lock.query("SELECT pg_try_advisory_lock(70210403) AS locked"))
        .rows[0].locked
    )
      return;
    ownsLeader = true;
    const batch = (
      await pool.query(
        "SELECT * FROM ingest_batches WHERE source_kind='dump' AND state IN ('pending','scanning','running') AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at LIMIT 1",
        [batchId ?? null],
      )
    ).rows[0];
    if (!batch) return;
    let activeSource: any;
    let activeLocator: string | undefined;
    let reconcileFile: string | undefined;
    try {
      await mkdir(join(store.root, "staging"), { recursive: true });
      if (batch.reconcile_batch_id) {
        const ids = (
          await pool.query(
            "SELECT DISTINCT w.external_id FROM archive_works w JOIN ingest_results r ON r.work_id=w.id JOIN ingest_sources s ON s.id=r.source_id AND s.fingerprint=r.fingerprint WHERE s.batch_id=$1 AND w.external_id IS NOT NULL",
            [batch.reconcile_batch_id],
          )
        ).rows.map((r) => r.external_id);
        reconcileFile = join(
          store.root,
          "staging",
          "reconcile-" + batch.id + ".json",
        );
        await writeFile(reconcileFile, JSON.stringify(ids), { mode: 0o600 });
      }

      if (batch.state !== "running") {
        if (
          !(
            await pool.query(
              "UPDATE ingest_batches SET state='scanning',updated_at=now() WHERE id=$1 AND state IN ('pending','scanning') RETURNING id",
              [batch.id],
            )
          ).rowCount
        )
          return;
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (
            (batch.selection.length && !batch.selection.includes(entry.name)) ||
            !entry.isFile() ||
            !/\.(zip|sqlite3|part)$/.test(entry.name)
          )
            continue;
          const s = await stat(join(root, entry.name));
          const fp = `${s.size}:${s.mtimeMs}`;
          const scope = entry.name.endsWith(".sqlite3")
            ? JSON.stringify({
                metadata: batch.metadata_scope,
                reconcile: batch.reconcile_batch_id ?? null,
              })
            : "";
          const old = (
            await pool.query(
              "SELECT id,checkpoint FROM ingest_sources WHERE path=$1 AND fingerprint=$2 AND state='ingested' AND parser='ao3-dump-4' AND scope=$3 LIMIT 1",
              [entry.name, fp, scope],
            )
          ).rows[0];
          const state = entry.name.endsWith(".part")
            ? "incomplete_transfer"
            : old && !batch.reprocess
              ? "ingested"
              : "discovered";
          await transaction(async (db) => {
            const discovered = await db.query(
              "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state,checkpoint,gaps,parser,scope) VALUES($1,$2,$3,$4,$5,$6,$7,'ao3-dump-4',$8) ON CONFLICT(batch_id,path) DO UPDATE SET fingerprint=excluded.fingerprint,parser=excluded.parser,scope=excluded.scope,error=NULL,state=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.state ELSE excluded.state END,checkpoint=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.checkpoint ELSE excluded.checkpoint END,checkpoint_detail=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.checkpoint_detail ELSE excluded.checkpoint_detail END,imported=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.imported ELSE excluded.imported END,gaps=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.gaps ELSE excluded.gaps END,bytes=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.bytes ELSE excluded.bytes END,duplicates=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.duplicates ELSE excluded.duplicates END,attempts=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.attempts ELSE excluded.attempts END,next_retry_at=CASE WHEN ingest_sources.fingerprint=excluded.fingerprint AND ingest_sources.scope=excluded.scope THEN ingest_sources.next_retry_at ELSE excluded.next_retry_at END WHERE ingest_sources.fingerprint<>excluded.fingerprint OR ingest_sources.parser<>excluded.parser OR ingest_sources.scope<>excluded.scope RETURNING id",
              [
                randomUUID(),
                batch.id,
                entry.name,
                fp,
                state,
                state === "ingested" ? old.checkpoint : 0,
                state === "incomplete_transfer" ? 1 : 0,
                scope,
              ],
            );
            if (state === "ingested" && discovered.rowCount) {
              await db.query(
                "INSERT INTO ingest_result_data(source_id,record_id) SELECT $1,r.record_id FROM ingest_result_data r JOIN archive_record_data a ON a.id=r.record_id JOIN archive_origins o ON o.id=a.origin_id WHERE r.source_id=$2 AND o.fingerprint=$3 ON CONFLICT DO NOTHING",
                [discovered.rows[0].id, old.id, fp],
              );
            }
          });
        }
        for (const expected of batch.selection) {
          if (!entries.some((e) => e.name === expected && e.isFile()))
            await pool.query(
              "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state,gaps) VALUES($1,$2,$3,'missing','missing_source',1) ON CONFLICT(batch_id,path) DO NOTHING",
              [randomUUID(), batch.id, expected],
            );
        }
        await pool.query(
          "UPDATE ingest_batches SET state='running',started_at=coalesce(started_at,now()) WHERE id=$1 AND state='scanning'",
          [batch.id],
        );
      }
      const sources = (
        await pool.query(
          "SELECT * FROM ingest_sources WHERE batch_id=$1 AND state IN ('discovered','retry_pending','valid') AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY path",
          [batch.id],
        )
      ).rows;
      for (const source of sources) {
        activeSource = source;
        if (
          stopping ||
          (
            await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
              batch.id,
            ])
          ).rows[0].state !== "running"
        )
          return;
        try {
          const current = await stat(join(root, source.path));
          const fingerprint = `${current.size}:${current.mtimeMs}`;
          if (fingerprint !== source.fingerprint) {
            await pool.query(
              "UPDATE ingest_sources SET fingerprint=$2,checkpoint=0,checkpoint_detail='{}',imported=0,gaps=0,bytes=0,duplicates=0 WHERE id=$1",
              [source.id, fingerprint],
            );
            source.fingerprint = fingerprint;
            source.checkpoint = 0;
            source.checkpoint_detail = {};
            source.gaps = 0;
          }
        } catch (e: any) {
          if (e.code !== "ENOENT")
            throw Object.assign(Error("Source I/O unavailable"), {
              code: "SOURCE_IO",
            });
        }
        await pool.query(
          "UPDATE ingest_sources SET state='valid',error=NULL WHERE id=$1",
          [source.id],
        );
        const p = spawn(
          "python3",
          [
            "-u",
            resolve(__dirname, "../../ingest-adapters/ao3.py"),
            join(root, source.path),
            String(source.checkpoint),
          ],
          {
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            detached: true,
            env: {
              ...process.env,
              PALIMORA_ADAPTER_ACK: "1",
              PALIMORA_ADAPTER_CACHE: "1",
              PALIMORA_METADATA_CACHE: join(store.root, "cache", "metadata"),
              PALIMORA_ADAPTER_PREFETCH: String(commitConcurrency + 1),
              PALIMORA_CACHE_FD: "3",
              PALIMORA_ADAPTER_GROUP_SIZE: String(groupRecords),
              PALIMORA_ADAPTER_GROUP_BYTES: String(16 * 1024 * 1024),
              PALIMORA_ENTRY_CURSOR: JSON.stringify(
                source.checkpoint_detail ?? {},
              ),
              ...(reconcileFile
                ? { PALIMORA_RECONCILE_FILE: reconcileFile }
                : {}),
              PALIMORA_ADAPTER_STAGING: join(store.root, "staging"),
              PALIMORA_METADATA_SCOPE: JSON.stringify(batch.metadata_scope),
            },
          },
        );
        const exit = new Promise<number | null>((yes, no) => {
          p.on("close", yes);
          p.on("error", no);
        });
        p.stdin!.on("error", () => {});
        p.stderr!.resume();
        (p.stdio[3] as import("node:stream").Writable).on("error", () => {});
        void exit.catch(() => {});
        let streamComplete = false;
        let cancelled = false;
        const control = setInterval(() => {
          void pool
            .query("SELECT state FROM ingest_batches WHERE id=$1", [batch.id])
            .then((r) => {
              if (stopping || r.rows[0]?.state !== "running") {
                cancelled = true;
                try {
                  process.kill(-p.pid!, "SIGTERM");
                } catch (e: any) {
                  if (e.code !== "ESRCH") throw e;
                }
              }
            })
            .catch(() => {
              cancelled = true;
              try {
                process.kill(-p.pid!, "SIGTERM");
              } catch (e: any) {
                if (e.code !== "ESRCH") throw e;
              }
            });
        }, 1000);
        control.unref();
        let leased = false;
        let previous = progressKey(source.checkpoint, source.checkpoint_detail);
        const pipeline = new IngestPipeline(
          commitConcurrency,
          () => p.stdin!.write("\n"),
          () => {
            try {
              process.kill(-p.pid!, "SIGTERM");
            } catch (e: any) {
              if (e.code !== "ESRCH") throw e;
            }
          },
        );
        const drain = async () => {
          try {
            await pipeline.drain();
          } finally {
            if (leased) {
              await lock.query("SELECT pg_advisory_unlock_shared(70210405)");
              leased = false;
            }
          }
        };
        let blocked = false;
        let gap = Number(source.gaps) > 0;
        let gapState = "corrupt_source";
        try {
          for await (const line of createInterface({ input: p.stdout! })) {
            if (
              stopping ||
              (
                await pool.query(
                  "SELECT state FROM ingest_batches WHERE id=$1",
                  [batch.id],
                )
              ).rows[0].state !== "running"
            ) {
              try {
                process.kill(-p.pid!, "SIGTERM");
              } catch (e: any) {
                if (e.code !== "ESRCH") throw e;
              }
              return;
            }
            let e: any;
            try {
              e = JSON.parse(line);
              if (e.schema === "palimora.ingest.cache.v1") {
                if (
                  e.parser !== "ao3-dump-4" ||
                  !Array.isArray(e.hashes) ||
                  e.hashes.length > 1024 ||
                  e.hashes.some(
                    (h: any) =>
                      typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h),
                  )
                )
                  throw Error("Invalid cache request");
                const cacheDb = await pool.connect();
                let cached;
                try {
                  cached = await readParseCache(cacheDb, e.parser, e.hashes);
                } finally {
                  cacheDb.release();
                }
                (p.stdio[3] as import("node:stream").Writable).write(
                  JSON.stringify(
                    Object.fromEntries(
                      cached.map((r) => [r.source_hash, r.record]),
                    ),
                  ) + "\n",
                );
                continue;
              }
              if (e.schema === "palimora.ingest.group.v1") {
                if (
                  e.parser !== "ao3-dump-4" ||
                  !Array.isArray(e.records) ||
                  !e.records.length ||
                  e.records.length > 1024
                )
                  throw Error("Invalid adapter group");
                for (const record of e.records) {
                  validateEnvelope(record);
                  if (!record.record && !record.tag)
                    throw Error("Invalid grouped record");
                  if (Boolean(record.tag) !== Boolean(e.records[0].tag))
                    throw Error("Mixed adapter group");
                }
              } else validateEnvelope(e);
            } catch (error: any) {
              throw Object.assign(error, { code: "PARSER_CONTRACT" });
            }
            if (e.schema === "palimora.ingest.group.v1" && !e.records[0].tag) {
              if (!leased) {
                await lock.query("SELECT pg_advisory_lock_shared(70210405)");
                leased = true;
              }
              const keys = e.records.flatMap((r: any) => [
                "provisional:" +
                  source.path +
                  ":" +
                  (r.record.source_entry || r.locator),
                ...(r.record.external_id
                  ? ["external:" + r.record.external_id]
                  : []),
              ]);
              // Resolve both direct and linked identities through indexed keys.
              const identities = await pool.query(
                `SELECT w.id,l.canonical_work_id FROM archive_work_heads w
                LEFT JOIN archive_identity_links l ON l.work_id=w.id
                WHERE w.external_id=ANY($1::text[]) OR w.provisional_entry_id IN (
                  SELECT e.id FROM archive_entries e JOIN archive_paths p ON p.id=e.path_id
                  WHERE p.path=$2 AND e.locator=ANY($3::text[]))`,
                [
                  e.records
                    .map((r: any) => r.record.external_id)
                    .filter(Boolean),
                  source.path,
                  e.records.map((r: any) => r.record.source_entry || r.locator),
                ],
              );
              keys.push(
                ...identities.rows.flatMap((r) => [
                  "work:" + r.id,
                  ...(r.canonical_work_id
                    ? ["work:" + r.canonical_work_id]
                    : []),
                ]),
              );
              for (const record of e.records) {
                const [cursor, row] = previous.split(":").map(Number);
                const nextRow = record.checkpoint_detail?.row ?? 0;
                if (
                  !Number.isSafeInteger(nextRow) ||
                  nextRow < 0 ||
                  record.cursor < cursor ||
                  (record.cursor === cursor && nextRow <= row)
                )
                  throw Object.assign(
                    Error("Non-monotonic adapter checkpoint"),
                    { code: "PARSER_CONTRACT" },
                  );
                record.previous = previous;
                previous = progressKey(record.cursor, record.checkpoint_detail);
              }
              await pipeline.add(keys, async () => {
                try {
                  await ingestRecords(source, e.records);
                } catch (error: any) {
                  activeLocator = error.ingestLocator ?? e.records[0].locator;
                  throw error;
                }
              });
              if (e.records.some((v: any) => v.record.state === "partial")) {
                gap = true;
                gapState = "corrupt_source";
              }
              continue;
            }
            await drain();
            if (e.schema === "palimora.ingest.group.v1") {
              await ingestTags(source, e.records);
              const last = e.records[e.records.length - 1];
              previous = progressKey(last.cursor, last.checkpoint_detail);
              p.stdin!.write("\n");
              continue;
            }
            if (e.index_progress === undefined && e.total === undefined)
              previous = progressKey(e.cursor, e.checkpoint_detail);
            activeLocator = e.locator;
            if (e.index_progress !== undefined) {
              await pool.query(
                "UPDATE ingest_sources SET index_progress=$2::bigint WHERE id=$1",
                [source.id, e.index_progress],
              );
              p.stdin!.write("\n");
              continue;
            }
            if (e.io_error)
              throw Object.assign(Error(e.message), {
                code: e.io_error === 28 ? "ENOSPC" : "SOURCE_IO",
              });
            if (e.total !== undefined) {
              await pool.query(
                "UPDATE ingest_sources SET total=$2 WHERE id=$1",
                [source.id, e.total],
              );
              p.stdin!.write("\n");
              continue;
            }
            if (e.tag) {
              await ingestTags(source, [e]);
              p.stdin!.write("\n");
              continue;
            }
            if (e.artifact || e.artifacts) {
              await archiveTransaction(async (db) => {
                const refs = [];
                for (const o of e.artifacts ?? [e.artifact]) {
                  const bytes = await objectBytes(o, db);
                  await preserve(db, [{ kind: o.kind, bytes }]);
                  refs.push({ name: o.name, hash: o.hash });
                }
                await db.query(
                  "INSERT INTO archive_outbox(event,payload) VALUES($1,$2)",
                  [
                    "ingest.artifact.preserved",
                    { source: source.path, locator: e.locator, objects: refs },
                  ],
                );
                await db.query(
                  "UPDATE ingest_sources SET checkpoint=$2,checkpoint_detail='{}',bytes=bytes+$3 WHERE id=$1",
                  [source.id, e.cursor, e.bytes ?? 0],
                );
              });
              p.stdin!.write("\n");
              continue;
            }

            if (e.gap || e.blocked)
              await pool.query(
                "INSERT INTO ingest_issues(source_id,locator,code,detail,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                [
                  source.id,
                  e.locator,
                  e.gap ?? e.blocked.code,
                  e.blocked ?? {
                    cursor: e.cursor,
                    detail: e.detail,
                    parser: e.parser,
                  },
                  source.fingerprint,
                ],
              );
            if (e.blocked) {
              blocked = true;
              await pool.query(
                "UPDATE ingest_sources SET state='parser_unsupported',error=$2 WHERE id=$1",
                [
                  source.id,
                  {
                    ...e.blocked,
                    locator: e.locator,
                    cursor: e.cursor,
                    parser: e.parser,
                  },
                ],
              );
              await pool.query(
                "UPDATE ingest_batches SET state='parser_blocked',error=$2 WHERE id=$1",
                [
                  batch.id,
                  {
                    source: source.path,
                    ...e.blocked,
                    locator: e.locator,
                    cursor: e.cursor,
                  },
                ],
              );
              break;
            }
            if (e.gap) {
              gap = true;
              gapState = e.gap;
              await pool.query(
                "UPDATE ingest_sources SET gaps=gaps+1,error=$2,checkpoint=GREATEST(checkpoint,$3::bigint),checkpoint_detail=CASE WHEN checkpoint<$3::bigint THEN '{}'::jsonb ELSE checkpoint_detail END WHERE id=$1",
                [source.id, { code: e.gap, locator: e.locator }, e.cursor],
              );
            } else if (e.record) {
              try {
                await ingestRecord(source, e);
              } catch (error: any) {
                activeLocator = error.ingestLocator ?? activeLocator;
                throw error;
              }
              if (e.record.state === "partial") {
                gap = true;
                gapState = "corrupt_source";
              }
            } else
              await pool.query(
                "UPDATE ingest_sources SET checkpoint=$2,checkpoint_detail='{}' WHERE id=$1",
                [source.id, e.cursor],
              );
            p.stdin!.write("\n");
          }
          await drain();
          streamComplete = true;
        } finally {
          clearInterval(control);
          try {
            await drain();
          } finally {
            if (!streamComplete || blocked || cancelled || stopping)
              try {
                process.kill(-p.pid!, "SIGTERM");
              } catch (e: any) {
                if (e.code !== "ESRCH") throw e;
              }
          }
        }
        const code = await exit;
        if (blocked || cancelled || stopping) return;
        if (code !== 0) throw Error("ADAPTER_PROCESS_FAILED");
        await pool.query(
          "UPDATE ingest_sources SET state=$2,index_progress=NULL WHERE id=$1",
          [source.id, gap ? gapState : "ingested"],
        );
      }
      if (
        (
          await pool.query(
            "SELECT 1 FROM ingest_sources WHERE batch_id=$1 AND state IN ('discovered','retry_pending','valid') LIMIT 1",
            [batch.id],
          )
        ).rowCount
      )
        return;
      await pool.query(
        "UPDATE ingest_batches SET state=CASE WHEN EXISTS(SELECT 1 FROM ingest_sources WHERE batch_id=$1 AND gaps>0) THEN 'completed_with_gaps' ELSE 'completed' END,updated_at=now(),finished_at=now() WHERE id=$1 AND state='running'",
        [batch.id],
      );
    } catch (e: any) {
      if (
        activeSource &&
        (e.code === "PARSER_CONTRACT" ||
          [
            "ADAPTER_PATH",
            "ADAPTER_HASH",
            "ADAPTER_RANGE",
            "CHAPTER_OBJECT_MISSING",
          ].includes(e.message))
      ) {
        const detail = {
          code: e.code ?? e.message,
          locator: activeLocator,
          source: activeSource.path,
          parser: "ao3-dump-4",
          trace: e.stack,
        };
        await transaction(async (db) => {
          await db.query(
            "UPDATE ingest_sources SET state='parser_unsupported',error=$2 WHERE id=$1",
            [activeSource.id, detail],
          );
          await db.query(
            "INSERT INTO ingest_issues(source_id,locator,code,detail,fingerprint) VALUES($1,$2,'parser_unsupported',$3,$4) ON CONFLICT DO NOTHING",
            [
              activeSource.id,
              activeLocator ?? "source",
              detail,
              activeSource.fingerprint,
            ],
          );
          await db.query(
            "UPDATE ingest_batches SET state='parser_blocked',error=$2 WHERE id=$1",
            [batch.id, detail],
          );
        });
        return;
      }
      if (e.code === "SOURCE_IO" && activeSource) {
        const attempts = Number(activeSource.attempts) + 1;
        await pool.query(
          "UPDATE ingest_sources SET attempts=$2,state=$3,next_retry_at=now()+($4::text||' seconds')::interval,gaps=CASE WHEN $2>=5 THEN gaps+1 ELSE gaps END,error=$5 WHERE id=$1",
          [
            activeSource.id,
            attempts,
            attempts >= 5 ? "corrupt_source" : "retry_pending",
            Math.min(300, 2 ** attempts),
            { code: "SOURCE_IO" },
          ],
        );
        throw e;
      }
      await pool.query(
        "UPDATE ingest_batches SET state='failed_global',error=$2,updated_at=now() WHERE id=$1",
        [batch.id, { code: e.code ?? "INGEST_FAILURE", message: e.message }],
      );
    } finally {
      if (reconcileFile) await unlink(reconcileFile).catch(() => {});
    }
  } finally {
    if (ownsLeader) await lock.query("SELECT pg_advisory_unlock(70210403)");
    lock.release();
  }
}
async function main() {
  await migrate();
  await mkdir(join(store.root, "staging"), { recursive: true });
  await refreshInventory();
  let refreshing = false;
  const inventoryTimer = setInterval(() => {
    if (refreshing || stopping) return;
    refreshing = true;
    void refreshInventory()
      .catch(() =>
        console.error(JSON.stringify({ event: "ingest_inventory_retry" })),
      )
      .finally(() => {
        refreshing = false;
      });
  }, 30000);
  inventoryTimer.unref();
  try {
    await runQueue(
      async (id) => {
        await refreshInventory();
        await tick(id);
      },
      () => stopping,
    );
  } finally {
    clearInterval(inventoryTimer);
    await pool.end();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error("Ingest worker stopped: database unavailable");
    process.exit(1);
  });
export async function refreshInventory() {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const names = [];
    for (const e of entries) {
      if (!e.isFile() || !/\.(zip|sqlite3|part)$/.test(e.name)) continue;
      names.push(e.name);
      const s = await stat(join(root, e.name));
      await pool.query(
        "INSERT INTO ingest_inventory(path,size,state) VALUES($1,$2,$3) ON CONFLICT(path) DO UPDATE SET size=excluded.size,state=excluded.state,updated_at=now()",
        [
          e.name,
          s.size,
          e.name.endsWith(".part") ? "incomplete_transfer" : "discovered",
        ],
      );
    }
    await pool.query(
      "UPDATE ingest_inventory SET state='missing_source',updated_at=now() WHERE NOT(path=ANY($1::text[]))",
      [names],
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    await pool.query(
      "UPDATE ingest_inventory SET state='missing_source',updated_at=now()",
    );
  }
}
