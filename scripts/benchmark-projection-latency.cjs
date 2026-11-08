// Separate post-ingest latency probe, using the unchanged P0 authenticated HTTP probe.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { pool } = require("../apps/api/dist/db");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const queues = async () =>
  (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM catalog_pending) catalog,(SELECT count(*)::int FROM catalog_snapshot_pending) historical,(SELECT count(*)::int FROM catalog_text_pending) text",
    )
  ).rows[0];
let child;
(async () => {
  assert.ok(Object.values(await queues()).every((n) => n === 0));
  const fd = fs.openSync("/results/latency-api.log", "w");
  child = spawn(process.execPath, ["apps/api/dist/main.js"], {
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  fs.closeSync(fd);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch("http://localhost:3000/api/v1/health")).ok;
    } catch {}
    if (ready) break;
    await delay(1000);
  }
  assert.ok(ready);
  execFileSync(process.execPath, ["scripts/benchmark-performance-http.cjs"]);
  fs.renameSync("/results/http-latency.json", "/results/http-idle.json");
  // Same 1,000 works and snapshots in both variants of this diagnostic.
  await pool.query(
    "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ORDER BY id LIMIT 1000",
  );
  await pool.query(
    "INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshots ORDER BY id LIMIT 1000",
  );
  const before = await queues();
  execFileSync(process.execPath, ["scripts/benchmark-performance-http.cjs"]);
  fs.renameSync("/results/http-latency.json", "/results/http-backlog.json");
  const after = await queues();
  assert.ok(
    after.catalog + after.historical + after.text > 0,
    "Backlog must remain throughout HTTP probe",
  );
  fs.writeFileSync(
    "/results/latency-load.json",
    JSON.stringify({ before, after }, null, 2),
  );
  const end = Date.now() + 300000;
  while (Object.values(await queues()).some((n) => n > 0)) {
    assert.ok(Date.now() < end, "Drain deadline");
    await delay(1000);
  }
  console.log(JSON.stringify({ latency_verified: true, before, after }));
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
      await once(child, "exit");
      clearTimeout(timeout);
    }
    await pool.end();
  });
