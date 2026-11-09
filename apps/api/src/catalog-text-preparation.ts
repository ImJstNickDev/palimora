import { createHash } from "node:crypto";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { DB } from "./db";
import { readObjectBatches } from "./archive";
import { findObjects } from "./archive-catalog";
import { plain, values } from "./catalog-bibliography";

const budget = 16 * 1024 * 1024;
const maximumText = 64 * 1024 * 1024;
type Input = {
  manifest: any;
  text: string[];
  notes: string[];
  epoch: string;
  ext: any;
  alias: boolean;
  canonicalTags: any[];
  sourceTags: any[];
  crossover: boolean;
  otpCount: number;
};
type Task = {
  work: string;
  hashes: string[];
  chapter?: any;
  note?: any;
  ordinal: number;
};

/** Same offset and source checksum contract used by the reader. */
export function reconstructTextChapter(
  m: any,
  c: any,
  objects: Map<string, Buffer>,
) {
  let bytes = objects.get(c.hash);
  if (!bytes) throw Error("OBJECT_MISSING");
  for (const note of [...(c.notes ?? [])].sort((a, b) => a.offset - b.offset)) {
    const ref = m.objects.find((o: any) => o.name === note.name);
    if (!ref) throw Error("NOTE_MISSING");
    const fragment = objects.get(ref.hash);
    if (!fragment) throw Error("OBJECT_MISSING");
    bytes = Buffer.concat([
      bytes.subarray(0, note.offset),
      fragment,
      bytes.subarray(note.offset),
    ]);
  }
  if (
    c.source_html_sha256 &&
    createHash("sha256").update(bytes).digest("hex") !== c.source_html_sha256
  )
    throw Error("CHAPTER_RECONSTRUCTION");
  return bytes;
}

/** Retry exceptional failing subsets only. Healthy objects are never discarded
 * because another frame is missing/corrupt. No SQL lookup per chapter on success. */
async function objects(
  db: DB,
  hashes: string[],
): Promise<Map<string, Buffer | Error>> {
  const result = new Map<string, Buffer | Error>();
  const unique = [...new Set(hashes)];
  async function read(part: string[]): Promise<void> {
    try {
      for await (const item of readObjectBatches(db, part))
        result.set(item.hash, item.bytes);
    } catch (e) {
      const remaining = part.filter((h) => !result.has(h));
      if (remaining.length === 1)
        result.set(
          remaining[0],
          e instanceof Error ? e : Error("OBJECT_READ_FAILED"),
        );
      else if (remaining.length) {
        const mid = Math.ceil(remaining.length / 2);
        await read(remaining.slice(0, mid));
        await read(remaining.slice(mid));
      }
    }
  }
  await read(unique);
  return result;
}

/** Acquire a group already bounded by selectTextGroup, or one compatibility
 * caller. Text reads use a separate decoded-byte window within that group. */
