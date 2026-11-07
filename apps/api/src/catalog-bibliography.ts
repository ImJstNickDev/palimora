import { safeInlineHtml } from "./reader-safety";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  SourceBibliography,
  type SourceBibliography as Bibliography,
} from "@palimora/contracts";
import { DB } from "./db";
const { parseDocument }: typeof import("htmlparser2") =
  createRequire(__filename)("htmlparser2");
const render: typeof import("dom-serializer").default =
  createRequire(__filename)("dom-serializer").default;
export const values = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .filter((v): v is string => typeof v === "string")
    .filter(Boolean);
export const key = (kind: string, value: string) =>
  createHash("sha256")
    .update(kind + "\0" + value)
    .digest("hex");
export const tagKinds = [
  "fandom",
  "rating",
  "warnings",
  "category",
  "characters",
  "relationships",
  "freeform",
  "unclassified",
  "media",
];
export function plain(html: string): string {
  const root = parseDocument(html);
  const walk = (n: any): string =>
    n.type === "text"
      ? n.data
      : ["script", "style"].includes(n.name)
        ? ""
        : (n.children ?? [])
            .map(walk)
            .join(n.name === "p" || n.name === "div" ? " " : "");
  return walk(root).trim();
}
export function summary(html: string): string {
  return plain(html);
}
function list(v: unknown) {
  return values(v)
    .flatMap((s) => s.split(/\s*,\s*/))
    .filter(Boolean);
}
export function bibliography(raw: Record<string, any>): {
  metadata: Record<string, any>;
  source: Bibliography;
} {
  const source = raw.ao3
    ? SourceBibliography.parse(raw.ao3)
    : { schema: "palimora-ao3-v1" as const };
  const metadata = { ...raw };
  delete metadata.ao3;
  for (const field of tagKinds)
    metadata[field] = Array.isArray(raw[field])
      ? values(raw[field])
      : list(raw[field]);
  // FanFicFare exports comma-separated category/relationship fields. Subject values
  // preserve exact boundaries and are used only to disambiguate those fields.
  for (const field of ["fandom", "relationships"])
    if (typeof raw[field] === "string") {
      const known = values(raw.source_subjects).filter(
        (s) => raw[field] === s || raw[field].includes(s),
      );
      if (known.length && known.join(", ") === raw[field])
        metadata[field] = known;
    }
  if (raw.source_genre)
    metadata.unclassified = [
      ...new Set([...metadata.unclassified, ...list(raw.source_genre)]),
    ];
  metadata.title = values(raw.title);
  metadata.creators = values(raw.creators);
  metadata.language = values(raw.language);
  if (source.statistics)
    for (const [k, v] of Object.entries(source.statistics))
      if (k !== "observed_at") metadata[k] = v;
  for (const f of [
    "published",
    "updated",
    "complete",
    "expected_chapters",
    "availability",
    "anonymous",
    "unrevealed",
    "restricted",
    "crossover",
    "otp",
    "nonfiction",
    "work_types",
    "work_skin_id",
    "posted",
    "hidden_by_admin",
    "imported_from_url",
  ])
    if ((source as any)[f] !== undefined) metadata[f] = (source as any)[f];
  if (metadata.complete === undefined) {
    if (raw.status === "Completed" || raw.status === "Complete")
      metadata.complete = true;
    else if (raw.status === "In-Progress") metadata.complete = false;
  }
  if (
    metadata.expected_chapters === undefined &&
    metadata.complete === true &&
    typeof raw.chapter_count === "number"
  )
    metadata.expected_chapters = raw.chapter_count;
  for (const tag of source.tags ?? [])
    metadata[tag.kind] = [...new Set([...metadata[tag.kind], tag.name])];
  metadata.summary = values(raw.summary).map(plain).join("\n");
  return { metadata, source };
}
export async function ensureTag(db: DB, tag: any) {
  const id = key("tag", tag.kind + "\0" + tag.name);
  const row = (
    await db.query(
      `INSERT INTO catalog_tags(id,source_id,name,kind,canonical) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,name) DO UPDATE SET source_id=coalesce(catalog_tags.source_id,excluded.source_id),canonical=coalesce(excluded.canonical,catalog_tags.canonical) RETURNING *`,
      [id, tag.id ?? null, tag.name, tag.kind, tag.canonical ?? null],
    )
  ).rows[0];
  return row;
}
export async function projectGraph(db: DB) {
  const marker = (
    await db.query(
      "SELECT id FROM catalog_graph_pending FOR UPDATE SKIP LOCKED",
    )
  ).rows[0];
  if (!marker) return false;
  const records = (
    await db.query(
      "SELECT source_id,evidence FROM archive_tags ORDER BY source_id",
    )
  ).rows;
  const typed: any[] = [];
  const types: Record<string, string> = {
    Media: "media",
    Fandom: "fandom",
    Rating: "rating",
    ArchiveWarning: "warnings",
    Warning: "warnings",
    Category: "category",
    Character: "characters",
    Relationship: "relationships",
    Freeform: "freeform",
  };
  for (const row of records) {
    const e = row.evidence;
    const kind = types[e.type ?? e.tag_type] ?? e.kind;
    if (!tagKinds.includes(kind) || typeof e.name !== "string") continue;
    const t = {
      ...e,
      id: row.source_id,
      kind,
      canonical:
        e.canonical === true || e.canonical === 1
          ? true
          : e.canonical === false || e.canonical === 0
            ? false
            : null,
      synonym_of: e.synonym_of !== undefined ? e.synonym_of : e.merger_id,
    };
    typed.push(t);
    await ensureTag(db, t);
  }
  for (const t of typed) await tagEdges(db, t);
  await db.query(
    "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING",
  );
  await db.query("DELETE FROM catalog_graph_pending");
  return true;
}
async function tagEdges(db: DB, t: any) {
  const child = (
    await db.query("SELECT id FROM catalog_tags WHERE source_id=$1", [
      String(t.id),
    ])
  ).rows[0]?.id;
  if (!child) return;
  const fields: [string, string, unknown][] = [
    ["synonym", "synonym_of", t.synonym_of],
    ["meta", "meta_tags", t.meta_tags],
    ["parent", "parents", t.parents],
  ];
  for (const [kind, field, value] of fields) {
    if (value === undefined) continue;
    const ids = (
      field === "synonym_of" ? (value === null ? [] : [value]) : value
    ) as any[];
    const parents = (
      await db.query(
        "SELECT id FROM catalog_tags WHERE source_id=ANY($1::text[]) AND id<>$2",
        [ids.map(String), child],
      )
    ).rows.map((r) => r.id);
    await db.query(
      "DELETE FROM catalog_tag_edges WHERE child=$1 AND kind=$2 AND NOT(parent=ANY($3::text[]))",
      [child, kind, parents],
    );
    for (const parent of parents) {
      const cycle = (
        await db.query(
          `WITH RECURSIVE path(id) AS(SELECT $1::text UNION SELECT e.parent FROM catalog_tag_edges e JOIN path p ON e.child=p.id WHERE e.kind=$3) SELECT 1 FROM path WHERE id=$2 LIMIT 1`,
          [parent, child, kind],
        )
      ).rowCount;
      if (!cycle)
        await db.query(
          "INSERT INTO catalog_tag_edges VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [child, parent, kind],
        );
    }
  }
}
export async function projectBibliography(
  db: DB,
  work: any,
  raw: Record<string, any>,
  historical = false,
) {
  // Historical views can also be materialized by a reader before the queue reaches
  // them. Use the same lock as the background projector for shared tag/entity rows.
  if (historical) await db.query("SELECT pg_advisory_xact_lock(70210408)");
  const { metadata, source } = bibliography(raw);
  if (!historical) for (const t of source.tags ?? []) await ensureTag(db, t);
  if (!historical) for (const t of source.tags ?? []) await tagEdges(db, t);
  const known = (
    await db.query(
      "SELECT name,kind FROM catalog_tags WHERE name=ANY($1::text[]) AND kind<>'unclassified' AND source_id IS NOT NULL",
      [metadata.unclassified],
    )
  ).rows;
  metadata.unclassified = metadata.unclassified.filter((name: string) => {
    const matches = known.filter((t) => t.name === name);
    if (matches.length !== 1) return true;
    const kind = matches[0].kind;
    metadata[kind] = [...new Set([...metadata[kind], name])];
    return false;
  });
  const tags: any[] = [];
  if (!historical)
    await db.query("DELETE FROM catalog_work_tags WHERE work_id=$1", [work.id]);
  for (const kind of tagKinds)
    for (const name of metadata[kind]) {
      const row = await ensureTag(db, { kind, name });
      tags.push(row);
      if (!historical)
        await db.query(
          "INSERT INTO catalog_work_tags VALUES($1,$2) ON CONFLICT DO NOTHING",
          [work.id, row.id],
        );
    }
  const entities: any[] = [];
  if (!historical)
    await db.query("DELETE FROM catalog_entity_works WHERE work_id=$1", [
      work.id,
    ]);
  const add = async (kind: string, e: any, scope?: string) => {
    const sourceId = e.id ?? e.url ?? null,
      id = key(kind, sourceId ?? (scope ?? work.id) + "\0" + e.name);
    await db.query(
      `INSERT INTO catalog_entities(id,kind,source_id,name,url,details) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) ${historical ? "DO NOTHING" : "DO UPDATE SET name=excluded.name,url=coalesce(excluded.url,catalog_entities.url),details=catalog_entities.details||excluded.details"}`,
      [id, kind, sourceId, e.name, e.url ?? null, e],
    );
    if (!historical)
      await db.query(
        "INSERT INTO catalog_entity_works VALUES($1,$2,$3,$4) ON CONFLICT(entity_id,work_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,position=excluded.position",
        [id, work.id, work.current_snapshot_id, e.position ?? null],
      );
    const entity = { ...e, id, kind, source_id: sourceId };
    entities.push(entity);
    return entity;
  };
  for (const kind of ["author", "pseud", "series", "collection"]) {
    const field = (
      {
        author: "authors",
        pseud: "pseuds",
        series: "series",
        collection: "collections",
      } as any
    )[kind];
    for (const e of (source as any)[field] ?? []) await add(kind, e);
  }
  if (
    !source.authors?.length &&
    !source.pseuds?.length &&
    !metadata.anonymous
  ) {
    const urls = values(raw.author_urls);
    for (const [i, name] of values(raw.creators).entries()) {
      const url =
        urls.length === values(raw.creators).length ? urls[i] : undefined;
      let user: string | undefined, pseud: string | undefined;
      try {
        const u = new URL(url!);
        if (u.protocol === "https:" && u.hostname === "archiveofourown.org") {
          const m = u.pathname.match(/^\/users\/([^/]+)(?:\/pseuds\/([^/]+))?/);
          if (m) {
            user = decodeURIComponent(m[1]);
            pseud = m[2] ? decodeURIComponent(m[2]) : undefined;
          }
        }
      } catch {}
      if (user) {
        const author = await add("author", {
          id: user,
          name: user,
          url: `https://archiveofourown.org/users/${encodeURIComponent(user)}`,
        });
        if (pseud)
          await add("pseud", {
            id: user + "/" + pseud,
            name: pseud,
            url,
            owner_id: user,
            owner: author.id,
          });
      } else await add("author", { name });
    }
  }
  for (const kind of ["series", "collection"]) {
    const field = kind === "series" ? "series" : "collections";
    if (!(source as any)[field]?.length)
      for (const name of values(raw[field])) await add(kind, { name });
  }
  // Anonymous works retain source evidence in the manifest, but never acquire an
  // author-page association or expose original creator names in public lists.
  if (metadata.anonymous) {
    if (!historical)
      await db.query(
        "DELETE FROM catalog_entity_works WHERE work_id=$1 AND entity_id IN(SELECT id FROM catalog_entities WHERE kind IN('author','pseud'))",
        [work.id],
      );
    metadata.creators = ["Anonymous"];
  }
  const expanded = (
    await db.query(
      `WITH RECURSIVE closure(id) AS (SELECT tag_id FROM catalog_work_tags WHERE work_id=$1 UNION SELECT e.parent FROM catalog_tag_edges e JOIN closure c ON c.id=e.child WHERE e.kind IN('synonym','meta')) SELECT t.* FROM closure c JOIN catalog_tags t ON t.id=c.id`,
      [work.id],
    )
  ).rows;
  if (!historical) {
    await db.query("DELETE FROM catalog_work_filters WHERE work_id=$1", [
      work.id,
    ]);
    await db.query(
      "INSERT INTO catalog_work_filters SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",
      [work.id, expanded.map((r) => r.id)],
    );
  }
  return {
    metadata,
    details: {
      tags,
      entities: metadata.anonymous
        ? entities.filter((e) => !["author", "pseud"].includes(e.kind))
        : entities,
      relations: source.relations ?? [],
    },
    filterTags: expanded.map((r) => r.id),
  };
}
export async function bibliographyPage(db: DB, kind: string, id: string) {
  if (kind === "tag") {
    const item = (
      await db.query("SELECT * FROM catalog_tags WHERE id=$1", [id])
    ).rows[0];
    if (!item) return null;
    const relations = (
      await db.query(
        `SELECT t.*,e.kind AS relation,CASE WHEN e.child=$1 THEN 'parent' ELSE 'child' END AS direction FROM catalog_tag_edges e JOIN catalog_tags t ON t.id=CASE WHEN e.child=$1 THEN e.parent ELSE e.child END WHERE e.child=$1 OR e.parent=$1 ORDER BY e.kind,t.name`,
        [id],
      )
    ).rows;
    const substitutions: Record<string, string> = {
      "/": "*s*",
      "&": "*a*",
      ".": "*d*",
      "?": "*q*",
      "#": "*h*",
    };
    return {
      item: {
        ...item,
        url:
          "https://archiveofourown.org/tags/" +
          encodeURIComponent(
            item.name.replace(/[\/&.?#]/g, (c: string) => substitutions[c]),
          ),
      },
      relations,
    };
  }
  const item = (
    await db.query("SELECT * FROM catalog_entities WHERE id=$1 AND kind=$2", [
      id,
      kind,
    ])
  ).rows[0];
  if (!item) return null;
  const relations = (
    await db.query(
      `SELECT * FROM catalog_entities WHERE (kind='pseud' AND details->>'owner_id'=$1) OR (kind='author' AND source_id=$2) OR (kind='collection' AND details->>'parent_id'=$1) OR (kind='collection' AND source_id=$3) OR (kind='author' AND source_id=ANY($4::text[])) ORDER BY name`,
      [
        item.source_id,
        item.details.owner_id ?? null,
        item.details.parent_id ?? null,
        item.details.creators ?? [],
      ],
    )
  ).rows;
  return {
    item: {
      ...item,
      details: {
        ...item.details,
        ...Object.fromEntries(
          ["description", "notes", "introduction", "faq", "rules"]
            .filter((f) => item.details[f] !== undefined)
            .map((f) => [f, safeInlineHtml(item.details[f])]),
        ),
      },
    },
    relations,
  };
}

/** Derive hyperlinks already preserved in the canonical title page, never fetch AO3. */
export async function enrichBibliography(
  db: DB,
  raw: Record<string, any>,
  manifest: any,
) {
  if (!manifest) return raw;
  const { readObject } = await import("./archive");
  const source: any = raw.ao3
    ? structuredClone(raw.ao3)
    : { schema: "palimora-ao3-v1" };
  const entityLists: Record<string, Map<string, any>> = {
    series: new Map(),
    collections: new Map(),
  };
  const foundTags: any[] = [];
  for (const object of manifest.objects.filter(
    (o: any) => o.kind === "document_html",
  )) {
    const root = parseDocument((await readObject(db, object.hash)).toString());
    const walk = (n: any) => {
      if (n.name === "a" && n.attribs?.href) {
        let u: URL | undefined;
        try {
          u = new URL(n.attribs.href, "https://archiveofourown.org");
        } catch {}
        if (u?.hostname === "archiveofourown.org" && u.protocol === "https:") {
          const series = u.pathname.match(/^\/series\/(\d+)\/?$/),
            collection = u.pathname.match(/^\/collections\/([^/]+)\/?$/),
            tag = u.pathname.match(/^\/tags\/([^/]+)\/?(?:works)?$/);
          const name = plain(render(n)).trim();
          if (name && (series || collection)) {
            const field = series ? "series" : "collections",
              id = decodeURIComponent((series ?? collection)![1]);
            const siblings = n.parent?.children ?? [];
            const preceding = plain(
              siblings
                .slice(0, siblings.indexOf(n))
                .map((sibling: any) => render(sibling))
                .join(""),
            );
            const position = series
              ? preceding.match(/\bPart\s+(\d+(?:\.\d+)?)\s+of\s*$/i)?.[1]
              : undefined;
            entityLists[field].set(id, {
              id,
              name,
              url: u.origin + u.pathname,
              ...(position ? { position: Number(position) } : {}),
            });
          }
          if (tag && name) {
            let parent = n.parent,
              kind;
            while (parent && !kind) {
              const classes = (parent.attribs?.class ?? "").split(/\s+/);
              kind = Object.entries({
                fandom: "fandom",
                rating: "rating",
                warning: "warnings",
                category: "category",
                character: "characters",
                relationship: "relationships",
                freeform: "freeform",
              }).find(([k]) => classes.includes(k))?.[1];
              parent = parent.parent;
            }
            if (kind) foundTags.push({ name, kind });
          }
        }
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
  }
  for (const [field, entries] of Object.entries(entityLists))
    if (!source[field]?.length && entries.size)
      source[field] = [...entries.values()];
  if (!source.tags?.length && foundTags.length) source.tags = foundTags;
  return { ...raw, ao3: source };
}
