// Small three-reader usability check, after timing and integrity collection.
const fs = require("node:fs"),
  { spawn } = require("node:child_process"),
  assert = require("node:assert/strict");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
const fd = fs.openSync("/results/p3a-readers-api.log", "w");
const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
  env: process.env,
  stdio: ["ignore", fd, fd],
});
fs.closeSync(fd);
(async () => {
  const base = "http://localhost:3000/api/v1";
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
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
  const pits = new Set();
  async function get(path) {
    const r = await fetch(base + path, {
      headers: { cookie },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200);
    const value = await r.json();
    if (path === "/works" && value.next)
      pits.add(JSON.parse(Buffer.from(value.next, "base64url")).p);
    return value;
  }
  const id = (await get("/works")).items[0].id;
  const times = [];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        await get(i % 2 ? "/works/" + id + "/read" : "/works");
        times.push(performance.now() - t);
      }
    }),
  );
  times.sort((a, b) => a - b);
  fs.writeFileSync(
    "/results/p3a-readers.json",
    JSON.stringify({
      concurrency: 3,
      requests: times.length,
      errors: 0,
      p95_ms: times[Math.ceil(times.length * 0.95) - 1],
      max_ms: times.at(-1),
      condition:
        "Post-drain, authenticated search and sample reader; internal HTTP",
    }),
  );
  const { searchRequest } = require("../apps/api/dist/catalog-search");
  if (pits.size)
    await searchRequest(
      "/_search/point_in_time",
      { pit_id: [...pits] },
      "DELETE",
    );
  await require("../apps/api/dist/db").pool.end();
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => child.kill("SIGTERM"));
