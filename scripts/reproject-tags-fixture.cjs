// Post-measurement equivalence, on the isolated copy of the P1A canonical corpus.
const fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
const { projectCatalog, projectText } = require("../apps/api/dist/catalog");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Fixture only");
(async () => {
  await pool.query(
    "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING",
  );
  let current = 0;
  while (true) {
    const n = await projectCatalog(64, 0);
    if (!n) break;
    current += n;
  }
  let indexed = 0;
  while (true) {
    const n = await projectText();
    if (!n) break;
    indexed += n;
  }
  const {
    searchRequest,
    SEARCH_INDEX,
  } = require("../apps/api/dist/catalog-search");
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
  const expected = new Map(
    (
      await pool.query("SELECT work_id,generation FROM catalog_documents")
    ).rows.map((r) => [r.work_id, r.generation]),
  );
  let after,
    seen = 0;
  while (true) {
    const p = await searchRequest("/" + SEARCH_INDEX + "/_search", {
      size: 1000,
      _source: ["generation"],
      sort: [{ id: "asc" }],
      ...(after ? { search_after: after } : {}),
      query: { match_all: {} },
    });
    if (!p.hits.hits.length) break;
    for (const h of p.hits.hits) {
      if (
        expected.get(h._id) !== h._source.generation ||
        !expected.delete(h._id)
      )
        throw Error("Generation mismatch");
      seen++;
    }
    after = p.hits.hits.at(-1).sort;
  }
  if (expected.size || seen !== 11032) throw Error("Missing documents");
  fs.writeFileSync(
    "/results/reprojection.json",
    JSON.stringify({ current, indexed, generations_verified: seen }),
  );
  console.log(JSON.stringify({ current, indexed, generations_verified: seen }));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
