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
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await get(path);
      times.push(performance.now() - t);
    }
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
  fs.writeFileSync(
    "/results/http-latency.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
