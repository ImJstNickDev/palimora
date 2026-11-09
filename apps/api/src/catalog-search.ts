import { createHash } from "node:crypto";
import { DB, transaction } from "./db";
import { fail } from "./security";
import { plain, values, tagKinds } from "./catalog-bibliography";
import { loadTextInputs } from "./catalog-text-preparation";
export const SEARCH_INDEX = "palimora-works-v2";
export const SEARCH_WRITE_ALIAS = SEARCH_INDEX + "-write";
const analyzers: Record<string, string> = {
  en: "english",
  it: "italian",
  fr: "french",
  de: "german",
  es: "spanish",
  pt: "portuguese",
  ru: "russian",
  nl: "dutch",
  sv: "swedish",
  da: "danish",
  no: "norwegian",
  fi: "finnish",
  tr: "turkish",
  ar: "arabic",
  zh: "cjk",
  ja: "cjk",
  ko: "cjk",
  pl: "standard",
  uk: "standard",
  und: "standard",
};
const languageNames: Record<string, string> = {
  English: "en",
  Italiano: "it",
  Italian: "it",
  Français: "fr",
  French: "fr",
  Deutsch: "de",
  German: "de",
  Español: "es",
  Spanish: "es",
  Português: "pt",
  Portuguese: "pt",
  Русский: "ru",
  "中文-普通话 國語": "zh",
  中文: "zh",
  日本語: "ja",
  한국어: "ko",
  Polski: "pl",
  Українська: "uk",
};
export function languageCode(name: string) {
  return (
    languageNames[name] ??
    (analyzers[name.split("-")[0]] ? name.split("-")[0] : "und")
  );
}
export async function searchRequest(
  path: string,
  body?: unknown,
  method = "POST",
  raw = false,
): Promise<any> {
  const url = process.env.OPENSEARCH_URL ?? "http://opensearch:9200";
  let r: Response;
  try {
    r = await fetch(url + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    fail("SEARCH_UNAVAILABLE", 503);
  }
  if (raw) return r;
  const result = await r.json();
  if (!r.ok) {
    if (r.status >= 500 || r.status === 429)
      console.error(
        JSON.stringify({
          event: "search_request_failed",
          status: r.status,
          type: result.error?.type,
        }),
      );
    if (r.status === 400) fail("SEARCH_QUERY_INVALID", 400);
    if (r.status === 404 && path === "/_search")
      fail("SEARCH_CURSOR_EXPIRED", 410);
    fail("SEARCH_UNAVAILABLE", 503);
  }
  return result;
}
// Keep hits on the lighter collector group; definitions and filters are shared.
const parallelFacetGroup = new Set([
  "unclassified",
  "rating",
  "warnings",
  "category",
]);
async function searchWithFacets(body: any) {
  if (process.env.SEARCH_PARALLEL_FACETS !== "1")
    return searchRequest("/_search", body);
  const first: any = {},
    second: any = {};
  for (const [key, value] of Object.entries(body.aggs))
    (parallelFacetGroup.has(key) ? first : second)[key] = value;
  const a = { ...body, aggs: first };
  const b = {
    pit: body.pit,
    query: body.query,
    size: 0,
    track_total_hits: false,
    aggs: second,
  };
  let response: Response;
  try {
    response = await fetch(
      (process.env.OPENSEARCH_URL ?? "http://opensearch:9200") +
        "/_msearch?max_concurrent_searches=2",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body: [{}, a, {}, b].map((x) => JSON.stringify(x)).join("\n") + "\n",
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    fail("SEARCH_UNAVAILABLE", 503);
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    fail("SEARCH_UNAVAILABLE", 503);
  }
  if (response.status === 400) fail("SEARCH_QUERY_INVALID", 400);
  if (
    !response.ok ||
    !Array.isArray(result.responses) ||
    result.responses.length !== 2
  )
    fail("SEARCH_UNAVAILABLE", 503);
  for (const part of result.responses) {
    if (!part || typeof part !== "object") fail("SEARCH_UNAVAILABLE", 503);
    if (part.status === 400) fail("SEARCH_QUERY_INVALID", 400);
    if (part.status === 404) fail("SEARCH_CURSOR_EXPIRED", 410);
    if (
      part.error ||
      part.timed_out !== false ||
      !part._shards ||
      part._shards.failed !== 0
    )
      fail("SEARCH_UNAVAILABLE", 503);
    // OpenSearch 2.19.4 preserves the PIT id; never mix a different snapshot.
    if (part.pit_id !== undefined && part.pit_id !== body.pit.id)
      fail("SEARCH_UNAVAILABLE", 503);
  }
  const [left, right] = result.responses;
  const aggregations: any = {};
  for (const key of Object.keys(body.aggs)) {
    const value = (parallelFacetGroup.has(key) ? left : right).aggregations?.[
      key
    ];
    if (!Array.isArray(value?.buckets)) fail("SEARCH_UNAVAILABLE", 503);
    aggregations[key] = value;
  }
  if (
    !Array.isArray(left.hits?.hits) ||
    !Number.isFinite(left.hits?.total?.value)
  )
    fail("SEARCH_UNAVAILABLE", 503);
  return { ...left, aggregations };
}
export async function ensureSearchIndex() {
  const head = await searchRequest(
    "/" + SEARCH_INDEX + "/_alias/" + SEARCH_WRITE_ALIAS,
    undefined,
    "HEAD",
    true,
  );
  if (head.ok) return false;
  if (head.status !== 404) fail("SEARCH_UNAVAILABLE", 503);
  const existing = await searchRequest(
    "/" + SEARCH_INDEX,
    undefined,
    "HEAD",
    true,
  );
  if (existing.ok) {
    await searchRequest(
      "/" + SEARCH_INDEX + "/_alias/" + SEARCH_WRITE_ALIAS,
      {},
      "PUT",
    );
    return false;
  }
  if (existing.status !== 404) fail("SEARCH_UNAVAILABLE", 503);
  await transaction((db) =>
    db.query(
      "INSERT INTO catalog_text_pending(work_id) SELECT work_id FROM catalog_documents ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
    ),
  );
  const text = { type: "text" },
    keyword = { type: "keyword", ignore_above: 4096 },
    number = { type: "long" },
    date = { type: "date", ignore_malformed: true };
  const properties: any = {
    epoch: keyword,
    alias: { type: "boolean" },
    id: keyword,
    ao3_id: { type: "long" },
    memberships: {
      type: "nested",
      properties: { id: keyword, position: { type: "double" } },
    },
    generation: keyword,
    snapshot: keyword,
    external_id: keyword,
    title: {
      ...text,
      fields: { sort: { type: "keyword", normalizer: "folded" } },
    },
    creators: {
      ...text,
      fields: { sort: { type: "keyword", normalizer: "folded" } },
    },
    summary: text,
    notes: text,
    endnotes: text,
    tag: text,
    series: {
      properties: { title: text, id: keyword, position: { type: "double" } },
    },
    filter_ids: keyword,
    entity_ids: keyword,
    language_id: keyword,
    language: keyword,
    availability: keyword,
    complete: { type: "boolean" },
    crossover: { type: "boolean" },
    restricted: { type: "boolean" },
    anonymous: { type: "boolean" },
    unrevealed: { type: "boolean" },
    expected_number_of_chapters: number,
    chapter_count: number,
    word_count: number,
    hits: number,
    kudos_count: number,
    comments_count: number,
    bookmarks_count: number,
    created_at: date,
    revised_at: date,
    archived_at: date,
    sort_title: keyword,
    sort_authors: keyword,
    user_ids: keyword,
    pseud_ids: keyword,
    collection_ids: keyword,
    ...Object.fromEntries(
      [
        "rating_ids",
        "archive_warning_ids",
        "category_ids",
        "fandom_ids",
        "character_ids",
        "relationship_ids",
        "freeform_ids",
        "work_types",
        "work_skin_id",
        "imported_from_url",
      ].map((f) => [f, keyword]),
    ),
    ...Object.fromEntries(
      ["otp", "nonfiction", "posted", "hidden_by_admin"].map((f) => [
        f,
        { type: "boolean" },
      ]),
    ),
    series_position: { type: "double" },
    text: {
      properties: Object.fromEntries(
        Object.entries(analyzers).map(([lang, analyzer]) => [
          lang,
          { type: "text", analyzer },
        ]),
      ),
    },
  };
  for (const kind of tagKinds) properties[kind] = keyword;
  const response = await searchRequest(
    "/" + SEARCH_INDEX,
    {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          normalizer: {
            folded: { type: "custom", filter: ["lowercase", "asciifolding"] },
          },
        },
      },
      mappings: { dynamic: false, properties },
      aliases: { [SEARCH_WRITE_ALIAS]: {} },
    },
    "PUT",
    true,
  );
  if (!response.ok) {
    const error = await response.json();
    if (error.error?.type !== "resource_already_exists_exception") {
      console.error(
        JSON.stringify({
          event: "search_index_create_failed",
          type: error.error?.type,
          reason: error.error?.reason,
        }),
      );
      fail("SEARCH_UNAVAILABLE", 503);
    }
  }
  return true;
}
export async function prepareTextDocument(db: DB, row: any, input?: any) {
  // One transformation for both single-document callers and collective preparation.
  const data = input ?? (await loadTextInputs(db, [row])).get(row.work_id);
  if (data instanceof Error) throw data;
  if (!data) throw Error("TEXT_INPUT_MISSING");
  const { manifest: m, text, epoch } = data;
  const metadata = row.metadata;
  const language = values(metadata.language)[0] ?? "und",
    code = languageCode(language);
  const document: any = {
    epoch,
    memberships: (row.bibliography.entities ?? [])
      .filter((e: any) => e.position !== undefined)
      .map((e: any) => ({ id: e.id, position: e.position })),
    id: row.work_id,
    generation: row.generation,
    snapshot: row.snapshot_id,
    title: values(metadata.title).join(" · "),
    creators: [
      ...new Set([
        ...values(metadata.creators),
        ...(row.bibliography.entities ?? [])
          .filter((e: any) => ["author", "pseud"].includes(e.kind))
          .map((e: any) => e.name),
      ]),
    ],
    summary: metadata.summary ?? "",
    tag: tagKinds.flatMap((k) => values(metadata[k])),
    filter_ids: row.bibliography.filterTags ?? [],
    entity_ids: (row.bibliography.entities ?? []).map((e: any) => e.id),
    language,
    language_id: code,
    series: {
      id: (row.bibliography.entities ?? [])
        .filter((e: any) => e.kind === "series")
        .map((e: any) => e.source_id)
        .filter(Boolean),
      position: (row.bibliography.entities ?? [])
        .filter((e: any) => e.kind === "series" && e.position !== undefined)
        .map((e: any) => e.position),
      title: (row.bibliography.entities ?? [])
        .filter((e: any) => e.kind === "series")
        .map((e: any) => e.name),
    },
    availability: metadata.availability ?? "unknown",
    text: { [code]: text.join("\n") },
    archived_at: row.indexed_at,
  };
  for (const k of tagKinds) document[k] = values(metadata[k]);
  for (const [from, to] of Object.entries({
    words: "word_count",
    hits: "hits",
    kudos: "kudos_count",
    comments: "comments_count",
    bookmarks: "bookmarks_count",
    chapter_count: "chapter_count",
    expected_chapters: "expected_number_of_chapters",
  }))
    if (typeof metadata[from] === "number") document[to] = metadata[from];
  for (const [from, to] of [
    ["published", "created_at"],
    ["updated", "revised_at"],
  ])
    if (/^\d{4}-\d{2}-\d{2}/.test(metadata[from] ?? ""))
      document[to] = metadata[from].slice(0, 10);
  for (const field of ["complete", "anonymous", "unrevealed", "restricted"])
    if (typeof metadata[field] === "boolean") document[field] = metadata[field];
  for (const field of [
    "crossover",
    "otp",
    "nonfiction",
    "posted",
    "hidden_by_admin",
    "work_types",
    "work_skin_id",
    "imported_from_url",
  ])
    if (metadata[field] !== undefined) document[field] = metadata[field];
  const fandomEvidence = (row.bibliography.tags ?? []).filter(
    (t: any) => t.kind === "fandom",
  );
  if (document.fandom.length === 1 && document.crossover === undefined)
    document.crossover = false;
  if (
    document.fandom.length > 1 &&
    fandomEvidence.every((t: any) => t.source_id) &&
    document.crossover === undefined
  ) {
    document.crossover = data.crossover;
  }
  const relationshipEvidence = (row.bibliography.tags ?? []).filter(
    (t: any) => t.kind === "relationships",
  );
  if (document.relationships.length === 1 && document.otp === undefined)
    document.otp = true;
  if (
    document.relationships.length > 1 &&
    relationshipEvidence.every((t: any) => t.source_id) &&
    document.otp === undefined
  ) {
    const resolved = { n: data.otpCount };
    document.otp = resolved.n === 1;
  }
  let title = document.title.toLowerCase().replace(/^["'./]/, "");
  const article = title.match(/^(a|an|the) (.+)$/);
  if (article) title = article[2] + ", " + article[1];
  document.sort_title = /^\d/.test(title) ? title.padStart(5, "0") : title;
  const pseuds = (row.bibliography.entities ?? [])
    .filter((e: any) => e.kind === "pseud")
    .map((e: any) => e.name);
  document.sort_authors = [...(pseuds.length ? pseuds : document.creators)]
    .sort()
    .join(",  ")
    .toLowerCase()
    .replace(/^[+\-=_?!'"./]/, "");
  for (const [kind, field] of [
    ["author", "user_ids"],
    ["pseud", "pseud_ids"],
    ["collection", "collection_ids"],
  ])
    document[field] = (row.bibliography.entities ?? [])
      .filter((e: any) => e.kind === kind)
      .map((e: any) => e.source_id)
      .filter(Boolean);
  const ext = data.ext;
  document.alias = data.alias;
  document.external_id = ext.external_id;
  document.archived_at = ext.archived_at;
  if (/^\d+$/.test(ext.external_id ?? ""))
    document.ao3_id = Number(ext.external_id);
  if (m) document.notes = data.notes.join("\n");
  const canonicalTags: any[] = data.canonicalTags;
  for (const kind of tagKinds)
    document[kind] = canonicalTags
      .filter((t) => t.kind === kind)
      .map((t) => t.name);
  const sourceTags: any[] = data.sourceTags;
  document.filter_ids = [
    ...document.filter_ids,
    ...sourceTags.map((t) => t.source_id),
  ];
  for (const [kind, field] of Object.entries({
    rating: "rating_ids",
    warnings: "archive_warning_ids",
    category: "category_ids",
    fandom: "fandom_ids",
    characters: "character_ids",
    relationships: "relationship_ids",
    freeform: "freeform_ids",
  }))
    document[field] = sourceTags
      .filter((t) => t.kind === kind)
      .map((t) => t.source_id);
  return document;
}
export { projectText } from "./catalog-text-bulk";
export function numericRange(input: string) {
  const v = input.replaceAll(",", "").trim();
  const m = v.match(/^(<=|>=|<|>|=)?\s*(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) fail("SEARCH_QUERY_INVALID", 400);
  const n = Number(m[2]),
    end = m[3] ? Number(m[3]) : n;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(end) || n > end)
    fail("SEARCH_QUERY_INVALID", 400);
  return m[1] && m[1] !== "="
    ? { [{ ">": "gt", "<": "lt", ">=": "gte", "<=": "lte" }[m[1]]!]: n }
    : { gte: n, lte: end };
}
export function relativeRange(input: string) {
  const m = input
    .toLowerCase()
    .trim()
    .match(
      /^(<|>)?\s*(\d+)(?:\s*-\s*(\d+))?\s*(hour|day|week|month|year)s?(?:\s+ago)?$/,
    );
  if (!m) fail("SEARCH_QUERY_INVALID", 400);
  const unit = (
      { hour: "h", day: "d", week: "w", month: "M", year: "y" } as any
    )[m[4]],
    a = Number(m[2]),
    b = m[3] ? Number(m[3]) : a;
  if (m[1]) return { [m[1] === "<" ? "gt" : "lt"]: `now-${a}${unit}` };
  return m[3]
    ? { gte: `now-${b}${unit}`, lte: `now-${a}${unit}` }
    : {
        gte: `now-${a}${unit}/${unit}`,
        lt: `now-${a}${unit}+1${unit}/${unit}`,
      };
}
async function resolveTag(db: DB, name: string, kind?: string) {
  const rows = (
    await db.query(
      "SELECT id FROM catalog_tags WHERE lower(name)=lower($1) AND ($2::text IS NULL OR kind=$2)",
      [name, kind ?? null],
    )
  ).rows;
  if (!rows.length) return { match: { tag: { query: name, operator: "and" } } };
  // A synonym is an entry point to its canonical filter, which also contains
  // works tagged with any of the other synonyms and descendant meta-tags.
  const ids = (
    await db.query(
      `WITH RECURSIVE resolved(id) AS (SELECT unnest($1::text[]) UNION SELECT e.parent FROM catalog_tag_edges e JOIN resolved r ON r.id=e.child WHERE e.kind='synonym') SELECT id FROM resolved WHERE NOT EXISTS(SELECT 1 FROM catalog_tag_edges e WHERE e.child=resolved.id AND e.kind='synonym')`,
      [rows.map((r) => r.id)],
    )
  ).rows.map((r) => r.id);
  return { terms: { filter_ids: ids.length ? ids : rows.map((r) => r.id) } };
}
const split = (value: string | undefined) =>
  value
    ? value
        .split(/\n|,/)
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
export async function searchWorks(db: DB, x: any) {
  if (await ensureSearchIndex())
    await db.query(
      "INSERT INTO catalog_text_pending SELECT work_id FROM catalog_documents ON CONFLICT DO NOTHING",
    );
  const must: any[] = [],
    filter: any[] = [],
    must_not: any[] = [];
  filter.push({
    term: {
      epoch: (
        await db.query("SELECT epoch FROM catalog_search_state WHERE id=1")
      ).rows[0].epoch,
    },
  });
  must_not.push({ term: { alias: true } });
  const query = (text: string, fields: string[]) => ({
    query_string: {
      query: text
        .replace(/\bcreator:/g, "creators:")
        .replace(/\bid:/g, "external_id:")
        .replace(/\bin_anon_collection:/g, "anonymous:")
        .replace(/\bin_unrevealed_collection:/g, "unrevealed:")
        .replace(/\btitle_to_sort_on:/g, "sort_title:")
        .replace(/\bauthors_to_sort_on:/g, "sort_authors:")
        .replace(/(?<!\\)\//g, "\\/"),
      fields,
      default_operator: "AND",
      lenient: false,
    },
  });
  if (x.q)
    must.push(
      query(x.q, [
        "creators^5",
        "title^7",
        "summary",
        "notes",
        "endnotes",
        "tag",
        "series.title",
      ]),
    );
  if (x.title) must.push(query(x.title, ["title"]));
  if (x.creators) must.push(query(x.creators, ["creators"]));
  if (x.fulltext) must.push(query(x.fulltext, ["text.*"]));
  for (const kind of tagKinds)
    for (const name of split(x[kind]))
      filter.push(await resolveTag(db, name, kind));
  for (const name of split(x.include)) filter.push(await resolveTag(db, name));
  for (const name of split(x.exclude))
    must_not.push(await resolveTag(db, name));
  if (x.tag) {
    const row = (
      await db.query("SELECT name,kind FROM catalog_tags WHERE id=$1", [x.tag])
    ).rows[0];
    filter.push(
      row ? await resolveTag(db, row.name, row.kind) : { match_none: {} },
    );
  }
  if (x.entity) filter.push({ term: { entity_ids: x.entity } });
  for (const field of ["series", "collections"])
    if (x[field])
      filter.push({
        terms: {
          entity_ids: (
            await db.query(
              "SELECT id FROM catalog_entities WHERE kind=$1 AND name=$2",
              [field === "series" ? "series" : "collection", x[field]],
            )
          ).rows.map((r) => r.id),
        },
      });
  const languages = [
    ...new Set(
      (x.language ?? "")
        .split("\n")
        .map((v: string) => v.trim())
        .filter(Boolean),
    ),
  ];
  if (languages.length)
    filter.push({
      bool: {
        should: [
          { terms: { language: languages } },
          { terms: { language_id: languages } },
        ],
        minimum_should_match: 1,
      },
    });
  for (const field of ["complete", "crossover", "restricted"])
    if (["true", "false"].includes(x[field]))
      filter.push({ term: { [field]: x[field] === "true" } });
  if (x.singleChapter === "true")
    filter.push({ term: { expected_number_of_chapters: 1 } });
  if (x.availability === "deleted")
    filter.push({ term: { availability: "deleted" } });
  for (const [input, field] of Object.entries({
    words: "word_count",
    hits: "hits",
    kudos: "kudos_count",
    comments: "comments_count",
    bookmarks: "bookmarks_count",
  }))
    if (x[input]) filter.push({ range: { [field]: numericRange(x[input]) } });
  if (x.wordsFrom !== undefined || x.wordsTo !== undefined)
    filter.push({
      range: {
        word_count: {
          ...(x.wordsFrom !== undefined ? { gte: x.wordsFrom } : {}),
          ...(x.wordsTo !== undefined ? { lte: x.wordsTo } : {}),
        },
      },
    });
  if (x.dateFrom || x.dateTo)
    filter.push({
      range: {
        revised_at: {
          ...(x.dateFrom ? { gte: x.dateFrom } : {}),
          ...(x.dateTo ? { lte: x.dateTo } : {}),
        },
      },
    });
  if (x.updatedWithin)
    filter.push({ range: { revised_at: relativeRange(x.updatedWithin) } });
  const sortFields: Record<string, string> = {
    relevance: "_score",
    title: "sort_title",
    creators: "sort_authors",
    published: "created_at",
    updated: "revised_at",
    words: "word_count",
    hits: "hits",
    kudos: "kudos_count",
    comments: "comments_count",
    bookmarks: "bookmarks_count",
    archived: "archived_at",
    series: "memberships.position",
  };
  const entityKind = x.entity
    ? (
        await db.query("SELECT kind FROM catalog_entities WHERE id=$1", [
          x.entity,
        ])
      ).rows[0]?.kind
    : null;
  const sortName =
      x.sort ??
      (entityKind === "series"
        ? "series"
        : x.q || x.fulltext
          ? "relevance"
          : "updated"),
    direction =
      x.direction ??
      (["title", "creators", "series"].includes(sortName) ? "asc" : "desc");
  const sort = [
    {
      [sortFields[sortName]]:
        sortName === "relevance"
          ? { order: direction }
          : {
              order: direction,
              missing: "_last",
              ...(sortName === "series"
                ? {
                    nested: {
                      path: "memberships",
                      filter: { term: { "memberships.id": x.entity ?? "" } },
                    },
                  }
                : {}),
            },
    },
    { ao3_id: { order: direction, missing: "_last" } },
    { id: direction },
  ];
  const filtered = { bool: { must, filter, must_not } };
  const queryHash = createHash("sha256")
    .update(JSON.stringify({ filtered, sort }))
    .digest("hex");
  let pit: string, after: any[] | undefined;
  if (x.cursor) {
    let c: any;
    try {
      c = JSON.parse(Buffer.from(x.cursor, "base64url").toString());
    } catch {
      fail("INVALID_INPUT", 400);
    }
    if (c.q !== queryHash || typeof c.p !== "string" || !Array.isArray(c.a))
      fail("INVALID_INPUT", 400);
    pit = c.p;
    after = c.a;
  } else
    pit = (
      await searchRequest(
        "/" + SEARCH_INDEX + "/_search/point_in_time?keep_alive=5m",
      )
    ).pit_id;
  const aggs: any = {};
  for (const kind of [...tagKinds, "language"])
    aggs[kind] = { terms: { field: kind, size: 15 } };
  let result: any,
    items: any[] = [],
    next: string | null = null;
  // Fill a page past stale derived documents without treating an older indexed
  // snapshot as current. PIT fixes order; PostgreSQL remains authoritative.
  try {
    while (items.length < 21) {
      result = await searchWithFacets({
        pit: { id: pit, keep_alive: "5m" },
        size: 21 - items.length,
        query: filtered,
        sort,
        search_after: after,
        track_total_hits: true,
        _source: false,
        docvalue_fields: ["generation"],
        aggs,
      });
      const hits = result.hits.hits;
      if (!hits.length) break;
      const docs = (
        await db.query(
          "SELECT work_id AS id,snapshot_id,metadata,bibliography,generation FROM catalog_documents WHERE work_id=ANY($1::uuid[])",
          [hits.map((h: any) => h._id)],
        )
      ).rows;
      const byId = new Map(docs.map((r) => [r.id, r]));
      for (const h of hits) {
        const doc = byId.get(h._id);
        if (doc && doc.generation === h.fields?.generation?.[0])
          items.push({ ...doc, sort: h.sort });
      }
      after = hits.at(-1).sort;
      if (hits.length < 21 - items.length) break;
    }
  } catch (error) {
    if (!x.cursor)
      await searchRequest(
        "/_search/point_in_time",
        { pit_id: [pit] },
        "DELETE",
      ).catch(() => {});
    throw error;
  }
  if (items.length > 20)
    next = Buffer.from(
      JSON.stringify({ q: queryHash, p: pit, a: items[19].sort }),
    ).toString("base64url");
  if (!next && !x.cursor)
    await searchRequest(
      "/_search/point_in_time",
      { pit_id: [pit] },
      "DELETE",
    ).catch(() => {});
  const indexing = (
    await db.query(
      "SELECT EXISTS(SELECT 1 FROM catalog_pending UNION ALL SELECT 1 FROM catalog_text_pending UNION ALL SELECT 1 FROM catalog_graph_pending) AS yes",
    )
  ).rows[0].yes;
  return {
    items: items.slice(0, 20),
    next,
    total: result.hits.total.value,
    indexing,
    facets: Object.fromEntries(
      Object.entries(result.aggregations ?? {}).map(([k, v]: any) => [
        k,
        v.buckets.map((b: any) => ({ name: b.key, count: b.doc_count })),
      ]),
    ),
  };
}
