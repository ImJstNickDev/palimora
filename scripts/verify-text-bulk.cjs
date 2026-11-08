const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { pool, migrate, transaction } = require("../apps/api/dist/db");
const bulk = require("../apps/api/dist/catalog-text-bulk");
const search = require("../apps/api/dist/catalog-search");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test DB required");
const report = {};
const originalFetch = global.fetch;
const isBulk = (args) => String(args[0]).endsWith("/_bulk");
let ids;
async function enqueue(n = 1) {
  await pool.query(
    "INSERT INTO catalog_text_pending(work_id) SELECT unnest($1::uuid[]) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
    [ids.slice(0, n)],
  );
}
async function ready() {
  await pool.query(
    "UPDATE catalog_text_pending SET retry_at=now(),lease_until=now()-interval '1 second'",
  );
}
async function pending() {
  return (
    await pool.query("SELECT * FROM catalog_text_pending ORDER BY work_id")
  ).rows;
}
async function drain() {
  await ready();
  while ((await pending()).length) await bulk.projectText(16);
}
(async () => {
  await migrate();
  const canonicalSql =
    "SELECT (SELECT count(*) FROM archive_work_heads)::text works,(SELECT count(*) FROM archive_snapshots)::text snapshots,(SELECT md5(string_agg(id::text||manifest_hash,'' ORDER BY id)) FROM archive_snapshots) manifests,(SELECT md5(string_agg(snapshot_id::text||metadata::text||bibliography::text,'' ORDER BY snapshot_id)) FROM catalog_snapshot_views) history";
  const canonicalBefore = (await pool.query(canonicalSql)).rows[0];
  assert.equal((await pending()).length, 0);
  ids = (
    await pool.query(
      "SELECT work_id FROM catalog_documents ORDER BY work_id LIMIT 2",
    )
  ).rows.map((r) => r.work_id);
  await enqueue(2);
  global.fetch = async (...args) => {
    if (isBulk(args)) {
      const active = (
        await pool.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL AND query NOT LIKE '%pg_stat_activity%' AND backend_type='client backend'",
        )
      ).rows[0].n;
      assert.equal(active, 0, "No SQL transaction during HTTP");
      const lines = args[1].body.trimEnd().split("\n");
      const doc = JSON.parse(lines[1]);
      doc.word_count = "invalid-number";
      lines[1] = JSON.stringify(doc);
      args[1] = { ...args[1], body: lines.join("\n") + "\n" };
    }
    return originalFetch(...args);
  };
  await assert.rejects(() => bulk.projectText(2));
  global.fetch = originalFetch;
  assert.equal((await pending()).length, 1);
  assert.match((await pending())[0].error, /BULK_ITEM_400/);
  await drain();
  report.partial_failure_and_no_http_transaction = true;
  await enqueue();
  global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (isBulk(args)) {
      await response.arrayBuffer();
      throw Error("Timeout after acceptance");
    }
    return response;
  };
  await assert.rejects(() => bulk.projectText(1));
  global.fetch = originalFetch;
  assert.equal((await pending()).length, 1);
  await drain();
  report.accepted_timeout_idempotent_retry = true;
  await enqueue();
  const old = (await bulk.claimText(1))[0];
  await ready();
  const newer = (await bulk.claimText(1))[0];
  assert.notEqual(old.claim, newer.claim);
  assert.equal(await bulk.acknowledgeText([old]), 0);
  await ready();
  await drain();
  report.lease_expiry_and_stale_owner = true;
  const original = (
    await pool.query(
      "SELECT metadata,generation FROM catalog_documents WHERE work_id=$1",
      [ids[0]],
    )
  ).rows[0];
  async function change(generation) {
    await transaction(async (db) => {
      await db.query(
        "UPDATE catalog_documents SET metadata=jsonb_set(metadata,'{availability}','\"deleted\"'),generation=$2 WHERE work_id=$1",
        [ids[0], generation],
      );
      await db.query(
        "INSERT INTO catalog_text_pending(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
        [ids[0]],
      );
    });
  }
  // Hold the older HTTP request while a new revision is built and published.
  await enqueue();
  let intercepted = false;
  global.fetch = async (...args) => {
    if (isBulk(args) && !intercepted) {
      intercepted = true;
      await change("p2a-newer-inflight");
      await bulk.projectText(1);
    }
    return originalFetch(...args);
  };
  await bulk.projectText(1);
  global.fetch = originalFetch;
  assert.equal((await pending()).length, 0);
  assert.equal(
    (
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + ids[0],
        undefined,
        "GET",
      )
    )._source.generation,
    "p2a-newer-inflight",
  );
  report.out_of_order_publication = true;
  // Mutate the real catalog while preparation has its own repeatable-read view.
  const prepare = search.prepareTextDocument;
  await enqueue();
  let changed = false;
  search.prepareTextDocument = async (...args) => {
    const document = await prepare(...args);
    if (!changed) {
      changed = true;
      await change("p2a-during-preparation");
    }
    return document;
  };
  await bulk.projectText(1);
  search.prepareTextDocument = prepare;
  assert.equal((await pending()).length, 1);
  await drain();
  assert.equal(
    (
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + ids[0],
        undefined,
        "GET",
      )
    )._source.generation,
    "p2a-during-preparation",
  );
  await pool.query(
    "UPDATE catalog_documents SET metadata=$2,generation=$3 WHERE work_id=$1",
    [ids[0], original.metadata, original.generation],
  );
  await enqueue();
  await drain();
  report.invalidation_during_preparation = true;
  // Kill real child processes at the durable protocol boundaries.
  for (const phase of [
    "claim-before-commit",
    "before-send",
    "after-send",
    "before-ack",
  ]) {
    await enqueue();
    const code = `const pg=require('pg');const pq=pg.Client.prototype.query;pg.Client.prototype.query=function(...a){const r=pq.apply(this,a);if('${phase}'==='claim-before-commit'&&String(a[0]).includes('WITH ready AS'))return r.then(()=>process.kill(process.pid,'SIGKILL'));return r;};const b=require('./apps/api/dist/catalog-text-bulk');const {pool}=require('./apps/api/dist/db');const q=pool.query.bind(pool);pool.query=(...a)=>{if('${phase}'==='before-ack'&&String(a[0]).startsWith('DELETE FROM catalog_text_pending p USING'))process.kill(process.pid,'SIGKILL');return q(...a)};const f=global.fetch;global.fetch=async(...a)=>{if(String(a[0]).endsWith('/_bulk')){if('${phase}'==='before-send')process.kill(process.pid,'SIGKILL');const r=await f(...a);if('${phase}'==='after-send'){await r.arrayBuffer();process.kill(process.pid,'SIGKILL');}return r;}return f(...a)};b.projectText(1);`;
    const child = spawnSync(process.execPath, ["-e", code], {
      cwd: "/app",
      env: process.env,
      timeout: 60000,
    });
    assert.equal(child.signal, "SIGKILL");
    assert.equal((await pending()).length, 1);
    await ready();
    await drain();
    report["crash_" + phase] = true;
  }
  for (const status of [429, 503]) {
    await enqueue();
    global.fetch = async (...args) =>
      isBulk(args) ? new Response("{}", { status }) : originalFetch(...args);
    await assert.rejects(() => bulk.projectText(1));
    global.fetch = originalFetch;
    assert.equal((await pending()).length, 1);
    assert.ok(new Date((await pending())[0].retry_at).getTime() > Date.now());
    await drain();
  }
  report.transient_backoff = true;
  await enqueue();
  search.prepareTextDocument = async (...args) => ({
    ...(await prepare(...args)),
    text: { und: "è".repeat(33 * 1024 * 1024) },
  });
  await assert.rejects(() => bulk.projectText(1));
  search.prepareTextDocument = prepare;
  assert.equal((await pending())[0].error, "DOCUMENT_EXCEEDS_64_MIB");
  await drain();
  report.oversize_utf8_preserved = true;
  await enqueue(2);
  let largeRequests = 0;
  search.prepareTextDocument = async (...args) => ({
    ...(await prepare(...args)),
    text: { und: "x ".repeat(5 * 1024 * 1024) },
  });
  global.fetch = async (...args) => {
    if (isBulk(args)) {
      largeRequests++;
      assert.ok(Buffer.byteLength(args[1].body) > 8 * 1024 * 1024);
      assert.equal(args[1].body.trimEnd().split("\n").length, 2);
    }
    return originalFetch(...args);
  };
  await bulk.projectText(2);
  search.prepareTextDocument = prepare;
  global.fetch = originalFetch;
  assert.equal(largeRequests, 2);
  await enqueue(2);
  await drain();
  report.large_documents_sent_alone = true;
  const {
    runProjection,
    startProjections,
  } = require("../apps/api/dist/operations-index");
  await enqueue();
  await pool.query(
    "UPDATE operations_index SET paused=true WHERE kind='search'",
  );
  assert.equal(await runProjection("search", () => bulk.projectText(1)), 0);
  assert.equal((await pending()).length, 1);
  await pool.query(
    "UPDATE operations_index SET paused=false,retry_at=NULL WHERE kind='search'",
  );
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(70210473)");
  assert.equal(await runProjection("search", () => bulk.projectText(1)), 0);
  await lock.query("SELECT pg_advisory_unlock(70210473)");
  lock.release();
  assert.equal(await runProjection("search", () => bulk.projectText(1)), 1);
  await enqueue(2);
  const stop = startProjections(async () => 0, bulk.projectText);
  const deadline = Date.now() + 30000;
  while ((await pending()).length) {
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 20));
  }
  await stop();
  report.scheduler_pause_resume_replica_and_stop = true;
  await enqueue();
  global.fetch = async (...args) =>
    isBulk(args) ? new Response("{}", { status: 503 }) : originalFetch(...args);
  assert.equal(await runProjection("search", () => bulk.projectText(1)), 0);
  global.fetch = originalFetch;
  assert.equal(
    (await pool.query("SELECT state FROM operations_index WHERE kind='search'"))
      .rows[0].state,
    "failed",
  );
  assert.ok(
    (
      await pool.query(
        "SELECT 1 FROM operations_index_runs WHERE kind='search' AND error='SEARCH_INDEX_FAILED'",
      )
    ).rowCount,
  );
  await pool.query(
    "UPDATE operations_index SET retry_at=NULL WHERE kind='search'",
  );
  await ready();
  assert.equal(await runProjection("search", () => bulk.projectText(1)), 1);
  report.operational_failure_history_and_retry = true;
  const previousMode = (
    await pool.query("SELECT maintenance_mode FROM instance")
  ).rows[0].maintenance_mode;
  for (const mode of ["maintenance_light", "maintenance_full", "normal"]) {
    await pool.query("UPDATE instance SET maintenance_mode=$1", [mode]);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(
      (await require("../apps/api/dist/maintenance").processingPolicy()).mode,
      mode,
    );
    await enqueue();
    const stopMode = startProjections(async () => 0, bulk.projectText);
    const end = Date.now() + 30000;
    while ((await pending()).length) {
      assert.ok(Date.now() < end);
      await new Promise((r) => setTimeout(r, 20));
    }
    await stopMode();
  }
  await pool.query("UPDATE instance SET maintenance_mode=$1", [previousMode]);
  report.maintenance_modes = true;
  report.retry_durability = await require("./verify-text-retry.cjs").verify();
  // A stopped lane releases untouched claims without losing invalidations.
  await enqueue(2);
  await bulk.projectText(2, () => true);
  assert.equal((await pending()).length, 2);
  await drain();
  report.stop = true;
  await enqueue();
  let removed = false;
  global.fetch = async (...args) => {
    if (isBulk(args) && !removed) {
      removed = true;
      await search.searchRequest(
        "/" + search.SEARCH_INDEX,
        undefined,
        "DELETE",
      );
    }
    return originalFetch(...args);
  };
  await assert.rejects(() => bulk.projectText(1));
  global.fetch = originalFetch;
  assert.equal(
    (
      await search.searchRequest(
        "/" + search.SEARCH_INDEX,
        undefined,
        "HEAD",
        true,
      )
    ).status,
    404,
  );
  report.no_automatic_index_without_mapping = true;
  await search.ensureSearchIndex();
  assert.equal((await pending()).length, 11032);
  await drain();
  await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh");
  assert.equal(
    (await search.searchRequest("/" + search.SEARCH_INDEX + "/_count", {}))
      .count,
    11032,
  );
  assert.equal((await pending()).length, 0);
  report.recreation_and_drain = true;
  assert.deepEqual((await pool.query(canonicalSql)).rows[0], canonicalBefore);
  report.canonical_snapshots_and_history_unchanged = true;
  assert.equal(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending)+(SELECT count(*) FROM catalog_graph_pending)+(SELECT count(*) FROM catalog_text_pending) n",
      )
    ).rows[0].n,
    "0",
  );
  report.all_projection_queues_drained = true;
  fs.writeFileSync("/results/faults.json", JSON.stringify(report, null, 2));
  console.log(report);
  await pool.end();
})().catch((e) => {
  global.fetch = originalFetch;
  console.error(e);
  process.exit(1);
});
