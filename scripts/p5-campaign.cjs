// One isolated, bounded campaign. Originals are never mounted in this container.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process"),
  { randomUUID, createHash } = require("node:crypto");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !["/benchmark/main", "/benchmark/csv"].includes(process.env.ARCHIVE_ROOT)
)
  throw Error("Private fixture required");
const { pool, migrate } = require("../apps/api/dist/db");
const root = "/results",
  resume = process.env.P5_RESUME === "1",
  report = resume
    ? JSON.parse(fs.readFileSync("/results/completion.json"))
    : { schema: "palimora.p5.completion.v1", categories: [], events: [] },
  started = Date.now();
if (resume) {
  report.controller_retries = [
    ...(report.controller_retries || []),
    report.error,
  ];
  delete report.error;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function save() {
  fs.writeFileSync(
    root +
      (process.argv[2] === "csv" ? "/csv-controller.json" : "/completion.json"),
    JSON.stringify(report, null, 2),
  );
}
function bytes(p) {
  if (!fs.existsSync(p)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, d.name);
    try {
      n += d.isDirectory() ? bytes(f) : fs.statSync(f).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return n;
}
function counters() {
  const parse = (f) =>
    Object.fromEntries(
      fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split(/\s+/)),
    );
  const mem = parse("/sys/fs/cgroup/memory.stat");
  return {
    cpu_us: Number(parse("/sys/fs/cgroup/cpu.stat").usage_usec),
    memory_bytes: Number(fs.readFileSync("/sys/fs/cgroup/memory.current")),
    working_bytes:
      Number(fs.readFileSync("/sys/fs/cgroup/memory.current")) -
      Number(mem.inactive_file || 0),
    io: fs.readFileSync("/sys/fs/cgroup/io.stat", "utf8"),
  };
}
async function stats() {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM archive_work_heads) works,(SELECT count(*)::int FROM archive_snapshots) snapshots,(SELECT count(*)::int FROM archive_chapter_revisions) chapters,(SELECT count(*)::int FROM archive_object_data) objects,(SELECT coalesce(sum(length),0)::float FROM archive_object_data) object_stored_bytes,(SELECT coalesce(sum(size),0)::float FROM archive_object_data) object_raw_bytes,pg_database_size(current_database())::float database_bytes,(SELECT sum(pg_total_relation_size(relid))::float FROM pg_stat_user_tables) relation_bytes,(SELECT count(*)::int FROM catalog_pending) current_pending,(SELECT count(*)::int FROM catalog_snapshot_pending) historical_pending,(SELECT count(*)::int FROM catalog_text_pending) text_pending,(pg_total_relation_size('catalog_pending')+pg_total_relation_size('catalog_snapshot_pending')+pg_total_relation_size('catalog_text_pending'))::float queue_bytes,(SELECT wal_bytes::float FROM pg_stat_wal) wal_generated_bytes,(SELECT sum(size)::float FROM pg_ls_waldir()) wal_retained_bytes,(SELECT xact_commit::float FROM pg_stat_database WHERE datname=current_database()) commits`,
    )
  ).rows[0];
}
let seq = resume ? JSON.parse(fs.readFileSync(root + "/control.json")).id : 0;
async function control(action) {
  const id = ++seq;
  fs.writeFileSync(root + "/control.json", JSON.stringify({ id, action }));
  const until =
    Date.now() + (action === "heterogeneous-backup" ? 1500000 : 120000);
  while (Date.now() < until) {
    try {
      const a = JSON.parse(fs.readFileSync(root + "/control-ack.json"));
      if (a.id === id) {
        assert.equal(a.ok, true, JSON.stringify(a));
        return;
      }
    } catch (e) {
      if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    }
    await sleep(200);
  }
  throw Error("Control timeout " + action);
}
async function batch(selection, reprocess = false) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,$3)",
    [id, selection, reprocess],
  );
  return id;
}
function child(id, label) {
  const fd = fs.openSync(root + "/" + label + ".log", "a");
  const p = spawn(process.execPath, ["scripts/p5-ingest-child.cjs", id], {
    env: { ...process.env, PGAPPNAME: "p5-ingest" },
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  p.done = new Promise((resolve) =>
    p.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return p;
}
async function state(id) {
  return (
    await pool.query("SELECT state,error FROM ingest_batches WHERE id=$1", [id])
  ).rows[0];
}
async function finish(p, id, allowed = ["completed", "completed_with_gaps"]) {
  const result = await p.done;
  assert.equal(result.code, 0, JSON.stringify(result));
  const s = await state(id);
  assert.ok(allowed.includes(s.state), JSON.stringify(s));
  return s;
}
async function drain(label) {
  const before = await stats(),
    t = Date.now();
  await control("projection-start");
  while (Date.now() - t < 1800000) {
    const s = await stats();
    if (!s.current_pending && !s.historical_pending && !s.text_pending) break;
    await sleep(2000);
  }
  const after = await stats();
  assert.equal(
    after.current_pending + after.historical_pending + after.text_pending,
    0,
  );
  await control("projection-stop");
  const {
    searchRequest,
    SEARCH_INDEX,
  } = require("../apps/api/dist/catalog-search");
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
  const count = (
    await searchRequest("/" + SEARCH_INDEX + "/_count", undefined, "GET")
  ).count;
  assert.equal(count, after.works);
  const index = (
    await searchRequest("/" + SEARCH_INDEX + "/_stats", undefined, "GET")
  )._all;
  return {
    label,
    seconds: (Date.now() - t) / 1000,
    before,
    after,
    documents: count,
    index,
  };
}
let timer,
  busy = false;
async function sample() {
  if (busy) return;
  busy = true;
  try {
    const s = {
      at: Date.now(),
      ...(await stats()),
      ...counters(),
      staging_bytes: bytes("/benchmark/main/staging"),
      pack_bytes: bytes("/benchmark/main/packs"),
    };
    fs.appendFileSync(root + "/sustained.jsonl", JSON.stringify(s) + "\n");
    assert.ok(Date.now() - started < 3600000, "Campaign one-hour deadline");
    assert.ok(
      s.database_bytes + s.pack_bytes + s.staging_bytes < 12 * 1024 ** 3,
      "Campaign 12 GiB data cap",
    );
  } finally {
    busy = false;
  }
}
(async () => {
  await migrate();
  if (process.argv[2] === "csv") {
    assert.equal(process.env.ARCHIVE_ROOT, "/benchmark/csv");
    if ((await stats()).works === 0) {
      const id = await batch(["csv-supplement.zip"]);
      await finish(child(id, "csv-supplement"), id);
    }
    const final = await stats();
    assert.equal(final.works, 64);
    assert.equal(final.snapshots, 64);
    const { store } = require("../apps/api/dist/archive");
    const objects = (
      await pool.query(
        "SELECT encode(o.hash,'hex') hash,p.name pack,o.byte_offset AS offset,o.length,o.size,k.name kind FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id",
      )
    ).rows;
    const data = await store.readMany(
      objects.map((r) => ({
        ...r,
        offset: Number(r.offset),
        length: Number(r.length),
        size: Number(r.size),
      })),
    );
    for (let i = 0; i < objects.length; i++)
      assert.equal(
        createHash("sha256").update(data[i]).digest("hex"),
        objects[i].hash,
      );
    fs.writeFileSync(
      "/results/csv-verification.json",
      JSON.stringify(
        {
          works: final.works,
          snapshots: final.snapshots,
          verified_objects: objects.length,
          staging_bytes: bytes("/benchmark/csv/staging"),
          canonical_only: true,
          object_stored_bytes: final.object_stored_bytes,
          object_raw_bytes: final.object_raw_bytes,
          relation_bytes: final.relation_bytes,
          database_bytes: final.database_bytes,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!resume) {
    report.fixed = await stats();
    report.started = started;
  }
  save();
  const sources = fs
    .readdirSync("/dumps/ao3_stories")
    .filter(
      (n) =>
        (n.endsWith(".zip") || n.endsWith(".sqlite3")) &&
        !n.startsWith("synthetic-") &&
        n !== "queue119_archive05.zip" &&
        n !== "csv-supplement.zip",
    )
    .sort((a, b) => a.localeCompare(b));
  for (const source of sources) {
    if (resume && report.categories.some((c) => c.source === source)) continue;
    const before = await stats(),
      cpu = counters(),
      t = Date.now(),
      id = await batch([source]);
    const p = child(id, "category-" + source);
    await finish(p, id);
    const canonical_seconds = (Date.now() - t) / 1000,
      after = await stats();
    const projection = await drain(source);
    report.categories.push({
      source,
      source_bytes: fs.statSync("/dumps/ao3_stories/" + source).size,
      canonical_seconds,
      cpu_seconds: (counters().cpu_us - cpu.cpu_us) / 1e6,
      before,
      after,
      projection,
      sources: (
        await pool.query(
          "SELECT path,state,imported,duplicates,gaps FROM ingest_sources WHERE batch_id=$1",
          [id],
        )
      ).rows,
    });
    save();
  }
  // Replay an existing real stratum: report as repeated acquisition, never new-work throughput.
  if (!report.replay) {
    const source = sources.find((s) => s === "epub-small.zip");
    const before = await stats(),
      t = Date.now(),
      id = await batch([source], true);
    await finish(child(id, "replay"), id);
    const after = await stats();
    assert.equal(after.snapshots, before.snapshots);
    report.replay = { seconds: (Date.now() - t) / 1000, before, after };
    save();
  }
  // Preserve heterogeneous fixture for the later real backup/restore before synthetic load.
  fs.writeFileSync(root + "/heterogeneous-ready", "ready");
  if (!fs.existsSync(root + "/backup-restore.json"))
    await control("heterogeneous-backup");
  await control("projection-stop");
  await control("search-stop");
  const before = await stats(),
    synth = JSON.parse(
      fs.readFileSync("/dumps/ao3_stories/synthetic-manifest.json"),
    );
  const id = await batch([0, 1, 2, 3].map((i) => "synthetic-" + i + ".zip"));
  const t = Date.now();
  let p = child(id, "sustained");
  timer = setInterval(
    () =>
      sample().catch((e) => {
        console.error(e);
        p.kill("SIGTERM");
        process.exitCode = 1;
      }),
    5000,
  );
  await sample();
  let restarted = false,
    paused = false,
    crashed = false;
  // A real SQL transaction barrier; only the test DB gets this temporary trigger.
  await pool.query(
    `CREATE FUNCTION p5_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_id='900000030000' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$; CREATE TRIGGER p5_fault BEFORE INSERT ON archive_work_heads FOR EACH ROW EXECUTE FUNCTION p5_fault()`,
  );
  while (p.exitCode === null && p.signalCode === null) {
    const s = await stats();
    const n = s.works - before.works;
    if (!restarted && n >= 6000) {
      p.kill("SIGTERM");
      await p.done;
      report.events.push({ event: "SIGTERM_resume", works: n, at: Date.now() });
      p = child(id, "sustained");
      restarted = true;
    }
    if (
      !crashed &&
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='p5-ingest' AND wait_event='PgSleep'",
        )
      ).rowCount
    ) {
      p.kill("SIGKILL");
      await p.done;
      await pool.query(
        "DROP TRIGGER p5_fault ON archive_work_heads; DROP FUNCTION p5_fault()",
      );
      report.events.push({
        event: "SIGKILL_inside_transaction",
        works: n,
        at: Date.now(),
      });
      await sleep(1500);
      p = child(id, "sustained");
      crashed = true;
    }
    if (!paused && n >= 45000) {
      fs.writeFileSync(root + "/inject-disk-pause", "1");
      await sleep(7000);
      const a = await stats();
      await sleep(10000);
      const b = await stats();
      assert.equal(
        a.works,
        b.works,
        "Disk pressure must stop canonical commits",
      );
      p.kill("SIGTERM");
      await p.done;
      fs.unlinkSync(root + "/inject-disk-pause");
      report.events.push({
        event: "disk_pause_resume",
        works: b.works - before.works,
        seconds: 17,
        at: Date.now(),
      });
      p = child(id, "sustained");
      paused = true;
    }
    save();
    await sleep(1000);
  }
  await finish(p, id);
  assert.ok(restarted && paused && crashed, "All fault barriers must execute");
  const canonical = await stats();
  assert.equal(canonical.works - before.works, synth.works);
  assert.ok(canonical.current_pending > 65536);
  report.sustained = {
    before,
    canonical,
    canonical_wall_seconds: (Date.now() - t) / 1000,
    synthetic: synth,
    search_unavailable_seconds: (Date.now() - t) / 1000,
    events: report.events,
  };
  save();
  // Hold a large durable backlog across another process restart without another ingest.
  await sleep(30000);
  await control("search-start");
  report.sustained.projection = await drain("sustained");
  await sample();
  clearInterval(timer);
  timer = null;
  const v = Date.now();
  report.vacuum_before = (
    await pool.query(
      "SELECT relname,n_live_tup,n_dead_tup,autovacuum_count,vacuum_count,pg_total_relation_size(relid)::float bytes FROM pg_stat_user_tables WHERE relname IN ('catalog_pending','catalog_snapshot_pending','catalog_text_pending')",
    )
  ).rows;
  await pool.query(
    "VACUUM (ANALYZE) catalog_pending, catalog_snapshot_pending, catalog_text_pending",
  );
  report.vacuum_seconds = (Date.now() - v) / 1000;
  report.vacuum_after = (
    await pool.query(
      "SELECT relname,n_live_tup,n_dead_tup,autovacuum_count,vacuum_count,pg_total_relation_size(relid)::float bytes FROM pg_stat_user_tables WHERE relname IN ('catalog_pending','catalog_snapshot_pending','catalog_text_pending')",
    )
  ).rows;
  report.checkpoints = (
    await pool.query("SELECT * FROM pg_stat_checkpointer")
  ).rows;
  report.finished = Date.now();
  save();
  fs.writeFileSync(root + "/campaign-finished", "ok");
})()
  .catch((e) => {
    report.error = String(e.stack || e);
    save();
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(timer);
    await pool.end();
  });