export async function loadTextInputs(
  db: DB,
  rows: any[],
  manifests?: Map<string, any>,
) {
  const result = new Map<string, Input | Error>();
  if (!rows.length) return result;
  const ids = rows.map((r) => r.work_id);
  const epoch = (
    await db.query("SELECT epoch FROM catalog_search_state WHERE id=1")
  ).rows[0].epoch;
  const heads = (
    await db.query(
      `SELECT h.id,h.external_id,dates.archived_at,
    EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=h.id) alias
    FROM archive_work_heads h LEFT JOIN (
      SELECT work_id,min(imported_at) archived_at FROM archive_snapshots WHERE work_id=ANY($1::uuid[]) GROUP BY work_id
    ) dates ON dates.work_id=h.id WHERE h.id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  if (!manifests) manifests = await loadManifests(db, rows);
  for (const r of rows) {
    const ext = heads.find((h) => h.id === r.work_id),
      m = manifests.get(r.work_id);
    if (!ext || m instanceof Error) {
      result.set(r.work_id, m instanceof Error ? m : Error("WORK_MISSING"));
      continue;
    }
    result.set(r.work_id, {
      manifest: m,
      text: [],
      notes: [],
      epoch,
      ext,
      alias: ext.alias,
      canonicalTags: [],
      sourceTags: [],
      crossover: true,
      otpCount: 0,
    });
  }
  const tags = JSON.stringify(
    rows.map((r) => ({
      work_id: r.work_id,
      ids: r.bibliography.filterTags ?? [],
    })),
  );
  // Keep the original per-work tag scan order (arrays are part of _source),
  // while acquiring every work's tags in one round trip.
  for (const [field, sql] of [
    [
      "canonicalTags",
      "SELECT * FROM catalog_tags WHERE id=ANY(w.ids) AND NOT EXISTS(SELECT 1 FROM catalog_tag_edges e WHERE e.child=catalog_tags.id AND e.kind='synonym') OFFSET 0",
    ],
    [
      "sourceTags",
      "SELECT kind,source_id FROM catalog_tags WHERE id=ANY(w.ids) AND source_id IS NOT NULL OFFSET 0",
    ],
  ]) {
    const found = (
      await db.query(
        `SELECT w.work_id,t.* FROM jsonb_to_recordset($1::jsonb) w(work_id uuid,ids text[]) CROSS JOIN LATERAL (${sql}) t`,
        [tags],
      )
    ).rows;
    for (const t of found) {
      const input = result.get(t.work_id);
      if (input && !(input instanceof Error)) (input as any)[field].push(t);
    }
  }
  const special = (kind: string, field: string) =>
    rows
      .filter(
        (r) =>
          values(r.metadata[kind]).length > 1 &&
          r.metadata[field] === undefined &&
          (r.bibliography.tags ?? [])
            .filter((t: any) => t.kind === kind)
            .every((t: any) => t.source_id),
      )
      .map((r) => r.work_id);
  const fandom = special("fandom", "crossover"),
    relationships = special("relationships", "otp");
  if (fandom.length)
    for (const r of (
      await db.query(
        `WITH RECURSIVE reach(work_id,root,id) AS (
    SELECT w.work_id,t.id,t.id FROM catalog_work_tags w JOIN catalog_tags t ON t.id=w.tag_id WHERE w.work_id=ANY($1::uuid[]) AND t.kind='fandom'
    UNION SELECT r.work_id,r.root,e.parent FROM reach r JOIN catalog_tag_edges e ON e.child=r.id WHERE e.kind IN('synonym','meta')),
    roots AS (SELECT DISTINCT work_id,root FROM reach),
    root_overlaps AS (SELECT DISTINCT a.work_id,a.root,b.root other FROM reach a JOIN reach b ON a.work_id=b.work_id AND a.id=b.id),
    covering AS (SELECT work_id,root FROM root_overlaps GROUP BY work_id,root
      HAVING count(*)=(SELECT count(*) FROM roots r WHERE r.work_id=root_overlaps.work_id))
    SELECT DISTINCT work_id FROM covering`,
        [fandom],
      )
    ).rows) {
      const input = result.get(r.work_id);
      if (input && !(input instanceof Error)) input.crossover = false;
    }
  if (relationships.length)
    for (const r of (
      await db.query(
        `WITH RECURSIVE tags(work_id,id) AS (
    SELECT w.work_id,t.id FROM catalog_work_tags w JOIN catalog_tags t ON t.id=w.tag_id WHERE w.work_id=ANY($1::uuid[]) AND t.kind='relationships'
    UNION SELECT t.work_id,e.parent FROM catalog_tag_edges e JOIN tags t ON t.id=e.child WHERE e.kind='synonym')
    SELECT work_id,count(*)::int n FROM tags WHERE NOT EXISTS(SELECT 1 FROM catalog_tag_edges e WHERE e.child=tags.id AND e.kind='synonym') GROUP BY work_id`,
        [relationships],
      )
    ).rows) {
      const input = result.get(r.work_id);
      if (input && !(input instanceof Error)) input.otpCount = r.n;
    }
  const tasks: Task[] = [];
  for (const [work, input] of result)
    if (!(input instanceof Error) && input.manifest) {
      const m = input.manifest;
      try {
        m.chapters.forEach((chapter: any, ordinal: number) =>
          tasks.push({
            work,
            chapter,
            ordinal,
            hashes: [
              chapter.hash,
              ...(chapter.notes ?? []).map((n: any) => {
                const ref = m.objects.find((o: any) => o.name === n.name);
                if (!ref) throw Error("NOTE_MISSING");
                return ref.hash;
              }),
            ],
          }),
        );
        const chapterNotes = new Set(
          m.chapters.flatMap((c: any) =>
            (c.notes ?? []).map((n: any) => n.name),
          ),
        );
        m.objects
          .filter(
            (o: any) => o.kind === "notes_html" && !chapterNotes.has(o.name),
          )
          .forEach((note: any, ordinal: number) =>
            tasks.push({ work, note, ordinal, hashes: [note.hash] }),
          );
      } catch (e) {
        result.set(work, e as Error);
      }
    }
  const locators = await findObjects(db, [
    ...new Set(tasks.flatMap((t) => t.hashes)),
  ]);
  const sizes = new Map(locators.map((r) => [r.hash, Number(r.size)]));
  const retained = new Map<string, number>();
  for (let start = 0; start < tasks.length; ) {
    let end = start,
      total = 0;
    const hashes = new Set<string>();
    while (end < tasks.length) {
      if (result.get(tasks[end].work) instanceof Error) {
        end++;
        continue;
      }
      const added = tasks[end].hashes.filter((h) => !hashes.has(h));
      const size = added.reduce((n, h) => n + (sizes.get(h) ?? 0), 0);
      if (end > start && total + size > budget) break;
      added.forEach((h) => hashes.add(h));
      total += size;
      end++;
    }
    const loaded = await objects(db, [...hashes]);
    let cpuDeadline = performance.now() + 8;
    for (const task of tasks.slice(start, end)) {
      const input = result.get(task.work);
      if (!input || input instanceof Error) continue;
      try {
        for (const hash of task.hashes) {
          const bytes = loaded.get(hash);
          if (bytes instanceof Error) throw bytes;
          if (!bytes) throw Error("OBJECT_MISSING");
        }
        const bytes = task.chapter
          ? reconstructTextChapter(
              input.manifest,
              task.chapter,
              loaded as Map<string, Buffer>,
            )
          : (loaded.get(task.note.hash) as Buffer);
        const text = plain(bytes.toString());
        const size = (retained.get(task.work) ?? 0) + Buffer.byteLength(text);
        if (size > maximumText) throw Error("DOCUMENT_EXCEEDS_64_MIB");
        retained.set(task.work, size);
        (task.chapter ? input.text : input.notes)[task.ordinal] = text;
      } catch (e) {
        result.set(
          task.work,
          e instanceof Error ? e : Error("TEXT_PREPARATION_FAILED"),
        );
      }
      // A decoded window can contain many synchronous HTML extractions. Let
      // API sockets and lease timers run between tasks, keeping this snapshot.
      if (performance.now() >= cpuDeadline) {
        await yieldToIo();
        cpuDeadline = performance.now() + 8;
      }
    }
    start = end;
  }
  return result;
}

async function snapshotReferences(db: DB, rows: any[]) {
  return (
    await db.query(
      `SELECT i.work_id,s.manifest_hash FROM jsonb_to_recordset($1::jsonb) i(work_id uuid,snapshot_id uuid)
    JOIN archive_snapshots s ON s.id=i.snapshot_id AND (s.work_id=i.work_id OR EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=s.work_id AND l.canonical_work_id=i.work_id))`,
      [
        JSON.stringify(
          rows.map((r) => ({ work_id: r.work_id, snapshot_id: r.snapshot_id })),
        ),
      ],
    )
  ).rows;
}
async function loadManifests(db: DB, rows: any[], refs?: any[]) {
  const snapshots = refs ?? (await snapshotReferences(db, rows));
  const loaded = await objects(
    db,
    snapshots.map((r) => r.manifest_hash),
  );
  const parsed = new Map<string, any>();
  for (const [hash, bytes] of loaded) {
    try {
      const manifest =
        bytes instanceof Error ? bytes : JSON.parse(bytes.toString());
      if (
        !(manifest instanceof Error) &&
        (!Array.isArray(manifest?.chapters) ||
          !Array.isArray(manifest?.objects) ||
          manifest.chapters.some(
            (c: any) =>
              !c ||
              typeof c.hash !== "string" ||
              (c.notes !== undefined && !Array.isArray(c.notes)),
          ) ||
          manifest.objects.some((o: any) => !o || typeof o.hash !== "string"))
      )
        throw Error("MANIFEST_INVALID");
      parsed.set(hash, manifest);
    } catch (e) {
      parsed.set(hash, e);
    }
  }
  return new Map(
    rows.map((r) => [
      r.work_id,
      !r.snapshot_id
        ? null
        : (parsed.get(
            snapshots.find((s) => s.work_id === r.work_id)?.manifest_hash,
          ) ?? Error("SNAPSHOT_MISSING")),
    ]),
  );
}

/** Select a byte-bounded prefix before retaining reconstructed texts. Large
 * individual works remain singleton groups; native reads isolate large frames. */
export async function selectTextGroup(
  db: DB,
  claims: any[],
  admit?: (bytes: number) => void,
) {
  // Plan using byte counts, before transferring potentially large JSON values.
  const plan = (
    await db.query(
      `SELECT d.work_id,d.snapshot_id,
    (octet_length(d.metadata::text)+octet_length(d.bibliography::text)+octet_length(d.title)+512+
      COALESCE((SELECT sum(2*octet_length(t.name)+2*coalesce(octet_length(t.source_id),0)+512)
        FROM catalog_tags t WHERE t.id IN (SELECT jsonb_array_elements_text(d.bibliography->'filterTags'))),0))::double precision AS metadata_bytes
    FROM jsonb_to_recordset($1::jsonb) c(work_id uuid,revision bigint,claim uuid)
    JOIN catalog_text_pending p ON (p.work_id,p.revision,p.claim)=(c.work_id,c.revision,c.claim)
    JOIN catalog_documents d ON d.work_id=p.work_id AND d.generation=p.requested_generation`,
      [JSON.stringify(claims)],
    )
  ).rows;
  const byId = new Map(plan.map((r) => [r.work_id, r]));
  function prefix(candidates: any[], size: (id: string) => number) {
    let bytes = 0,
      count = 0;
    for (const claim of candidates) {
      const next = size(claim.work_id);
      if (count && bytes + next > budget) break;
      bytes += next;
      count++;
    }
    return candidates.slice(0, count);
  }
  let selected = prefix(claims, (id) => byId.get(id)?.metadata_bytes ?? 0);
  const refs = await snapshotReferences(
    db,
    selected.map((c) => byId.get(c.work_id)).filter(Boolean),
  );
  const manifestSizes = new Map(
    (await findObjects(db, [...new Set(refs.map((r) => r.manifest_hash))])).map(
      (r) => [r.hash, Number(r.size)],
    ),
  );
  const manifestHash = new Map(refs.map((r) => [r.work_id, r.manifest_hash]));
  const baseSize = (id: string) =>
    (byId.get(id)?.metadata_bytes ?? 0) +
    (manifestSizes.get(manifestHash.get(id)) ?? 0);
  selected = prefix(selected, baseSize);
  admit?.(selected.reduce((sum, c) => sum + baseSize(c.work_id), 0));
  const chosen = new Set(selected.map((c) => c.work_id));
  const manifests = await loadManifests(
    db,
    selected.map((c) => byId.get(c.work_id)).filter(Boolean),
    refs.filter((r) => chosen.has(r.work_id)),
  );
  // Budget reconstructed occurrences, even when the underlying read is shared.
  const needed = (m: any): string[] => {
    if (!m || m instanceof Error) return [];
    const notes = new Map<string, string>(
      m.objects.map((o: any) => [o.name, o.hash]),
    );
    const attached = new Set<string>();
    const hashes = m.chapters.flatMap((c: any) => [
      c.hash,
      ...(c.notes ?? []).flatMap((n: any) => {
        attached.add(n.name);
        const hash = notes.get(n.name);
        return hash ? [hash] : [];
      }),
    ]);
    return [
      ...hashes,
      ...m.objects
        .filter((o: any) => o.kind === "notes_html" && !attached.has(o.name))
        .map((o: any) => o.hash),
    ];
  };
  const sizes = new Map(
    (
      await findObjects(db, [
        ...new Set([...manifests.values()].flatMap(needed)),
      ])
    ).map((r) => [r.hash, Number(r.size)]),
  );
  selected = prefix(
    selected,
    (id) =>
      baseSize(id) +
      needed(manifests.get(id)).reduce(
        (sum, h) => sum + (sizes.get(h) ?? 0),
        0,
      ),
  );
  admit?.(
    selected.reduce(
      (sum, c) =>
        sum +
        baseSize(c.work_id) +
        needed(manifests.get(c.work_id)).reduce(
          (n, h) => n + (sizes.get(h) ?? 0),
          0,
        ),
      0,
    ),
  );
  const rows = (
    await db.query(
      "SELECT * FROM catalog_documents WHERE work_id=ANY($1::uuid[])",
      [selected.filter((c) => byId.has(c.work_id)).map((c) => c.work_id)],
    )
  ).rows;
  return {
    consumed: selected.length,
    rows,
    inputs: await loadTextInputs(db, rows, manifests),
  };
}
