// Direct compatibility check against an isolated OpenSearch 2.19.4 clone.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.P2E_TEST_OPENSEARCH;
assert.ok(base, "Set P2E_TEST_OPENSEARCH on an isolated fixture");
async function request(path, body, method = "POST", ndjson = false) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": ndjson ? "application/x-ndjson" : "application/json",
    },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
(async () => {
  const version = await request("/", undefined, "GET");
  assert.equal(version.body.version.number, "2.19.4");
  const opened = await request(
    "/palimora-works-v2/_search/point_in_time?keep_alive=5m",
  );
  assert.equal(opened.status, 200);
  const pit = opened.body.pit_id;
  const q = {
    pit: { id: pit, keep_alive: "5m" },
    size: 0,
    query: { match_all: {} },
    track_total_hits: true,
    aggs: { language: { terms: { field: "language", size: 15 } } },
  };
  const dead = (
    await request("/palimora-works-v2/_search/point_in_time?keep_alive=5m")
  ).body.pit_id;
  await request("/_search/point_in_time", { pit_id: [dead] }, "DELETE");
  const rows = [];
  try {
    const single = await request("/_search", q);
    for (const [name, a, b] of [
      ["valid", q, q],
      ["partial", q, { ...q, aggs: { bad: { terms: { field: "title" } } } }],
      ["expired", q, { ...q, pit: { id: dead, keep_alive: "5m" } }],
    ]) {
      const r = await request(
        "/_msearch?max_concurrent_searches=2",
        [{}, a, {}, b].map(JSON.stringify).join("\n") + "\n",
        "POST",
        true,
      );
      rows.push({ name, status: r.status, body: r.body });
      if (name !== "valid") {
        assert.equal(r.status, 200);
        assert.ok(r.body.responses[1].error);
        assert.ok(!r.body.responses[0].error);
      }
      if (name === "valid") {
        assert.equal(r.status, 200);
        assert.equal(r.body.responses.length, 2);
        for (const x of r.body.responses) {
          assert.ok(!x.error, JSON.stringify(x.error));
          assert.deepEqual(x.aggregations, single.body.aggregations);
          assert.deepEqual(x.hits.total, single.body.hits.total);
        }
      }
    }
  } finally {
    await request("/_search/point_in_time", { pit_id: [pit] }, "DELETE");
    fs.writeFileSync(
      process.env.P2E_TEST_OUTPUT,
      JSON.stringify({ version: version.body.version.number, rows }, null, 2),
    );
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
