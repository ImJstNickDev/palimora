// Real application entrypoints: API timers and BullMQ ingest worker unchanged.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { pool, migrate } = require("../apps/api/dist/db");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const children = [];
function launch(name, file) {
  const fd = fs.openSync("/results/" + name + ".log", "w");
  const child = spawn(
    process.execPath,
    ["--require", "/app/scripts/performance-profiler.cjs", file],
    {
      env: {
        ...process.env,
        P0_PROFILE: "/results/" + name + "-profile.json",
        PGAPPNAME: name === "worker" ? "palimora-ingest" : "palimora-api",
      },
      stdio: ["ignore", fd, fd],
    },
  );
  fs.closeSync(fd);
  children.push(child);
  return child;
}
(async () => {
  await migrate();
  execFileSync(process.execPath, [
    "scripts/performance-snapshot.cjs",
    "before",
  ]);
  const searchSampler = spawn(
    process.execPath,
    ["scripts/performance-opensearch.cjs"],
    { stdio: "ignore" },
  );
  children.push(searchSampler);
  const queueSampler = spawn(
    process.execPath,
    ["scripts/performance-queues.cjs"],
    { stdio: "ignore" },
  );
  children.push(queueSampler);
  const sampler = spawn("python3", ["scripts/performance-processes.py"], {
    stdio: "ignore",
  });
  children.push(sampler);
  if (process.env.P2D_DIAGNOSTICS === "1")
    children.push(
      spawn(process.execPath, ["scripts/performance-postgres.cjs"], {
        stdio: "ignore",
      }),
    );
  launch("api", "apps/api/dist/main.js");
  launch("worker", "apps/api/dist/ingest-worker.js");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch("http://localhost:3000/api/v1/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw Error("API readiness timeout");
  const id = randomUUID(),
    start = performance.now(),
    started_at_ms = Date.now(),
    timeline = [];
  await pool.query(
    "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,false)",
    [id, ["queue119_archive05.zip"]],
  );
  let complete = false;
  while (performance.now() - start < 3600000) {
    if (children.some((c) => c.exitCode !== null || c.signalCode !== null))
      throw Error("Application process exited");
    const row = (
      await pool.query(
        `SELECT state,extract(epoch from started_at)*1000 processing_started_at_ms,extract(epoch from finished_at)*1000 processing_finished_at_ms,extract(epoch from(started_at-created_at))::float queue_seconds,extract(epoch from(finished_at-started_at))::float processing_seconds,(SELECT count(*) FROM archive_work_heads)::int works,(SELECT count(*) FROM catalog_documents)::int documents,(SELECT count(*) FROM catalog_pending)::int catalog,(SELECT count(*) FROM catalog_snapshot_pending)::int historical,(SELECT count(*) FROM catalog_text_pending)::int text FROM ingest_batches WHERE id=$1`,
        [id],
      )
    ).rows[0];
    timeline.push({ seconds: (performance.now() - start) / 1000, ...row });
    fs.writeFileSync("/results/timeline.json", JSON.stringify(timeline));
    if (
      row.state === "completed" &&
      row.works === 11032 &&
      row.documents === 11032 &&
      row.catalog + row.historical + row.text === 0
    ) {
      complete = true;
      break;
    }
    if (
      ["failed_global", "parser_blocked", "completed_with_gaps"].includes(
        row.state,
      )
    )
      throw Error("Unexpected batch state " + row.state);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!complete) throw Error("Pipeline deadline");
  execFileSync(process.execPath, ["scripts/benchmark-performance-verify.cjs"]);
  const seconds = (performance.now() - start) / 1000;
  const ended_at_ms = Date.now();
  execFileSync(process.execPath, ["scripts/performance-snapshot.cjs", "after"]);
  fs.writeFileSync(
    "/results/end-to-end.json",
    JSON.stringify(
      {
        scenario: "B",
        started_at_ms,
        ended_at_ms,
        work_start_to_visible_seconds:
          (ended_at_ms - Number(timeline.at(-1).processing_started_at_ms)) /
          1000,
        seconds,
        works_per_second: 11032 / seconds,
        last: timeline.at(-1),
        configuration: {
          projection_mode: process.env.PROJECTION_MODE ?? "inline",
          parsers: process.env.INGEST_PARSER_WORKERS,
          commits: process.env.INGEST_COMMIT_CONCURRENCY,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      scenario: "B",
      seconds,
      works_per_second: 11032 / seconds,
    }),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once("exit", resolve);
            setTimeout(() => child.kill("SIGKILL"), 15000).unref();
          }),
      ),
    );
    await pool.end();
  });
