const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
const {
  searchWorks,
  searchRequest,
} = require("../apps/api/dist/catalog-search");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const seen = new Set(),
    pits = new Set();
  let cursor,
    pages = 0;
  try {
    do {
      const page = await searchWorks(pool, {
        sort: "title",
        direction: "asc",
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
      }
      cursor = page.next;
      if (cursor)
        pits.add(JSON.parse(Buffer.from(cursor, "base64url").toString()).p);
      assert.ok(++pages < 1000);
    } while (cursor);
    const expected = (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_documents d WHERE NOT EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=d.work_id)",
      )
    ).rows[0].n;
    assert.equal(seen.size, expected);
    fs.writeFileSync(
      "/results/search-semantics.json",
      JSON.stringify({
        pages,
        works: seen.size,
        no_duplicates: true,
        all_current_generations_visible: true,
        source_not_requested: true,
      }),
    );
  } finally {
    if (pits.size)
      await searchRequest(
        "/_search/point_in_time",
        { pit_id: [...pits] },
        "DELETE",
      );
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
