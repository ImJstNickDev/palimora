import { SourceBibliography } from "@palimora/contracts";
import { findObjects } from "./archive-catalog";
import { documentHashes } from "./archive-native";
import { prepareIngest } from "./archive-ingest";
import { prepareStaging, preparedBytes } from "./archive-staging";
import { readFile, realpath, open } from "node:fs/promises";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PackStore,
  canonical,
  sha,
  Locator,
  PackWriter,
  contentHash,
} from "./pack";
import { DB, transaction } from "./db";
export const store = new PackStore();
const readers = new WeakMap<
  DB,
  Map<string, Awaited<ReturnType<typeof open>>>
>();
const writers = new WeakMap<DB, PackWriter>();
const registrations = new WeakMap<DB, Map<string, Locator>>();
const completions = new WeakMap<DB, () => Promise<void>>();
export function afterArchiveSeal(db: DB, complete: () => Promise<void>) {
  completions.set(db, complete);
}
const knownObjects = new WeakMap<DB, Map<string, number>>();
type PendingObjects = {
  objects: Map<string, { kind: string; bytes: Buffer }>;
  bytes: number;
};
const pendingObjects = new WeakMap<DB, PendingObjects>();
const pendingEvents = new WeakMap<DB, { event: string; payload: any }[]>();
export async function archiveTransaction<T>(
  fn: (db: DB) => Promise<T>,
  keys?: string[],
) {
  return transaction(async (db) => {
    const writer = store.writer();
    writers.set(db, writer);
    registrations.set(db, new Map());
    readers.set(db, new Map());
    knownObjects.set(db, new Map());
    pendingObjects.set(db, { objects: new Map(), bytes: 0 });
    pendingEvents.set(db, []);
    try {
      await db.query(
        keys
          ? "SELECT pg_advisory_xact_lock_shared(70210402)"
          : "SELECT pg_advisory_xact_lock(70210402)",
      );
      if (keys?.length)
        await db.query(
          "SELECT pg_advisory_xact_lock(k) FROM (SELECT DISTINCT hashtextextended(value,70210404) AS k FROM unnest($1::text[]) value ORDER BY k) locks",
          [keys],
        );
      const result = await fn(db);
      await flushObjects(db);
      const events = pendingEvents.get(db)!;
      if (events.length)
        await db.query(
          "INSERT INTO archive_outbox(event,payload) SELECT event,payload FROM jsonb_to_recordset($1::jsonb) AS e(event text,payload jsonb)",
          [JSON.stringify(events)],
        );
      await writer.finish();
      await registerObjects(db);
      await completions.get(db)?.();
      return result;
    } catch (error) {
      await writer.abort();
      throw error;
    } finally {
      for (const file of readers.get(db)?.values() ?? []) await file.close();
      readers.delete(db);
      writers.delete(db);
      registrations.delete(db);
      completions.delete(db);
      knownObjects.delete(db);
      pendingObjects.delete(db);
      pendingEvents.delete(db);
    }
  });
}
export async function preserve(
  db: DB,
  objects: { kind: string; bytes: Buffer }[],
) {
  const pending = pendingObjects.get(db);
  if (!pending) return writeObjects(db, objects);
  const known = knownObjects.get(db)!;
  for (const object of objects) {
    const hash = contentHash(object.bytes);
    const size = known.get(hash) ?? pending.objects.get(hash)?.bytes.length;
    if (size !== undefined) {
      if (size !== object.bytes.length) throw Error("HASH_COLLISION");
      continue;
    }
    if (pending.bytes && pending.bytes + object.bytes.length > 16 * 1024 * 1024)
      await flushObjects(db);
    pending.objects.set(hash, object);
    pending.bytes += object.bytes.length;
    if (pending.bytes >= 16 * 1024 * 1024) await flushObjects(db);
  }
}
async function flushObjects(db: DB) {
  const pending = pendingObjects.get(db);
  if (!pending?.objects.size) return;
  await writeObjects(db, [...pending.objects.values()]);
  pending.objects.clear();
  pending.bytes = 0;
}
async function writeObjects(
  db: DB,
  objects: { kind: string; bytes: Buffer }[],
) {
  if (!writers.has(db))
    await db.query("SELECT pg_advisory_xact_lock(70210402)");
  const unique = new Map(
    objects
      .map((o) => [contentHash(o.bytes), o] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const missing = [];
  const existing = knownObjects.get(db) ?? new Map<string, number>();
  const unknown = [...unique.keys()].filter((hash) => !existing.has(hash));
  if (unknown.length)
    for (const r of (
      await db.query(
        "SELECT encode(hash,'hex') AS hash,size FROM archive_object_data WHERE hash=ANY($1::bytea[])",
        [unknown.map((h) => Buffer.from(h, "hex"))],
      )
    ).rows)
      existing.set(r.hash, Number(r.size));
  for (const [hash, o] of unique) {
    if (existing.has(hash) && existing.get(hash) !== o.bytes.length)
      throw Error("HASH_COLLISION");
    if (!existing.has(hash)) missing.push(o);
  }
  if (missing.length) {
    const writer = writers.get(db);
    const records = await (writer
      ? writer.append(missing)
      : store.write(missing));
    if (writer) {
      for (const r of records) registrations.get(db)!.set(r.hash, r);
    } else await insertObjects(db, records);
    for (const r of records) existing.set(r.hash, r.size);
  }
}
async function registerObjects(db: DB) {
  const pending = registrations.get(db);
  if (!pending?.size) return;
  await insertObjects(
    db,
    [...pending.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
  );
  pending.clear();
}
async function insertObjects(db: DB, records: Locator[]) {
  await db.query(
    "INSERT INTO archive_packs(name) SELECT DISTINCT x FROM unnest($1::text[]) x ORDER BY x ON CONFLICT DO NOTHING",
    [records.map((r) => r.pack)],
  );
  await db.query(
    "INSERT INTO archive_kinds(name) SELECT DISTINCT x FROM unnest($1::text[]) x ORDER BY x ON CONFLICT DO NOTHING",
    [records.map((r) => r.kind)],
  );
  const inserted = await db.query(
    "INSERT INTO archive_object_data(hash,pack_id,byte_offset,length,size,kind_id) SELECT r.hash,p.id,r.byte_offset,r.length,r.size,k.id FROM unnest($1::bytea[],$2::text[],$3::bigint[],$4::bigint[],$5::bigint[],$6::text[]) r(hash,pack,byte_offset,length,size,kind) JOIN archive_packs p ON p.name=r.pack JOIN archive_kinds k ON k.name=r.kind ORDER BY r.hash ON CONFLICT DO NOTHING RETURNING encode(hash,'hex') AS hash",
    [
      records.map((r) => Buffer.from(r.hash, "hex")),
      records.map((r) => r.pack),
      records.map((r) => r.offset),
      records.map((r) => r.length),
      records.map((r) => r.size),
      records.map((r) => r.kind),
    ],
  );
  if (inserted.rowCount !== records.length) {
    const won = new Set(inserted.rows.map((r) => r.hash));
    const raced = records.filter((r) => !won.has(r.hash));
    const sizes = new Map(
      (
        await findObjects(
          db,
          raced.map((r) => r.hash),
        )
      ).map((r) => [r.hash, Number(r.size)]),
    );
    if (raced.some((r) => sizes.get(r.hash) !== r.size))
      throw Error("HASH_COLLISION");
  }
}
export function normalizeMetadata(raw: Record<string, unknown>) {
  if (raw.ao3 !== undefined) SourceBibliography.parse(raw.ao3);
  const names: Record<string, string> = {
    Title: "title",
    Author: "creators",
    creator: "creators",
    Language: "language",
    Summary: "summary",
    description: "summary",
    Category: "fandom",
    Genre: "source_genre",
    subject: "source_subjects",
    Story_URL: "source_url",
    StoryURL: "source_url",
    "Story URL": "source_url",
    source: "source_url",
    Author_URL: "author_urls",
    AuthorURL: "author_urls",
    "Author URL": "author_urls",
    Rating: "rating",
    Warnings: "warnings",
    Relationships: "relationships",
    Published: "published",
    Updated: "updated",
    Packaged: "packaged",
    Chapters: "chapter_count",
    Words: "words",
    Kudos: "kudos",
    Comments: "comments",
    Status: "status",
    Series: "series",
    Collections: "collections",
  };
  const normalized: Record<string, unknown> = {};
  const normalize = (value: unknown): unknown =>
    typeof value === "string"
      ? value.normalize("NFC").replace(/\r\n?/g, "\n").trim()
      : Array.isArray(value)
        ? value.map(normalize)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, normalize(v)]),
            )
          : value;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "Path" || value === null || value === "") continue;
    const name = names[key] ?? key;
    let v: any = normalize(value);
    if (
      ["words", "kudos", "comments", "chapter_count"].includes(name) &&
      typeof v === "string" &&
      /^[0-9,]+$/.test(v)
    )
      v = Number(v.replace(/,/g, ""));
    if (
      ["title", "creators", "language", "source_url", "author_urls"].includes(
        name,
      ) &&
      !Array.isArray(v)
    )
      v = [v];
    normalized[name] = v;
  }
  return normalized;
}
export async function objectBytes(o: any, db?: DB) {
  const prepared = preparedBytes(o);
  if (prepared) return prepared;
  if (!o.path) return Buffer.from(o.data, "base64");
  let b: Buffer;
  if (o.offset !== undefined) {
    if (
      !Number.isSafeInteger(o.offset) ||
      o.offset < 0 ||
      !Number.isSafeInteger(o.size) ||
      o.size < 0
    )
      throw Error("ADAPTER_RANGE");
    const handles = db ? readers.get(db) : undefined;
    let f = handles?.get(o.path);
    if (!f) {
      const root = await realpath(join(store.root, "staging")),
        file = await realpath(o.path);
      if (!file.startsWith(root + sep)) throw Error("ADAPTER_PATH");
      if (handles && handles.size >= 64) {
        const first = handles.keys().next().value!;
        await handles.get(first)!.close();
        handles.delete(first);
      }
      f = await open(file, "r");
      handles?.set(o.path, f);
    }
    try {
      b = Buffer.alloc(o.size);
      let n = 0;
      while (n < b.length) {
        const r = await f.read(b, n, b.length - n, o.offset + n);
        if (!r.bytesRead) throw Error("ADAPTER_RANGE");
        n += r.bytesRead;
      }
    } finally {
      if (!handles) await f.close();
    }
  } else {
    const root = await realpath(join(store.root, "staging")),
      file = await realpath(o.path);
    if (!file.startsWith(root + sep)) throw Error("ADAPTER_PATH");
    b = await readFile(file);
  }
  if (contentHash(b) !== o.hash || b.length !== o.size)
    throw Error("ADAPTER_HASH");
  return b;
}
export async function ingestRecord(source: any, envelope: any) {
  return ingestRecords(source, [envelope]);
}
export async function ingestRecords(source: any, envelopes: any[]) {
  if (!envelopes.length) return;
  await prepareStaging(store.root, envelopes);
  const hashes = await documentHashes(
    envelopes.map((e) => ({
      ...e.record,
      objects: e.record.objects.map((o: any) => ({
        name: o.name,
        kind: o.kind,
        hash: o.hash ?? sha(Buffer.from(o.data, "base64")),
      })),
    })),
  );
  envelopes = envelopes.map((e, i) => ({
    ...e,
    normalized: normalizeMetadata(e.record.metadata),
    result_hash: hashes[i],
  }));

  const keys = envelopes.flatMap((e) => [
    "provisional:" + source.path + ":" + (e.record.source_entry || e.locator),
    ...(e.record.external_id ? ["external:" + e.record.external_id] : []),
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      await archiveTransaction(
        (db) => prepareIngest(db, source, envelopes, pendingEvents.get(db)!),
        keys,
      );
      return;
    } catch (error: any) {
      if (attempt >= 3 || !["40P01", "40001"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export async function readObject(db: DB, hash: string) {
  await flushObjects(db);
  await writers.get(db)?.finish();
  await registerObjects(db);
  await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
  const r = (await findObjects(db, [hash]))[0];
  if (!r) throw Error("OBJECT_MISSING");
  return store.read({
    ...r,
    offset: Number(r.byte_offset),
    length: Number(r.length),
    size: Number(r.size),
  } as Locator);
}
// Copy-on-write compaction retains old packs so active readers and future backup leases remain safe.
export async function compactObjects(
  hashes: string[],
  checkpoint?: { job: string; cursor: string; objects: number },
) {
  await transaction(async (db) => {
    // One upgrader at a time, including direct callers outside the job leader.
    await db.query("SELECT pg_advisory_xact_lock(70210407)");
    await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
    const rows = (await findObjects(db, hashes)).sort(
      (a, b) =>
        a.pack.localeCompare(b.pack) ||
        Number(a.byte_offset) - Number(b.byte_offset),
    );
    const writer = store.writer(),
      records: Locator[] = [];
    try {
      for (let start = 0; start < rows.length; ) {
        let end = start,
          raw = 0;
        while (
          end < rows.length &&
          end - start < 256 &&
          (end === start || raw + Number(rows[end].size) <= 16 * 1024 * 1024)
        )
          raw += Number(rows[end++].size);
        const part = rows.slice(start, end);
        const bytes = await store.readMany(
          part.map((r) => ({
            ...r,
            offset: Number(r.byte_offset),
            length: Number(r.length),
            size: Number(r.size),
          })),
        );
        records.push(
          ...(await writer.append(
            part.map((r, i) => ({ kind: r.kind, bytes: bytes[i] })),
          )),
        );
        start = end;
      }
      await writer.finish();
      // Shared protection keeps source/new files safe from GC while allowing
      // reads and ingest. Only atomic locator publication requires exclusivity.
      await db.query("SELECT pg_advisory_xact_lock(70210402)");
      if (records.length) {
        await db.query(
          "INSERT INTO archive_packs(name) SELECT DISTINCT name FROM unnest($1::text[]) name ORDER BY name ON CONFLICT DO NOTHING",
          [records.map((r) => r.pack)],
        );
        await db.query(
          `UPDATE archive_object_data o SET pack_id=p.id,byte_offset=r.byte_offset,length=r.length
          FROM unnest($1::bytea[],$2::text[],$3::bigint[],$4::bigint[]) r(hash,pack,byte_offset,length)
          JOIN archive_packs p ON p.name=r.pack WHERE o.hash=r.hash`,
          [
            records.map((r) => Buffer.from(r.hash, "hex")),
            records.map((r) => r.pack),
            records.map((r) => r.offset),
            records.map((r) => r.length),
          ],
        );
        await db.query(
          "INSERT INTO archive_outbox(event,payload) VALUES($1,$2)",
          [
            "archive.compacted",
            {
              objects: records.map((r) => r.hash),
              retained_packs: [...new Set(rows.map((r) => r.pack))],
            },
          ],
        );
      }
      // Locator publication and progress are one commit: a restart cannot
      // rewrite an already completed group because its checkpoint was lost.
      if (checkpoint)
        await db.query("UPDATE archive_jobs SET result=$2 WHERE id=$1", [
          checkpoint.job,
          { cursor: checkpoint.cursor, objects: checkpoint.objects },
        ]);
    } catch (error) {
      await writer.abort();
      throw error;
    }
  });
}
