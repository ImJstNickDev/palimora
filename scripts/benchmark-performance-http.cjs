// Warm authenticated API latency, separate from end-to-end completion time.
const fs = require("node:fs");
const assert = require("node:assert/strict");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const base = "http://127.0.0.1:3000/api/v1";
  const pits = new Set();
  const login = await fetch(base + "/auth/login", {
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
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join(";");
  async function get(path) {
    const r = await fetch(base + path, { headers: { cookie } });
    assert.equal(r.status, 200);
    const value = await r.json();
    if (path === "/works" && value.next)
      pits.add(JSON.parse(Buffer.from(value.next, "base64url")).p);
    return value;
  }
  const catalog = await get("/works");
  const id = catalog.items[0].id;
  const queues = async () =>
    (
      await require("../apps/api/dist/db").pool.query(
        "SELECT (SELECT count(*)::int FROM catalog_pending) current,(SELECT count(*)::int FROM catalog_snapshot_pending) historical,(SELECT count(*)::int FROM catalog_text_pending) text",
      )
    ).rows[0];
  const searchStats = async () => {
    if (process.env.P2C_EVENT_LOOP !== "1") return undefined;
    const response = await fetch(
      "http://opensearch:9200/_nodes/stats/jvm,process,indices?filter_path=nodes.*.jvm.gc.collectors,nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.process.cpu.total_in_millis,nodes.*.indices.indexing,nodes.*.indices.refresh,nodes.*.indices.merges,nodes.*.indices.search.open_contexts,nodes.*.indices.segments.count",
    );
    assert.ok(response.ok);
    return Object.values((await response.json()).nodes)[0];
  };
  const windows = {};
  const result = {
    transport: "internal HTTP, authenticated; no gateway",
    samples: 100,
  };
  for (const [kind, path] of Object.entries({
    search: "/works",
    work: "/works/" + id,
    reader: "/works/" + id + "/read",
  })) {
    for (let i = 0; i < 3; i++) await get(path);
    const times = [];
    const before =
      process.env.P2C_HTTP_QUEUES === "1" ? await queues() : undefined;
    const opensearch_before = await searchStats();
    const started_at = Date.now();
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await get(path);
      times.push(performance.now() - t);
    }
    if (before)
      windows[kind] = {
        started_at,
        ended_at: Date.now(),
        before,
        after: await queues(),
        ...(opensearch_before
          ? { opensearch_before, opensearch_after: await searchStats() }
          : {}),
      };
    times.sort((a, b) => a - b);
    result[kind] = {
      mean_ms: times.reduce((a, b) => a + b, 0) / 100,
      p50_ms: times[49],
      p95_ms: times[94],
      max_ms: times[99],
    };
  }
  if (pits.size)
    await require("../apps/api/dist/catalog-search").searchRequest(
      "/_search/point_in_time",
      { pit_id: [...pits] },
      "DELETE",
    );
  if (process.env.P2C_HTTP_QUEUES === "1") {
    result.windows = windows;
    await require("../apps/api/dist/db").pool.end();
  }
  fs.writeFileSync(
    "/results/http-latency.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
