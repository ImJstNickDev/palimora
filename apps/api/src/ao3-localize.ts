import { randomUUID } from "node:crypto";
import { pool, transaction } from "./db";
import { ingestRecords, readObject } from "./archive";
import { canonical, sha } from "./pack";
import { SyncError } from "./ao3-client";
/** Publish updated URL bindings using the current canonical components, without AO3 I/O. */
export async function localizeMedia(url: string) {
  let cursor: string | null = null;
  for (;;) {
    const works: any[] = (
      await pool.query(
        `SELECT h.id,h.external_id,h.current_snapshot_id FROM archive_media_references r
      JOIN archive_work_heads h ON h.id=r.work_id WHERE r.url=$1 AND h.current_snapshot_id IS NOT NULL AND h.external_id IS NOT NULL
      AND ($2::uuid IS NULL OR h.id>$2) ORDER BY h.id LIMIT 32`,
        [url, cursor],
      )
    ).rows;
    if (!works.length) return;
    for (const work of works) {
      let published = false;
      for (let attempt = 0; attempt < 3 && !published; attempt++) {
        const current = await transaction(async (db) => {
          const row = (
            await db.query(
              `SELECT h.current_snapshot_id,encode(s.manifest_hash,'hex') AS hash FROM archive_work_heads h
            JOIN archive_snapshot_data s ON s.id=h.current_snapshot_id WHERE h.id=$1`,
              [work.id],
            )
          ).rows[0];
          if (!row) return null;
          return {
            id: row.current_snapshot_id,
            manifest: JSON.parse((await readObject(db, row.hash)).toString()),
          };
        });
        if (!current) break;
        const m = current.manifest,
          refs = (
            await pool.query(
              `SELECT r.url,m.object_hash,m.object_kind FROM archive_media_references r
          JOIN ao3_media m ON m.url=r.url WHERE r.work_id=$1 AND m.object_hash IS NOT NULL`,
              [work.id],
            )
          ).rows;
        const objects = m.objects.map((o: any) => ({ ...o, cached: true }));
        const mapping = new Map(
          (m.metadata.ao3?.media ?? []).map((r: any) => [r.url, r.object]),
        );
        let changed = false;
        for (const r of refs) {
          const old = mapping.get(r.url),
            i = objects.findIndex(
              (o: any) => o.name === old || o.name === r.url,
            );
          if (i >= 0 && objects[i].hash === r.object_hash) continue;
          const object = {
            name: r.url,
            kind: r.object_kind,
            hash: r.object_hash,
            cached: true,
          };
          if (i >= 0) objects[i] = object;
          else objects.push(object);
          mapping.set(r.url, r.url);
          changed = true;
        }
        if (!changed) {
          published = true;
          break;
        }
        const metadata = {
          ...m.metadata,
          ao3: {
            schema: "palimora-ao3-v1",
            ...m.metadata.ao3,
            media: [...mapping].map(([url, object]) => ({ url, object })),
          },
        };
        const record = {
          external_id: work.external_id,
          metadata,
          chapters: m.chapters,
          objects,
          state: "valid",
          document: m.document,
          observed_at: new Date().toISOString(),
          media_urls: refs.map((r: any) => r.url),
        };
        const batch = randomUUID(),
          source = {
            id: randomUUID(),
            batch_id: batch,
            path: "palimora://media/" + work.id,
            fingerprint: sha(canonical(record)),
          };
        await transaction(async (db) => {
          await db.query(
            "INSERT INTO ingest_batches(id,state,source_kind) VALUES($1,'running','ao3')",
            [batch],
          );
          await db.query(
            "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
            [source.id, batch, source.path, source.fingerprint],
          );
        });
        try {
          await ingestRecords(
            source,
            [
              {
                schema: "palimora.ingest.v1",
                parser: "ao3-media-1",
                cursor: 1,
                locator: work.id,
                record,
              },
            ],
            {
              authoritative: true,
              before: async (db) => {
                const head = (
                  await db.query(
                    "SELECT current_snapshot_id FROM archive_work_heads WHERE id=$1 FOR UPDATE",
                    [work.id],
                  )
                ).rows[0];
                if (head.current_snapshot_id !== current.id)
                  throw new SyncError("MEDIA_HEAD_CHANGED", 1000);
              },
              finalize: async (db) => {
                await db.query(
                  "UPDATE ingest_batches SET state='completed' WHERE id=$1",
                  [batch],
                );
                await db.query(
                  "UPDATE ingest_sources SET state='ingested' WHERE id=$1",
                  [source.id],
                );
              },
            },
          );
          published = true;
        } catch (e) {
          await pool.query(
            "UPDATE ingest_batches SET state='failed_global',error=$2 WHERE id=$1",
            [batch, { code: "MEDIA_COMMIT_FAILED" }],
          );
          if (!(e instanceof SyncError) || e.code !== "MEDIA_HEAD_CHANGED")
            throw e;
        }
      }
      if (!published) throw new SyncError("MEDIA_HEAD_CHANGED", 60000);
    }
    cursor = works.at(-1).id;
  }
}
