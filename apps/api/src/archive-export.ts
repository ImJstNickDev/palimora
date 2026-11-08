import { mkdir, rm, readFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db";
import { PackStore, canonical, sha } from "./pack";
import { hydrateWorks, objectProjection, objectFrom } from "./archive-catalog";
import { openBackupTarget } from "./backup-target";
import { destination } from "./backup-config";
import { openChain, writeArchive, verify } from "@palimora/archive-format";
export const corpusTables = [
  "archive_paths",
  "archive_entries",
  "archive_origins",
  "archive_parsers",
  "archive_fields",
  "archive_reasons",
  "archive_dictionaries",
  "archive_payloads",
  "archive_work_heads",
  "archive_metadata_data",
  "archive_chapters",
  "archive_revision_data",
  "archive_snapshot_data",
  "archive_snapshot_chapters",
  "archive_observation_data",
  "archive_evidence_data",
  "archive_selection_data",
  "archive_record_data",
  "archive_identity_links",
  "archive_media_references",
  "archive_tags",
  "archive_tag_observations",
  "ao3_media",
  "ao3_media_revisions",
];
export async function exportCorpus(o: {
  id: string;
  destination: string;
  basePaths: string[];
  stopped: () => boolean;
  progress: (p: object) => Promise<void>;
}) {
  const target = await openBackupTarget(await destination(o.destination)),
    db = await pool.connect(),
    root = join(target.path, o.id),
    capture = join(root, "capture");
  const check = async (requiredBytes = 8 * 1024 * 1024) => {
    if (o.stopped()) throw Error("BACKUP_INTERRUPTED");
    await target.check(requiredBytes);
  };
  let locked = false;
  const store = new PackStore();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const base = o.basePaths.length ? await openChain(o.basePaths) : undefined;
    if (base) await verify(base);
    let plan: any;
    try {
      plan = JSON.parse(
        await readFile(join(root, "export-capture.json"), "utf8"),
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!plan) {
      await rm(capture, { recursive: true, force: true });
      await mkdir(capture, { mode: 0o700 });
      await db.query(
        "SELECT pg_advisory_lock_shared(70210401),pg_advisory_lock_shared(70210402)",
      );
      locked = true;
      await db.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=0",
      );
      plan = {
        schema: "palimora-corpus-catalog-v1",
        tables: {},
        works: [],
        objects: [],
        migrations: (
          await db.query(
            "SELECT name,hash FROM schema_migrations ORDER BY name",
          )
        ).rows,
      };
      const save = async (kind: string, bytes: Buffer) => {
        if (o.stopped()) throw Error("BACKUP_INTERRUPTED");
        const hash = sha(bytes);
        if (!base?.objects.has(hash)) {
          // Validate the mounted destination immediately before each write.
          // Rows accumulated in memory and objects already in the base do not
          // write there; probing the filesystem per skipped object is needless.
          await check(Math.max(8 * 1024 * 1024, bytes.length));
          const f = await open(join(capture, hash), "w", 0o600);
          try {
            await f.writeFile(bytes);
            await f.sync();
          } finally {
            await f.close();
          }
        }
        plan.objects.push({ hash, kind, size: bytes.length });
        return hash;
      };
      for (const table of corpusTables) {
        await check();
        await o.progress({ phase: "catalog", table });
        const segments: string[] = [];
        let rows: string[] = [],
          size = 0;
        await db.query(
          `DECLARE export_rows CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
        );
        try {
          while (true) {
            const batch = (await db.query("FETCH 128 FROM export_rows")).rows;
            if (!batch.length) break;
            for (const { row } of batch) {
              if (o.stopped()) throw Error("BACKUP_INTERRUPTED");
              if (size && size + Buffer.byteLength(row) > 4 * 1024 * 1024) {
                segments.push(
                  await save(
                    "catalog_table",
                    Buffer.from(rows.join("\n") + "\n"),
                  ),
                );
                rows = [];
                size = 0;
              }
              rows.push(row);
              size += Buffer.byteLength(row) + 1;
            }
          }
        } finally {
          await db.query("CLOSE export_rows");
        }
        if (rows.length)
          segments.push(
            await save("catalog_table", Buffer.from(rows.join("\n") + "\n")),
          );
        plan.tables[table] = segments;
      }
      // A lightweight work index lets standalone readers list titles without SQL codecs.
      await db.query(
        "DECLARE export_works CURSOR FOR SELECT * FROM archive_works ORDER BY id",
      );
      try {
        while (true) {
          const rows = (await db.query("FETCH 128 FROM export_works")).rows;
          if (!rows.length) break;
          const works = await hydrateWorks(db, rows);
          plan.works.push(await save("work_index", canonical(works)));
        }
      } finally {
        await db.query("CLOSE export_works");
      }
      await db.query(
        `DECLARE export_objects CURSOR FOR SELECT ${objectProjection} FROM ${objectFrom} WHERE k.name<>'admin_decision' ORDER BY o.hash`,
      );
      try {
        while (true) {
          const rows = (await db.query("FETCH 128 FROM export_objects")).rows;
          if (!rows.length) break;
          for (const r of rows) {
            if (o.stopped()) throw Error("BACKUP_INTERRUPTED");
            if (base?.objects.has(r.hash)) {
              plan.objects.push({
                hash: r.hash,
                kind: r.kind,
                size: Number(r.size),
              });
              continue;
            }
            await save(
              r.kind,
              await store.read({
                ...r,
                offset: Number(r.byte_offset),
                length: Number(r.length),
                size: Number(r.size),
              }),
            );
          }
          await o.progress({ phase: "capture", objects: plan.objects.length });
        }
      } finally {
        await db.query("CLOSE export_objects");
      }
      await check();
      const d = await open(capture, "r");
      await d.sync();
      await d.close();
      const f = await open(join(root, "export-capture.partial"), "w", 0o600);
      try {
        await f.writeFile(JSON.stringify(plan));
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(
        join(root, "export-capture.partial"),
        join(root, "export-capture.json"),
      );
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await db.query("COMMIT");
      await db.query(
        "SELECT pg_advisory_unlock_shared(70210402),pg_advisory_unlock_shared(70210401)",
      );
      locked = false;
    }
    const output = join(root, "archive");
    try {
      const existing = await openChain([...o.basePaths, output]);
      await verify(existing);
      return { hash: existing.hash };
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await rm(output, { recursive: true, force: true });
    const objects = plan.objects;
    delete plan.objects;
    async function* input() {
      let count = 0;
      for (const r of objects) {
        if (o.stopped()) throw Error("BACKUP_INTERRUPTED");
        if (base?.objects.has(r.hash)) continue;
        await check();
        const bytes = await readFile(join(capture, r.hash));
        yield { ...r, bytes };
        if (++count % 128 === 0)
          await o.progress({ phase: "volumes", objects: count });
      }
    }
    const result = await writeArchive({
      root: output,
      origin: base?.manifest.origin ?? "palimora-corpus-v1",
      catalog: plan,
      objects: input(),
      base,
      check,
      stopped: o.stopped,
      volumeBytes: Number(process.env.BACKUP_VOLUME_BYTES ?? 2147483648),
    });
    await verify(await openChain([...o.basePaths, output]));
    await rm(capture, { recursive: true, force: true });
    return { hash: result.hash };
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    if (locked)
      await db.query(
        "SELECT pg_advisory_unlock_shared(70210402),pg_advisory_unlock_shared(70210401)",
      );
    db.release();
    await target.close();
  }
}
