// Post-benchmark fault/contract probes on a retained, private P1A fixture only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { pool, migrate } = require("../apps/api/dist/db");
const { projectCatalog, projectText } = require("../apps/api/dist/catalog");
const { scheduleSync } = require("../apps/api/dist/ao3-scheduler");
const {
  runProjection,
  startProjections,
} = require("../apps/api/dist/operations-index");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    assert.ok(Date.now() < end, "Probe deadline");
    await sleep(20);
  }
}
const counts = async () =>
  (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM catalog_pending) c,(SELECT count(*)::int FROM catalog_snapshot_pending) h,(SELECT count(*)::int FROM catalog_text_pending) t`,
    )
  ).rows[0];
const empty = async () => Object.values(await counts()).every((n) => n === 0);
const report = {};
let stop;
(async () => {
  await migrate();
  assert.ok(await empty());
  const idleSetting = process.env.PROJECTION_IDLE_MS;
  process.env.PROJECTION_IDLE_MS = "0";
  assert.throws(
    () => startProjections(projectCatalog, projectText),
    /Invalid PROJECTION_IDLE_MS/,
  );
  if (idleSetting === undefined) delete process.env.PROJECTION_IDLE_MS;
  else process.env.PROJECTION_IDLE_MS = idleSetting;
  const before = (
    await pool.query(
      `SELECT (SELECT count(*) FROM archive_snapshot_data) snapshots,(SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_outbox) events,(SELECT md5(string_agg(metadata::text || bibliography::text, '' ORDER BY snapshot_id)) FROM catalog_snapshot_views) historical_digest`,
    )
  ).rows[0];
  const work = (
    await pool.query(
      `SELECT h.id,h.external_id,h.current_snapshot_id FROM archive_work_heads h WHERE NOT EXISTS(SELECT 1 FROM ao3_jobs j JOIN ao3_runs r ON r.job_id=j.id WHERE j.kind='work' AND j.target=h.external_id) ORDER BY h.id LIMIT 1`,
    )
  ).rows[0];
  // Roll back all trigger probes: no seed/sync state is fabricated for the benchmark.
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM ao3_jobs WHERE kind='work' AND target=$1", [
      work.external_id,
    ]);
    await db.query("INSERT INTO ao3_jobs(kind,target) VALUES('work',$1)", [
      work.external_id,
    ]);
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0].n,
      0,
    );
    await db.query(
      "UPDATE ao3_jobs SET availability='unknown',checked_at=now() WHERE kind='work' AND target=$1",
      [work.external_id],
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0].n,
      0,
    );
    for (const availability of [
      "available",
      "hidden_or_restricted",
      "temporarily_unavailable",
      "deleted",
      "unknown",
    ]) {
      await db.query("DELETE FROM catalog_pending");
      await db.query(
        "UPDATE ao3_jobs SET availability=$2 WHERE kind='work' AND target=$1",
        [work.external_id, availability],
      );
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0]
          .n,
        1,
      );
      await db.query("DELETE FROM catalog_pending");
      await db.query(
        "UPDATE ao3_jobs SET availability=$2 WHERE kind='work' AND target=$1",
        [work.external_id, availability],
      );
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0]
          .n,
        0,
      );
    }
    await db.query("DELETE FROM ao3_jobs WHERE kind='work' AND target=$1", [
      work.external_id,
    ]);
    await db.query(
      "INSERT INTO ao3_jobs(kind,target,availability) VALUES('work',$1,'deleted')",
      [work.external_id],
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM catalog_pending")).rows[0].n,
      1,
    );
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  report.informative_trigger = true;
  // Full seeding cycle, including a watched work ahead of the cursor, with no projection.
  await pool.query("UPDATE ao3_control SET seed_cursor=NULL");
  await pool.query(
    `INSERT INTO ao3_watch(work_id,last_open_at,watch_until,next_due_at) VALUES($1,now(),now()+interval '48 hours',now()) ON CONFLICT(work_id) DO UPDATE SET watch_until=excluded.watch_until`,
    [work.id],
  );
  for (let i = 0; i < 45; i++) await scheduleSync();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM archive_work_heads h LEFT JOIN ao3_jobs j ON j.kind='work' AND j.target=h.external_id WHERE h.external_id IS NOT NULL AND j.id IS NULL",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT priority FROM ao3_jobs WHERE kind='work' AND target=$1",
        [work.external_id],
      )
    ).rows[0].priority,
    15,
  );
  assert.ok(await empty());
  report.seed_and_watch = true;
  const historicBefore = (
    await pool.query(
      "SELECT metadata,bibliography FROM catalog_snapshot_views WHERE snapshot_id=$1",
      [work.current_snapshot_id],
    )
  ).rows[0];
  const original = (
    await pool.query(
      "SELECT availability FROM ao3_jobs WHERE kind='work' AND target=$1",
      [work.external_id],
    )
  ).rows[0].availability;
  await pool.query(
    "UPDATE ao3_jobs SET availability='deleted' WHERE kind='work' AND target=$1",
    [work.external_id],
  );
  await runProjection("catalog", projectCatalog);
  await runProjection("search", projectText);
  assert.equal(
    (
      await pool.query(
        "SELECT metadata FROM catalog_documents WHERE work_id=$1",
        [work.id],
      )
    ).rows[0].metadata.availability,
    "deleted",
  );
  assert.equal(
    (
      await searchRequest(
        "/" + SEARCH_INDEX + "/_doc/" + work.id,
        undefined,
        "GET",
      )
    )._source.availability,
    "deleted",
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT metadata,bibliography FROM catalog_snapshot_views WHERE snapshot_id=$1",
        [work.current_snapshot_id],
      )
    ).rows[0],
    historicBefore,
  );
  await pool.query(
    "UPDATE ao3_jobs SET availability=$2 WHERE kind='work' AND target=$1",
    [work.external_id, original],
  );
  await runProjection("catalog", projectCatalog);
  await runProjection("search", projectText);
  report.availability_search_and_immutable_history = true;
  // Hold the document UPDATE after the projector has read availability.
  const documentLock = await pool.connect();
  await documentLock.query("BEGIN");
  await documentLock.query(
    "SELECT 1 FROM catalog_documents WHERE work_id=$1 FOR UPDATE",
    [work.id],
  );
  await pool.query("INSERT INTO catalog_pending VALUES($1)", [work.id]);
  const projectingAvailability = projectCatalog();
  let changingAvailability;
  try {
    await until(
      async () =>
        (
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO catalog_documents%') yes",
          )
        ).rows[0].yes,
    );
    changingAvailability = pool.query(
      "UPDATE ao3_jobs SET availability='deleted' WHERE kind='work' AND target=$1",
      [work.external_id],
    );
    await sleep(100);
  } finally {
    await documentLock.query("COMMIT");
    documentLock.release();
  }
  await projectingAvailability;
  await changingAvailability;
  assert.equal((await counts()).c, 1);
  await projectCatalog();
  await projectText();
  assert.equal(
    (
      await searchRequest(
        "/" + SEARCH_INDEX + "/_doc/" + work.id,
        undefined,
        "GET",
      )
    )._source.availability,
    "deleted",
  );
  await pool.query(
    "UPDATE ao3_jobs SET availability=$2 WHERE kind='work' AND target=$1",
    [work.external_id, original],
  );
  await projectCatalog();
  await projectText();
  report.availability_during_projection_survives_ack = true;
  // A new invalidation arriving while an older PUT is in flight must survive ACK.
  await pool.query("INSERT INTO catalog_text_pending VALUES($1)", [work.id]);
  const originalFetch = global.fetch;
  let reached = false,
    release;
  const held = new Promise((r) => {
    release = r;
  });
  global.fetch = async (...args) => {
    if (String(args[0]).includes("/_doc/") && args[1]?.method === "PUT") {
      reached = true;
      await held;
    }
    return originalFetch(...args);
  };
  try {
    const indexing = projectText(1);
    await until(() => reached);
    await pool.query(
      "UPDATE ao3_jobs SET availability='deleted' WHERE kind='work' AND target=$1",
      [work.external_id],
    );
    const projecting = projectCatalog();
    await until(
      async () =>
        (
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO catalog_text_pending%') yes",
          )
        ).rows[0].yes,
    );
    release();
    await indexing;
    await projecting;
  } finally {
    release();
    global.fetch = originalFetch;
  }
  assert.equal((await counts()).t, 1);
  await projectText();
  assert.equal(
    (
      await searchRequest(
        "/" + SEARCH_INDEX + "/_doc/" + work.id,
        undefined,
        "GET",
      )
    )._source.availability,
    "deleted",
  );
  await pool.query(
    "UPDATE ao3_jobs SET availability=$2 WHERE kind='work' AND target=$1",
    [work.external_id, original],
  );
  await projectCatalog();
  await projectText();
  report.invalidation_during_put_survives_ack = true;
  await pool.query(
    "INSERT INTO catalog_text_pending SELECT work_id FROM catalog_documents ORDER BY work_id LIMIT 2",
  );
  let textStopped = false;
  global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).includes("/_doc/") && args[1]?.method === "PUT")
      textStopped = true;
    return response;
  };
  try {
    assert.equal(await projectText(16, () => textStopped), 1);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal((await counts()).t, 1);
  await projectText();
  report.text_stop_preserves_next_document = true;

  // Small bounded batches make fairness, backpressure and continuous progress observable.
  Object.assign(process.env, {
    PROJECTION_CATALOG_BATCH: "2",
    PROJECTION_HISTORICAL_BATCH: "2",
    PROJECTION_TEXT_BATCH: "2",
    PROJECTION_TEXT_HIGH_WATER: "8",
    PROJECTION_IDLE_MS: "50",
  });
  await pool.query(
    "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ORDER BY id LIMIT 80 ON CONFLICT DO NOTHING",
  );
  await pool.query(
    "INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshots ORDER BY id LIMIT 80 ON CONFLICT DO NOTHING",
  );
  await pool.query("UPDATE operations_index SET paused=true");
  const initial = await counts();
  stop = startProjections(projectCatalog, projectText);
  await sleep(200);
  assert.deepEqual(await counts(), initial);
  await pool.query(
    "UPDATE operations_index SET paused=false WHERE kind='catalog'",
  );
  await until(async () => (await counts()).h === 0);
  let q = await counts();
  assert.ok(
    q.c > 0 && q.t >= 8 && q.t <= 10,
    "History progresses while current is backpressured",
  );
  await stop();
  stop = undefined;
  report.pause_and_backpressure_historical_fairness = true;
  await pool.query(
    "UPDATE operations_index SET paused=false,retry_at=now()+interval '1 minute' WHERE kind='search'",
  );
  assert.equal(await runProjection("search", projectText), 0);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(70210473)");
  await pool.query(
    "UPDATE operations_index SET retry_at=NULL WHERE kind='search'",
  );
  assert.equal(await runProjection("search", projectText), 0);
  await lock.query("SELECT pg_advisory_unlock(70210473)");
  lock.release();
  await runProjection("search", async () => {
    throw Error("injected");
  });
  assert.equal(
    (await pool.query("SELECT state FROM operations_index WHERE kind='search'"))
      .rows[0].state,
    "failed",
  );
  assert.equal(await runProjection("search", projectText), 0);
  await pool.query("UPDATE operations_index SET retry_at=NULL");
  report.retry_and_replica_lock = true;
  // Kill a genuine scheduler process inside an active catalog transaction.
  const blocker = await pool.connect();
  await blocker.query("SELECT pg_advisory_lock(70210408)");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {startProjections}=require('./apps/api/dist/operations-index');const {projectCatalog,projectText}=require('./apps/api/dist/catalog');startProjections(projectCatalog,projectText);`,
    ],
    { stdio: "ignore", env: process.env },
  );
  try {
    await until(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND objid=70210408 AND NOT granted",
          )
        ).rows[0].n > 0,
    );
    child.kill("SIGKILL");
    await once(child, "exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await blocker.query("SELECT pg_advisory_unlock(70210408)");
    blocker.release();
  }
  assert.ok((await counts()).c > 0);
  const start = performance.now();
  Object.assign(process.env, { PROJECTION_CONCURRENCY: "1" });
  const turns = [];
  stop = startProjections(async (...args) => {
    const turn = { start: performance.now() };
    turns.push(turn);
    const n = await projectCatalog(...args);
    turn.end = performance.now();
    return n;
  }, projectText);
  await until(empty);
  await stop();
  stop = undefined;
  report.crash_recovery_seconds = (performance.now() - start) / 1000;
  assert.ok(turns.length > 2);
  const gaps = turns.slice(1).map((t, i) => t.start - turns[i].end);
  report.continuous_batch_gap_max_ms = Math.max(...gaps);
  assert.ok(
    gaps.some((g) => g < 250),
    "Backlog continues without the former one-second timer",
  );
  report.clean_stop_and_single_lane_recovery = true;
  // Shutdown must wait for an active batch and leave subsequent work durable.
  await pool.query("INSERT INTO catalog_pending VALUES($1)", [work.id]);
  let entered = false,
    finishBatch;
  const batchGate = new Promise((r) => {
    finishBatch = r;
  });
  stop = startProjections(async (...args) => {
    entered = true;
    await batchGate;
    return projectCatalog(...args);
  }, projectText);
  await until(() => entered);
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await sleep(100);
  assert.equal(stopped, false);
  finishBatch();
  await stopping;
  stop = undefined;
  assert.equal((await counts()).c, 0);
  assert.equal((await counts()).t, 1);
  report.stop_waits_for_atomic_batch = true;
  for (const mode of ["maintenance_light", "maintenance_full", "normal"]) {
    await pool.query("UPDATE instance SET maintenance_mode=$1", [mode]);
    await sleep(1100);
    assert.equal(
      (await require("../apps/api/dist/maintenance").processingPolicy()).mode,
      mode,
    );
    await pool.query(
      "INSERT INTO catalog_pending VALUES($1) ON CONFLICT DO NOTHING",
      [work.id],
    );
    stop = startProjections(projectCatalog, projectText);
    await until(empty);
    await stop();
    stop = undefined;
  }
  report.maintenance = true;
  let idleCalls = 0;
  stop = startProjections(async (...args) => {
    idleCalls++;
    return projectCatalog(...args);
  }, projectText);
  await sleep(180);
  await stop();
  stop = undefined;
  assert.ok(
    idleCalls >= 1 && idleCalls <= 4,
    "Empty queues sleep instead of spinning",
  );
  const stoppedCalls = idleCalls;
  await sleep(100);
  assert.equal(idleCalls, stoppedCalls);
  report.idle_calls_in_180ms = idleCalls;
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
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
      assert.equal(hit._source.generation, expected.get(hit._id));
      assert.ok(expected.delete(hit._id));
      seen++;
    }
    after = page.hits.hits.at(-1).sort;
  }
  assert.equal(expected.size, 0);
  assert.equal(seen, 11032);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM archive_snapshot_data) snapshots,(SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_outbox) events,(SELECT md5(string_agg(metadata::text || bibliography::text, '' ORDER BY snapshot_id)) FROM catalog_snapshot_views) historical_digest`,
      )
    ).rows[0],
    before,
  );
  report.all_current_generations_verified = seen;
  report.canonical_counts_and_events_preserved = true;
  fs.writeFileSync(
    "/results/p1a-functional.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop?.();
    await pool.end();
  });
