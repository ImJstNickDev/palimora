const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  crypto = require("node:crypto");
const { spawn } = require("node:child_process"),
  { once } = require("node:events");
assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith("_test"));
const { pool } = require("../apps/api/dist/db");
const children = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const variant =
  process.env.SEARCH_PARALLEL_FACETS === "1" ? "parallel" : "original";
assert.ok(["original", "parallel"].includes(variant));
function child(file, label, extra = {}) {
  const fd = fs.openSync("/results/" + label + ".log", "w");
  const c = spawn(process.execPath, [file], {
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      PROJECTION_MODE: "isolated",
      P0_PROFILE: "/results/" + label + ".json",
      NODE_OPTIONS:
        "--require=/app/scripts/performance-p2d.cjs --require=/app/scripts/performance-search-spans.cjs --require=/app/scripts/performance-search-matched.cjs",
      ...extra,
    },
  });
  fs.closeSync(fd);
  children.push(c);
  return c;
}
async function stop(c) {
  if (c.exitCode === null && c.signalCode === null) {
    c.kill("SIGTERM");
    const t = setTimeout(() => c.kill("SIGKILL"), 20000);
    await once(c, "exit");
    clearTimeout(t);
  }
}
async function os(path, body, method = "POST") {
  const r = await fetch("http://opensearch:9200" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(r.ok);
  return r.json();
}
async function stats() {
  return Object.values(
    (
      await os(
        "/_nodes/stats/indices,jvm,process,thread_pool",
        undefined,
        "GET",
      )
    ).nodes,
  )[0];
}
async function pending() {
  return +(await pool.query("SELECT count(*) FROM catalog_text_pending"))
    .rows[0].count;
}
let cookie;
async function api(path, label) {
  const t = performance.now();
  const r = await fetch("http://localhost:3000/api/v1" + path, {
    headers: { cookie, ...(label ? { "x-p2e-sample": label } : {}) },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const ms = performance.now() - t;
  if (body.next) {
    const pit = JSON.parse(Buffer.from(body.next, "base64url")).p;
    await os("/_search/point_in_time", { pit_id: [pit] }, "DELETE");
  }
  return { ms, body };
}
async function login() {
  const r = await fetch("http://localhost:3000/api/v1/auth/login", {
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
  assert.ok(r.ok);
  cookie = r.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join(";");
}
const results = [];
async function window(label, path) {
  for (let i = 0; i < 3; i++) await api(path);
  const before = await stats(),
    q0 = await pending(),
    start = Date.now(),
    mono = performance.now(),
    samples = [],
    nodes = [];
  for (let i = 0; i < 80; i++) {
    await pause(Math.max(0, mono + i * 250 - performance.now()));
    const r = await api(path, label + "-" + i);
    samples.push({
      semantic_hash: crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            items: r.body.items,
            total: r.body.total,
            facets: r.body.facets,
          }),
        )
        .digest("hex"),
      sample: label + "-" + i,
      client_ms: r.ms,
      total: r.body.total,
      items: r.body.items.length,
      ids_hash: crypto
        .createHash("sha256")
        .update(JSON.stringify(r.body.items.map((x) => x.id)))
        .digest("hex"),
    });
    if (i % 8 === 0) nodes.push({ time: Date.now(), node: await stats() });
  }
  await pause(Math.max(0, mono + 20000 - performance.now()));
  const end = Date.now(),
    q1 = await pending(),
    after = await stats();
  results.push({
    label,
    start,
    end,
    before,
    after,
    nodes,
    queue_before: q0,
    queue_after: q1,
    indexed: q0 - q1,
    indexed_per_second: (q0 - q1) / ((end - start) / 1000),
    samples,
  });
  fs.writeFileSync(
    "/results/matched.json",
    JSON.stringify({ variant, results }, null, 2),
  );
}
(async () => {
  assert.equal(await pending(), 0);
  const apiChild = child("apps/api/dist/main.js", "matched-api");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch("http://localhost:3000/api/v1/health")).ok;
    } catch {}
    if (ready) break;
    await pause(1000);
  }
  assert.ok(ready);
  await login();
  const catalog = await api("/works");
  // Derive the same real fandom from a normal reference search, even for the ablation.
  const { transaction } = require("../apps/api/dist/db");
  const search = require("../apps/api/dist/catalog-search");
  let captured;
  const fetchOriginal = global.fetch;
  global.fetch = async (...args) => {
    if (String(args[0]).endsWith("/_search"))
      captured = JSON.parse(args[1].body);
    return fetchOriginal(...args);
  };
  let reference;
  try {
    reference = await transaction((db) => search.searchWorks(db, {}));
  } finally {
    global.fetch = fetchOriginal;
  }
  if (reference.next)
    await os(
      "/_search/point_in_time",
      { pit_id: [JSON.parse(Buffer.from(reference.next, "base64url")).p] },
      "DELETE",
    );
  const fandom = reference.facets.fandom[0].name;
  if (process.env.P2E_EXTRA === "1")
    await require("./check-search-parallel.cjs")(pool, search);
  if (process.env.P2E_CHECK_ONLY === "1") {
    await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["scripts/check-search-msearch.cjs"], {
        stdio: "inherit",
        env: {
          ...process.env,
          P2E_TEST_OPENSEARCH: "http://opensearch:9200",
          P2E_TEST_OUTPUT: "/results/compat.json",
        },
      });
      c.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Compatibility probe failed")),
      );
    });
    return;
  }
  await window("idle", "/works");
  if (process.env.P2E_EXTRA === "1") {
    await window("fandom", "/works?fandom=" + encodeURIComponent(fandom));
    await window("fulltext", "/works?fulltext=love");
  }
  await pool.query(
    "UPDATE operations_index SET paused=true WHERE kind='search'",
  );
  const worker = child(
    "apps/api/dist/projection-worker.js",
    "matched-projection",
    {
      P2E_PACE: process.env.P2E_UNPACED === "1" ? "0" : "1",
      P2E_VARIANT: "full",
    },
  );
  await pause(1500);
  await pool.query(
    `INSERT INTO catalog_text_pending(work_id) SELECT work_id FROM catalog_documents ORDER BY work_id LIMIT ${process.env.P2E_UNPACED === "1" ? 11032 : 800} ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    "UPDATE operations_index SET paused=false WHERE kind='search'",
  );
  await pause(5000);
  await window("backlog", "/works");
  fs.writeFileSync("/results/unpace", "done");
  const deadline = Date.now() + 300000;
  while (await pending()) {
    assert.ok(Date.now() < deadline);
    await pause(100);
  }
  await stop(worker);
  if (process.env.P2E_EXTRA !== "0") {
    await window("overhead", "/works");
    await stop(apiChild);
    child("apps/api/dist/main.js", "uninstrumented-api", {
      NODE_OPTIONS: "--require=/app/scripts/performance-search-matched.cjs",
      P0_PROFILE: "",
    });
    await pause(2000);
    await login();
    await window("overhead_off", "/works");
    const pit = (
      await os(
        "/" + search.SEARCH_INDEX + "/_search/point_in_time?keep_alive=5m",
      )
    ).pit_id;
    const profiles = [];
    try {
      for (const mode of ["original", "parallel"]) {
        const q = structuredClone(captured);
        q.pit = { id: pit, keep_alive: "5m" };
        q.profile = true;
        if (mode === "no-aggs") delete q.aggs;
        const r = await os("/_search", q);
        profiles.push({ mode, took: r.took, profile: r.profile });
      }
    } finally {
      await os("/_search/point_in_time", { pit_id: [pit] }, "DELETE");
    }
    fs.writeFileSync(
      "/results/query-profiles.json",
      JSON.stringify(profiles, null, 2),
    );
  }
  const counts = (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM catalog_documents) documents,(SELECT count(*)::int FROM catalog_text_pending) pending",
    )
  ).rows[0];
  assert.deepEqual(counts, { documents: 11032, pending: 0 });
  fs.writeFileSync(
    "/results/matched-verification.json",
    JSON.stringify(counts),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of children.reverse()) await stop(c);
    await pool.end();
  });
