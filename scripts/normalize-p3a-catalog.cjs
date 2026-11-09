// Comparison only: replace IDs derived from fixture-local work UUIDs by IDs
// scoped to the same external work. Preserve all bibliography/content values.
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db"),
  { key } = require("../apps/api/dist/catalog-bibliography"),
  { searchRequest, SEARCH_INDEX } = require("../apps/api/dist/catalog-search");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Private fixture required");
const hash = (x) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
(async () => {
  const rows = (
    await pool.query(
      "SELECT h.id,coalesce(h.external_id,'provisional:'||h.provisional_key) AS external_id,d.metadata,d.bibliography FROM archive_works h JOIN catalog_documents d ON d.work_id=h.id ORDER BY external_id",
    )
  ).rows;
  const replacements = new Map(),
    ids = new Map(rows.map((r) => [r.id, r.external_id]));
  for (const r of rows)
    for (const e of r.bibliography.entities ?? []) {
      if (e.source_id === null) {
        assert.equal(e.id, key(e.kind, r.id + "\0" + e.name));
        replacements.set(
          e.id,
          key(e.kind, "ao3-work:" + r.external_id + "\0" + e.name),
        );
      }
    }
  const stable = (x) =>
    typeof x === "string"
      ? (replacements.get(x) ?? x)
      : Array.isArray(x)
        ? x.map(stable)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, stable(x[k])]),
            )
          : x;
  const current = hash(
    rows.map((r) => [
      r.external_id,
      stable(r.metadata),
      stable(r.bibliography),
    ]),
  );
  const historicalRows = (
    await pool.query(
      `SELECT h.id,coalesce(h.external_id,'provisional:'||h.provisional_key) AS external_id,v.metadata,v.bibliography,
       (SELECT jsonb_agg(jsonb_build_array(r.source_path,r.locator,r.parser,r.result_hash,r.evidence)
         ORDER BY r.source_path,r.locator,r.parser,r.result_hash) FROM archive_records r WHERE r.snapshot_id=s.id) AS acquisition_key
       FROM catalog_snapshot_views v JOIN archive_snapshots s ON s.id=v.snapshot_id JOIN archive_works h ON h.id=s.work_id ORDER BY external_id`,
    )
  ).rows;
  for (const r of historicalRows)
    for (const e of r.bibliography.entities ?? [])
      if (e.source_id === null) {
        assert.equal(e.id, key(e.kind, r.id + "\0" + e.name));
        replacements.set(
          e.id,
          key(e.kind, "ao3-work:" + r.external_id + "\0" + e.name),
        );
      }
  // An external work can have multiple snapshots. SQL ordering by that work
  // alone is not deterministic; bind each view to its preserved acquisitions
  // and compare a sorted multiset, without discarding any historical value.
  const historical = hash(
    historicalRows
      .map((r) => [
        r.external_id,
        stable(r.acquisition_key),
        stable(r.metadata),
        stable(r.bibliography),
      ])
      .map((r) => JSON.stringify(r))
      .sort(),
  );
  const documents = [];
  let after;
  while (true) {
    const page = await searchRequest("/" + SEARCH_INDEX + "/_search", {
      size: 1000,
      sort: [{ id: "asc" }],
      ...(after ? { search_after: after } : {}),
      query: { match_all: {} },
    });
    if (!page.hits.hits.length) break;
    for (const hit of page.hits.hits) {
      const d = hit._source;
      if (process.env.STORAGE_OMIT_SEARCH_TEXT === "1") delete d.text;
      for (const field of [
        "id",
        "snapshot",
        "generation",
        "epoch",
        "archived_at",
      ])
        delete d[field];
      // Keyword tag arrays are sets for search/facets; their SQL scan order
      // varies with physical layout across independently-created databases.
      for (const field of require("../apps/api/dist/catalog-bibliography")
        .tagKinds)
        if (Array.isArray(d[field])) d[field] = [...d[field]].sort();
      documents.push([ids.get(hit._id), hash(stable(d))]);
    }
    after = page.hits.hits.at(-1).sort;
  }
  documents.sort((a, b) => a[0].localeCompare(b[0]));
  fs.writeFileSync(
    "/results/p3a-normalized-catalog.json",
    JSON.stringify({
      source_text_omitted: process.env.STORAGE_OMIT_SEARCH_TEXT === "1",
      sorted_tag_fields: require("../apps/api/dist/catalog-bibliography")
        .tagKinds,
      works: rows.length,
      historical_views: historicalRows.length,
      documents: documents.length,
      replaced_work_scoped_entity_ids: replacements.size,
      current_sha256: current,
      historical_sha256: historical,
      search_sha256: hash(documents),
    }),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
