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
const workload = Number(process.env.BENCH_LATENCY_WORKS ?? 1000);
const textOnly = process.env.BENCH_LATENCY_TEXT_ONLY === "1";
const regenerateHistory = process.env.BENCH_REGENERATE_HISTORY === "1";
assert.ok(!textOnly || !regenerateHistory);
assert.ok(Number.isInteger(workload) && workload >= 1000 && workload <= 11032);
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
    env: {
      ...process.env,
      ...(process.env.P2C_LATENCY_PROFILE
        ? { P0_PROFILE: process.env.P2C_LATENCY_PROFILE }
        : {}),
    },
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
  const idle = {};
  if (process.env.P2C_IDLE_SECONDS) {
    const seconds = Number(process.env.P2C_IDLE_SECONDS);
    assert.ok(seconds >= 30 && seconds <= 300);
    idle.started_at = Date.now();
    await delay(seconds * 1000);
    idle.ended_at = Date.now();
    assert.ok(Object.values(await queues()).every((n) => n === 0));
  }
  execFileSync(process.execPath, ["scripts/benchmark-performance-http.cjs"]);
  fs.renameSync("/results/http-latency.json", "/results/http-idle.json");
  if (regenerateHistory)
    await pool.query(
      "DELETE FROM catalog_snapshot_views WHERE snapshot_id IN (SELECT id FROM archive_snapshots ORDER BY id LIMIT $1)",
      [workload],
    );
  // Default retains the P1A probe. Larger controlled backlog can keep both
  // bibliography queues nonempty after the faster bulk projection.
  if (textOnly) {
    await pool.query(
      "INSERT INTO catalog_text_pending SELECT id FROM archive_work_heads ORDER BY id LIMIT $1",
      [workload],
    );
  } else {
    await pool.query(
      "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ORDER BY id LIMIT $1",
      [workload],
    );
    await pool.query(
      "INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshots ORDER BY id LIMIT $1",
      [workload],
    );
  }
  const before = await queues();
  execFileSync(process.execPath, ["scripts/benchmark-performance-http.cjs"]);
  fs.renameSync("/results/http-latency.json", "/results/http-backlog.json");
  const after = await queues();
  assert.ok(
    after.catalog + after.historical + after.text > 0,
    "Backlog must remain throughout HTTP probe",
  );
  if (process.env.BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG === "1")
    assert.ok(
      after.catalog > 0 && after.historical > 0,
      "Both bibliography queues must remain backlogged",
    );
  fs.writeFileSync(
    "/results/latency-load.json",
    JSON.stringify(
      {
        workload,
        textOnly,
        regenerateHistory,
        before,
        after,
        ...(idle.started_at ? { idle } : {}),
      },
      null,
      2,
    ),
  );
  const end = Date.now() + Math.max(300000, workload * 120);
  while (Object.values(await queues()).some((n) => n > 0)) {
    assert.ok(Date.now() < end, "Drain deadline");
    await delay(1000);
  }
  const report = JSON.parse(
    fs.readFileSync("/results/latency-load.json", "utf8"),
  );
  report.drained_at_ms = Date.now();
  report.final_queues = await queues();
  fs.writeFileSync(
    "/results/latency-load.json",
    JSON.stringify(report, null, 2),
  );
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
