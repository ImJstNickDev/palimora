import { mediaDescriptor, resourceRef, workStyles } from "./reader-media";
import { safeInlineHtml } from "./reader-safety";
import {
  projectBibliography,
  enrichBibliography,
  projectGraph,
  bibliographyPage,
  bibliography,
} from "./catalog-bibliography";
import { searchWorks, languageCode } from "./catalog-search";
export { projectText } from "./catalog-search";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { DB, transaction } from "./db";
import { hydrateWorks } from "./archive-catalog";
import { readObject } from "./archive";
import { archiveOperation } from "./archive-admin";
import { fail } from "./security";
import { safeHtml, readerDocument, escapeHtml } from "./reader-safety";
export function strings(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).filter(
    (x): x is string => typeof x === "string",
  );
}
export async function projectCatalog() {
  return transaction(async (db) => {
    // Tag and entity upserts are shared across works. Serialize this projection;
    // independent text indexing keeps its per-work SKIP LOCKED concurrency.
    await db.query("SELECT pg_advisory_xact_lock(70210408)");
    await projectGraph(db);
    const rows = (
      await db.query(
        "SELECT p.work_id FROM catalog_pending p ORDER BY p.work_id LIMIT 20 FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    if (!rows.length) {
      const pending = (
        await db.query(
          "SELECT p.snapshot_id,s.work_id,s.manifest_hash FROM catalog_snapshot_pending p JOIN archive_snapshots s ON s.id=p.snapshot_id LIMIT 20 FOR UPDATE OF p SKIP LOCKED",
        )
      ).rows;
      for (const item of pending) {
        const m = JSON.parse(
          (await readObject(db, item.manifest_hash)).toString(),
        );
        const projected = await projectBibliography(
          db,
          { id: item.work_id, current_snapshot_id: item.snapshot_id },
          await enrichBibliography(db, m.metadata, m),
          true,
        );
        await db.query(
          "INSERT INTO catalog_snapshot_views VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [item.snapshot_id, projected.metadata, projected.details],
        );
        await db.query(
          "DELETE FROM catalog_snapshot_pending WHERE snapshot_id=$1",
          [item.snapshot_id],
        );
      }
      return;
    }
    const works = await hydrateWorks(
      db,
      (
        await db.query("SELECT * FROM archive_works WHERE id=ANY($1::uuid[])", [
          rows.map((r) => r.work_id),
        ])
      ).rows,
    );
    for (const w of works) {
      const manifest = w.current_snapshot_id
        ? (await loadSnapshot(db, w.id)).manifest
        : null;
      const projected = await projectBibliography(
        db,
        w,
        await enrichBibliography(db, w.metadata, manifest),
      );
      const availability = (
        await db.query(
          "SELECT availability FROM ao3_jobs WHERE kind='work' AND target=$1",
          [w.external_id],
        )
      ).rows[0]?.availability;
      if (availability && availability !== "unknown")
        projected.metadata.availability = availability;
      const details = {
        ...projected.details,
        filterTags: projected.filterTags,
      };
      const generation = createHash("sha256")
        .update(
          JSON.stringify([w.current_snapshot_id, projected.metadata, details]),
        )
        .digest("hex");
      await db.query(
        `INSERT INTO catalog_documents(work_id,snapshot_id,metadata,title,bibliography,generation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(work_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,metadata=excluded.metadata,title=excluded.title,bibliography=excluded.bibliography,generation=excluded.generation,indexed_at=now()`,
        [
          w.id,
          w.current_snapshot_id,
          projected.metadata,
          strings(w.metadata.title).join(" · "),
          details,
          generation,
        ],
      );
    }
    await db.query(
      "INSERT INTO catalog_text_pending SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING",
      [rows.map((r) => r.work_id)],
    );
    await db.query(
      "DELETE FROM catalog_pending WHERE work_id=ANY($1::uuid[])",
      [rows.map((r) => r.work_id)],
    );
  });
}
export async function loadSnapshot(db: DB, id: string, snapshot?: string) {
  const w = (
    await hydrateWorks(
      db,
      (await db.query("SELECT * FROM archive_works WHERE id=$1", [id])).rows,
    )
  )[0];
  if (!w) fail("NOT_FOUND", 404);
  const selected = snapshot ?? w.current_snapshot_id;
  if (!selected) return { work: w, manifest: null, snapshot: null };
  const s = (
    await db.query(
      `SELECT * FROM archive_snapshots WHERE id=$1 AND (work_id=$2 OR work_id IN(SELECT work_id FROM archive_identity_links WHERE canonical_work_id=$2))`,
      [selected, id],
    )
  ).rows[0];
  if (!s) fail("NOT_FOUND", 404);
  return {
    work: w,
    manifest: JSON.parse((await readObject(db, s.manifest_hash)).toString()),
    snapshot: s.id,
  };
}
export async function catalogOperation(
  db: DB,
  op: string,
  x: any,
): Promise<any> {
  if (op === "catalogWorks") return searchWorks(db, x);
  if (op === "bibliographyPage") {
    const page = await bibliographyPage(db, x.kind, x.id);
    if (!page) fail("NOT_FOUND", 404);
    return page;
  }
  if (op === "catalogBrowse") {
    if (x.kind === "language") {
      const items = (
        await db.query(
          `WITH languages AS (
        SELECT CASE jsonb_typeof(metadata->'language') WHEN 'array' THEN metadata->'language'->>0 WHEN 'string' THEN metadata->>'language' END AS name
        FROM catalog_documents d WHERE NOT EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=d.work_id)
      ) SELECT name AS id,name,count(*)::int AS works,'language' AS page_kind FROM languages
      WHERE name IS NOT NULL AND name<>'' AND name ILIKE '%'||$1||'%'
      AND ($2::text IS NULL OR (lower(name),name)>(lower($2),$2))
      GROUP BY name ORDER BY lower(name),name LIMIT 101`,
          [x.q ?? "", x.cursor ?? null],
        )
      ).rows;
      return {
        items: items.slice(0, 100),
        next: items.length > 100 ? items[99].id : null,
      };
    }
    const tagKind = [
      "fandom",
      "rating",
      "warnings",
      "category",
      "characters",
      "relationships",
      "freeform",
      "unclassified",
      "media",
    ].includes(x.kind);
    const kind =
      (
        {
          creators: "author",
          pseuds: "pseud",
          series: "series",
          collections: "collection",
        } as any
      )[x.kind] ?? x.kind;
    const items = tagKind
      ? (
          await db.query(
            `WITH RECURSIVE selected AS(SELECT * FROM catalog_tags t WHERE t.kind=$1 AND t.name ILIKE '%'||$2||'%' AND ($3::text IS NULL OR (lower(t.name),t.id)>(SELECT lower(name),id FROM catalog_tags WHERE id=$3)) ORDER BY lower(t.name),t.id LIMIT 101), resolved(root,id) AS(SELECT id,id FROM selected UNION SELECT r.root,e.parent FROM resolved r JOIN catalog_tag_edges e ON e.child=r.id WHERE e.kind='synonym'), effective AS(SELECT root,id FROM resolved WHERE NOT EXISTS(SELECT 1 FROM catalog_tag_edges e WHERE e.child=resolved.id AND e.kind='synonym')) SELECT t.*,count(DISTINCT w.work_id)::int AS works,'tag' AS page_kind FROM selected t LEFT JOIN effective e ON e.root=t.id LEFT JOIN catalog_work_filters w ON w.tag_id=e.id AND NOT EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=w.work_id) GROUP BY t.id,t.source_id,t.name,t.kind,t.canonical ORDER BY lower(t.name),t.id`,
            [kind, x.q ?? "", x.cursor ?? null],
          )
        ).rows
      : (
          await db.query(
            `SELECT e.*,count(DISTINCT w.work_id)::int AS works,e.kind AS page_kind FROM catalog_entities e LEFT JOIN catalog_entity_works w ON w.entity_id=e.id AND NOT EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=w.work_id) WHERE e.kind=$1 AND e.name ILIKE '%'||$2||'%' AND ($3::text IS NULL OR (lower(e.name),e.id)>(SELECT lower(name),id FROM catalog_entities WHERE id=$3)) GROUP BY e.id ORDER BY lower(e.name),e.id LIMIT 101`,
            [kind, x.q ?? "", x.cursor ?? null],
          )
        ).rows;
    return {
      items: items.slice(0, 100),
      next: items.length > 100 ? items[99].id : null,
    };
  }
  if (op === "readerInteractions") {
    const { manifest } = await loadSnapshot(db, x.id, x.snapshot);
    if (!manifest) fail("NOT_FOUND", 404);
    const source = manifest.metadata.ao3;
    const comments = source?.comments ?? [];
    const ids = new Set(comments.map((c: any) => c.id));
    const selected = comments.filter((c: any) =>
      x.parent
        ? c.parent_id === x.parent
        : !c.parent_id || !ids.has(c.parent_id),
    );
    const offset = x.cursor ? Number(x.cursor) : 0,
      koffset = x.kudosCursor ? Number(x.kudosCursor) : 0;
    const users = source?.kudos?.users ?? [];
    return {
      available: source?.comments !== undefined,
      commentsCoverage: source?.comments_coverage ?? "unknown",
      kudosCoverage: source?.kudos_coverage ?? "unknown",
      comments: selected.slice(offset, offset + 30).map((c: any) => ({
        ...c,
        html: c.deleted ? "" : safeInlineHtml(c.html),
        children: comments.filter((r: any) => r.parent_id === c.id).length,
      })),
      next: offset + 30 < selected.length ? String(offset + 30) : null,
      kudos: source?.kudos
        ? { ...source.kudos, users: users.slice(koffset, koffset + 100) }
        : null,
      nextKudos: koffset + 100 < users.length ? String(koffset + 100) : null,
      statistics: source?.statistics ?? null,
    };
  }
  if (op === "readerWork") {
    const data = await loadSnapshot(db, x.id, x.snapshot);
    const versions = await archiveOperation(db, "archiveWork", {
      id: x.id,
      cursor: x.cursor,
    });
    let view = !x.snapshot
      ? (
          await db.query(
            "SELECT metadata,bibliography FROM catalog_documents WHERE work_id=$1 AND snapshot_id IS NOT DISTINCT FROM $2",
            [x.id, data.snapshot],
          )
        ).rows[0]
      : data.snapshot
        ? (
            await db.query(
              "SELECT metadata,bibliography FROM catalog_snapshot_views WHERE snapshot_id=$1",
              [data.snapshot],
            )
          ).rows[0]
        : null;
    if (!view) {
      const projected = await projectBibliography(
        db,
        { ...data.work, current_snapshot_id: data.snapshot },
        await enrichBibliography(
          db,
          x.snapshot
            ? (data.manifest?.metadata ?? data.work.metadata)
            : data.work.metadata,
          data.manifest,
        ),
        true,
      );
      view = { metadata: projected.metadata, bibliography: projected.details };
    }
    if (!x.snapshot) {
      const availability = (
        await db.query(
          "SELECT availability FROM ao3_jobs WHERE kind='work' AND target=$1",
          [data.work.external_id],
        )
      ).rows[0]?.availability;
      if (availability && availability !== "unknown")
        view.metadata = { ...view.metadata, availability };
    }
    const relations = [];
    for (const rel of view.bibliography.relations ?? []) {
      const local = (
        await db.query(
          "SELECT id FROM archive_work_heads WHERE external_id=$1",
          [rel.work_id],
        )
      ).rows[0];
      relations.push({ ...rel, local_id: local?.id ?? null });
    }
    return {
      ...data,
      metadata: view.metadata,
      bibliography: { ...view.bibliography, relations },
      versions: versions.snapshots,
      next: versions.next,
    };
  }
  if (op === "readerMedia") {
    const { manifest } = await loadSnapshot(db, x.id, x.snapshot);
    if (!manifest) fail("NOT_FOUND", 404);
    return mediaDescriptor(db, manifest, x.hash);
  }
  if (op === "readerContent") {
    const { manifest: m, snapshot: selected } = await loadSnapshot(
      db,
      x.id,
      x.snapshot,
    );
    if (!m) fail("NOT_FOUND", 404);
    const chapters = x.chapter
      ? m.chapters.filter((c: any) => c.chapter_id === x.chapter)
      : m.chapters;
    if (x.chapter && !chapters.length) fail("NOT_FOUND", 404);
    let body = "";
    for (const c of chapters) {
      let original = await chapterBytes(db, m, c);
      const mediaRef = (url: string) => resourceRef(m, c.name, url)?.hash;
      const media = (url: string) => {
        const hash = mediaRef(url);
        return hash
          ? `/api/v1/works/${x.id}/media/${hash}?snapshot=${selected}`
          : "";
      };
      const content = safeHtml(
        original.toString(),
        media,
        false,
        (url) => {
          if (url.startsWith("#")) return url;
          let path: string | undefined;
          try {
            path = posix.normalize(
              posix.join(
                posix.dirname(c.name),
                decodeURIComponent(url.split("#")[0]),
              ),
            );
          } catch {}
          const target = m.chapters.find(
            (other: any) =>
              other.name === path || other.source_url === url.split("#")[0],
          );
          if (target)
            return x.chapter
              ? `/works/${x.id}?snapshot=${selected}&chapter=${target.chapter_id}${url.includes("#") ? "#" + url.split("#")[1] : ""}`
              : `#chapter-${target.chapter_id}`;
          const local = resourceRef(m, c.name, url);
          return local
            ? `/api/v1/works/${x.id}/media/${local.hash}?snapshot=${selected}&download=true`
            : url;
        },
        x.skin !== "off",
      );
      const heading =
        c.title && !/<h[1-6](?:\s|>)/i.test(content)
          ? `<h2>${escapeHtml(c.title)}</h2>`
          : "";
      body += `<section class="chapter" id="chapter-${c.chapter_id}">${heading}${content}</section>`;
    }
    const style =
      x.skin === "on"
        ? await workStyles(
            db,
            m,
            (asset) =>
              `/api/v1/works/${x.id}/media/${asset.hash}?snapshot=${selected}`,
          )
        : "";
    const notes = workNotes(m);
    const renderNote = async (n: any) =>
      safeHtml(
        (await readObject(db, n.hash)).toString(),
        (url) => {
          const ref = resourceRef(m, n.name, url);
          return ref
            ? `/api/v1/works/${x.id}/media/${ref.hash}?snapshot=${selected}`
            : "";
        },
        false,
        (url) => url,
        x.skin !== "off",
      );
    if (!x.chapter || chapters[0] === m.chapters[0])
      for (const note of [...notes.before].reverse())
        body = `<aside class="notes">${await renderNote(note)}</aside>` + body;
    if (!x.chapter || chapters[0] === m.chapters.at(-1))
      for (const note of notes.after)
        body += `<aside class="notes">${await renderNote(note)}</aside>`;
    return {
      document: readerDocument(body, style, {
        language: languageCode(strings(m.metadata.language)[0] || "und"),
        theme: x.theme,
        font: x.font,
        size: x.size,
      }),
    };
  }
  fail("NOT_FOUND", 404);
}

export async function chapterBytes(db: DB, m: any, c: any) {
  let bytes = await readObject(db, c.hash);
  for (const note of [...(c.notes ?? [])].sort((a, b) => a.offset - b.offset)) {
    const ref = m.objects.find((o: any) => o.name === note.name);
    if (!ref) throw Error("NOTE_MISSING");
    const fragment = await readObject(db, ref.hash);
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

/** Layout offsets distinguish work preface notes from endnotes without guessing filenames. */
export function workNotes(m: any) {
  const used = new Set(
    m.chapters.flatMap((c: any) => (c.notes ?? []).map((n: any) => n.name)),
  );
  const fragments = m.document?.fragments ?? [];
  const first = fragments
    .filter((f: any) => f.kind === "chapter_html")
    .reduce((min: number, f: any) => Math.min(min, f.offset), Infinity);
  const before: any[] = [],
    after: any[] = [];
  for (const note of m.objects.filter(
    (o: any) => o.kind === "notes_html" && !used.has(o.name),
  )) {
    const layout = fragments.find((f: any) => f.name === note.name);
    (layout && first !== Infinity && layout.offset < first
      ? before
      : after
    ).push(note);
  }
  return { before, after };
}
