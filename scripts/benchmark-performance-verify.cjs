// Against the private fixture API; never prints credentials or archived content.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
(async () => {
  const base = "http://127.0.0.1:3000/api/v1";
  let r = await fetch(base + "/auth/setup", {
    method: "POST",
    headers: {
      origin: "https://release.invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      username: "p0owner",
      password: "Private benchmark password 862!",
      name: "P0",
      preferences: { language: "it", theme: "auto", skin: "ink" },
    }),
  });
  if (r.status === 409)
    r = await fetch(base + "/auth/login", {
      method: "POST",
      headers: {
        origin: "https://release.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "p0owner",
        password: "Private benchmark password 862!",
      }),
    });
  assert.ok([200, 201].includes(r.status), "Fixture authentication failed");
  const cookie = r.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join(";");
  async function get(path) {
    const r = await fetch(base + path, { headers: { cookie } });
    assert.equal(r.status, 200);
    return r.json();
  }
  const t = performance.now();
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
  const count = (
    await searchRequest("/" + SEARCH_INDEX + "/_count", undefined, "GET")
  ).count;
  const sql = (
    await pool.query(
      `SELECT (SELECT count(*) FROM archive_work_heads)::int works,(SELECT count(*) FROM archive_snapshots)::int snapshots,(SELECT count(*) FROM catalog_documents)::int documents,(SELECT count(*) FROM catalog_snapshot_views)::int historical_views,(SELECT count(*) FROM catalog_pending)::int pending,(SELECT count(*) FROM catalog_snapshot_pending)::int historical_pending,(SELECT count(*) FROM catalog_text_pending)::int text_pending`,
    )
  ).rows[0];
  assert.equal(count, 11032);
  assert.equal(sql.works, 11032);
  assert.equal(sql.snapshots, 11032);
  assert.equal(sql.documents, 11032);
  assert.equal(sql.historical_views, 11032);
  assert.equal(sql.pending + sql.historical_pending + sql.text_pending, 0);
  const expected = new Map(
    (
      await pool.query("SELECT work_id,generation FROM catalog_documents")
    ).rows.map((r) => [r.work_id, r.generation]),
  );
  let after,
    seen = 0;
  while (true) {
    const page = await searchRequest("/" + SEARCH_INDEX + "/_search", {
      size: 1000,
      _source: ["generation"],
      sort: [{ id: "asc" }],
      ...(after ? { search_after: after } : {}),
      query: { match_all: {} },
    });
    if (!page.hits.hits.length) break;
    for (const hit of page.hits.hits) {
      assert.equal(
        expected.get(hit._id),
        hit._source.generation,
        "Search generation mismatch",
      );
      assert.ok(expected.delete(hit._id));
      seen++;
    }
    after = page.hits.hits.at(-1).sort;
  }
  assert.equal(expected.size, 0);
  assert.equal(seen, 11032);
  const search = await get("/works");
  assert.equal(search.total, 11032);
  const detail = await get("/works/" + search.items[0].id);
  const reader = await get("/works/" + search.items[0].id + "/read");
  assert.ok(reader.document.length > 100);
  const result = {
    sql,
    search_count: count,
    api_count: search.total,
    reader_verified: true,
    all_search_ids_verified: seen,
    all_search_generations_verified: seen,
    refresh_and_verify_seconds: (performance.now() - t) / 1000,
    verified_at: Date.now(),
    monotonic_ns: process.hrtime.bigint().toString(),
  };
  fs.writeFileSync(
    "/results/verification.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
