import { opendir, stat, unlink, statfs, rm } from "node:fs/promises";
import { join } from "node:path";
import { pool, transaction } from "./db";
import { packTargetBytes } from "./pack";
import { compactObjects, store } from "./archive";
export async function maintenanceTick(stopped: () => boolean = () => false) {
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
        "SELECT * FROM archive_jobs WHERE kind IN ('compact','collect') AND state IN ('pending','running') ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!job) return;
    await pool.query("UPDATE archive_jobs SET state='running' WHERE id=$1", [
      job.id,
    ]);
    try {
      let objects = Number(job.result?.objects ?? 0),
        removed = 0,
        freed = 0;
      if (job.kind === "compact") {
        // Accumulate across query pages; page size must never become pack size.
        // Limit locator count as well as encoded bytes for tiny-object corpora.
        let cursor = job.result?.cursor ?? "",
          hashes: string[] = [],
          bytes = 8;
        const flush = async () => {
          if (!hashes.length) return;
          await compactObjects(hashes, { job: job.id, cursor, objects });
          hashes = [];
          bytes = 8;
        };
        while (true) {
          if (stopped()) return;
          const rows = (
            await pool.query(
              "SELECT encode(hash,'hex') AS hash,length FROM archive_object_data WHERE hash>decode($1,'hex') ORDER BY hash LIMIT 1024",
              [cursor],
            )
          ).rows;
          if (!rows.length) break;
          for (const r of rows) {
            if (
              hashes.length &&
              (bytes + Number(r.length) > packTargetBytes ||
                hashes.length >= 65536)
            )
              await flush();
            hashes.push(r.hash);
            bytes += Number(r.length);
            objects++;
            cursor = r.hash;
          }
        }
        await flush();
      }
      // Hold the locator lock only for a bounded deletion group, so active readers keep progressing.
      let candidates: string[] = [];
      async function collectGroup() {
        if (!candidates.length) return;
        await transaction(async (db) => {
          await db.query("SELECT pg_advisory_xact_lock(70210402)");
          await db.query(
            "DELETE FROM archive_pack_leases WHERE expires_at<now()",
          );
          const used = new Set(
            (
              await db.query(
                "SELECT DISTINCT pack FROM archive_objects WHERE pack=ANY($1::text[]) UNION SELECT pack FROM archive_pack_leases WHERE pack=ANY($1::text[])",
                [candidates],
              )
            ).rows.map((r) => r.pack),
          );
          for (const file of candidates) {
            if (used.has(file)) continue;
            const path = join(store.root, "packs", file);
            const s = await stat(path);
            await unlink(path);
            removed++;
            freed += s.size;
          }
        });
        candidates = [];
      }
      for await (const entry of await opendir(join(store.root, "packs"))) {
        if (stopped()) return;
        if (!entry.isFile() || !entry.name.endsWith(".pmpack")) continue;
        candidates.push(entry.name);
        if (candidates.length === 64) await collectGroup();
      }
      await collectGroup();
      for await (const entry of await opendir(join(store.root, "staging"))) {
        if (stopped()) return;
        if (
          !entry.name.endsWith(".pmpack") &&
          !entry.name.startsWith("adapter-") &&
          !/^reconcile-[a-f0-9-]+\.json$/.test(entry.name)
        )
          continue;
        const path = join(store.root, "staging", entry.name);
        const s = await stat(path);
        if (Date.now() - s.mtimeMs > 3600000)
          await rm(path, { recursive: entry.isDirectory(), force: true });
      }
      const disk = await statfs(store.root);
      await pool.query(
        "UPDATE archive_jobs SET state='completed',result=$2 WHERE id=$1",
        [
          job.id,
          {
            objects,
            removed,
            freed,
            available_bytes: disk.bavail * disk.bsize,
          },
        ],
      );
    } catch (e: any) {
      await pool.query(
        "UPDATE archive_jobs SET state='failed',result=$2 WHERE id=$1",
        [job.id, { code: e.code ?? "MAINTENANCE_FAILED", message: e.message }],
      );
    }
  } finally {
    if (ownsLeader) await leader.query("SELECT pg_advisory_unlock(70210403)");
    leader.release();
  }
}
