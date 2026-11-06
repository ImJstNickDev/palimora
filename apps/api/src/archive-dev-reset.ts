import { mkdir, readdir, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { pool, transaction } from "./db";
import { store } from "./archive";

export const devArchiveEnabled = () => process.env.PALIMORA_DEV === "1";

// Explicit scope: never CASCADE into identity or future library tables.
const tables = [
  "archive_admin_requests",
  "archive_paths",
  "archive_entries",
  "archive_origins",
  "archive_parsers",
  "archive_fields",
  "archive_reasons",
  "archive_packs",
  "archive_kinds",
  "archive_dictionaries",

  "archive_payloads",
  "archive_revision_data",
  "archive_chapters",
  "archive_dispatch",
  "archive_observation_data",
  "archive_cache_data",
  "archive_evidence_data",
  "archive_selection_data",
  "archive_identity_links",
  "archive_media_references",
  "archive_metadata_data",
  "archive_object_data",
  "archive_outbox",
  "archive_pack_leases",
  "archive_reconciliations",
  "archive_record_data",
  "archive_snapshot_chapters",
  "archive_snapshot_data",
  "archive_tag_observations",
  "archive_tags",
  "archive_work_heads",
  "ingest_batches",
  "ingest_issues",
  "ingest_result_data",
  "ingest_progress",
  "ingest_sources",
];

/** Called with both BullMQ workers paused. A durable job gates archive writes
 * until catalog, queues and files have all been cleared; every step is replayable. */
export async function resetDevArchive(clearQueues: () => Promise<void>) {
  if (!devArchiveEnabled()) throw Error("DEV_ONLY");
  const leader = await pool.connect();
  let ownsLeader = false;
  try {
    if (
      !(await leader.query("SELECT pg_try_advisory_lock(70210403) AS yes"))
        .rows[0].yes
    )
      return;
    ownsLeader = true;
    const job = (
      await pool.query(
        "SELECT * FROM archive_jobs WHERE kind='reset_dev' AND state IN ('pending','running') ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!job) return;
    await pool.query("UPDATE archive_jobs SET state='running' WHERE id=$1", [
      job.id,
    ]);
    try {
      for (const name of ["packs", "staging", "cache"]) {
        await mkdir(join(store.root, name), { recursive: true });
        if (!(await lstat(join(store.root, name))).isDirectory())
          throw Error("STORAGE_PATH");
      }
      if (!job.result?.catalog_cleared) {
        await transaction(async (db) => {
          await db.query("SELECT pg_advisory_xact_lock(70210402)");
          await db.query("SET LOCAL lock_timeout='5s'");
          await db.query(
            "TRUNCATE " + tables.map((name) => '"' + name + '"').join(","),
          );
          await db.query(
            "INSERT INTO archive_payloads VALUES(sha256(convert_to('{}','UTF8')),0,NULL,2,convert_to('{}','UTF8'))",
          );
          await db.query("DELETE FROM archive_jobs WHERE id<>$1", [job.id]);
          await db.query("UPDATE archive_jobs SET result=$2 WHERE id=$1", [
            job.id,
            { catalog_cleared: true },
          ]);
        });
      }
      await clearQueues();
      // Keep mount roots in place. No backup, source traversal or source deletion.
      for (const name of ["packs", "staging", "cache"])
        for (const entry of await readdir(join(store.root, name)))
          await rm(join(store.root, name, entry), {
            recursive: true,
            force: true,
          });
      await pool.query(
        "UPDATE archive_jobs SET state='completed',result=$2 WHERE id=$1",
        [
          job.id,
          { catalog_cleared: true, queues_cleared: true, files_cleared: true },
        ],
      );
    } catch (error: any) {
      await pool.query(
        "UPDATE archive_jobs SET state='failed',result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",
        [
          job.id,
          JSON.stringify({
            code: error.code ?? "RESET_FAILED",
            message: error.message,
          }),
        ],
      );
    }
  } finally {
    if (ownsLeader) await leader.query("SELECT pg_advisory_unlock(70210403)");
    leader.release();
  }
}
