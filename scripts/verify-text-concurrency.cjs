// Additional concurrency probes on the retained isolated corpus. P2A/P2B.1 suites remain unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test DB required");
const pg = require("pg");
const clientQuery = pg.Client.prototype.query;
const epochs = new WeakMap(),
  openTransactions = new WeakMap(),
  claimedRevisions = new WeakMap(),
  preparedTransactions = new Map();
pg.Client.prototype.query = function (...a) {
  const sql = String(a[0]?.text ?? a[0]);
  if (sql.startsWith("BEGIN")) {
    epochs.set(this, (epochs.get(this) ?? 0) + 1);
    openTransactions.set(this, epochs.get(this));
  }
  if (
    sql.includes("JOIN catalog_text_pending p ON") &&
    sql.includes("jsonb_to_recordset")
  ) {
    const claims = JSON.parse(a[1][0]);
    claimedRevisions.set(
      this,
      new Map(claims.map((c) => [c.work_id, c.revision])),
    );
  }
  const result = clientQuery.apply(this, a);
  if (/^(COMMIT|ROLLBACK)/.test(sql) && result?.then)
    return result.then(
      (value) => {
        openTransactions.delete(this);
        return value;
      },
      (error) => {
        openTransactions.delete(this);
        throw error;
      },
    );
  return result;
};
const { pool } = require("../apps/api/dist/db");
const bulk = require("../apps/api/dist/catalog-text-bulk");
const search = require("../apps/api/dist/catalog-search");
const fetch0 = global.fetch,
  prepare0 = search.prepareTextDocument;
const originalFetch = async (...a) => {
  if (isBulk(a)) {
    const lines = a[1].body.trimEnd().split("\n");
    for (let i = 0; i < lines.length; i += 2) {
      const header = JSON.parse(lines[i]).index;
      const context = preparedTransactions.get(
        header._id + ":" + header.version,
      );
      assert.ok(
        context && openTransactions.get(context.client) !== context.epoch,
        "Publication must follow COMMIT of this claimed revision's preparation",
      );
    }
  }
  return fetch0(...a);
};
const originalPrepare = async (db, row, input) => {
  const document = await prepare0(db, row, input);
  const revision = claimedRevisions.get(db)?.get(row.work_id);
  assert.ok(
    revision,
    "Track the exact claimed revision, not a prior generation's COMMIT",
  );
  preparedTransactions.set(row.work_id + ":" + revision, {
    client: db,
    epoch: epochs.get(db),
  });
  return document;
};
search.prepareTextDocument = originalPrepare;
const originalQuery = pool.query.bind(pool);
const reports = {},
  events = [];
const originalLog = console.info;
console.info = (text) => {
  try {
    const v = JSON.parse(text);
    if (v.event === "text_bulk") events.push(v);
  } catch {}
  originalLog(text);
};
const isBulk = (a) => String(a[0]).endsWith("/_bulk");
const documents = (a) =>
  a[1].body
    .trimEnd()
    .split("\n")
    .filter((_, i) => i % 2 === 1)
    .map(JSON.parse);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function until(fn) {
  const end = Date.now() + 10000;
  while (!(await fn())) {
    assert.ok(Date.now() < end, "Probe deadline");
    await pause(10);
  }
}
const options = {
  groups: 32,
  documents: 8,
  prepareLanes: 2,
  publishLanes: 2,
  memoryBytes: 448 * 1024 * 1024,
};
let rows, ids;
async function enqueue(n = 12) {
  await pool.query(
    "INSERT INTO catalog_text_pending(work_id) SELECT unnest($1::uuid[]) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
    [ids.slice(0, n)],
  );
}
async function pending() {
  return (
    await pool.query("SELECT * FROM catalog_text_pending ORDER BY work_id")
  ).rows;
}
async function ready() {
  await pool.query(
    "UPDATE catalog_text_pending SET retry_at=now(),lease_until=now()-interval '1 second'",
  );
}
async function drain() {
  await ready();
  while ((await pending()).length)
    await bulk.projectText(2, () => false, options);
}
async function change(index, generation) {
  const metadata = { ...rows[index].metadata, title: [generation] };
  await pool.query(
    "UPDATE catalog_documents SET metadata=$2,generation=$3 WHERE work_id=$1",
    [ids[index], metadata, generation],
  );
  await pool.query(
    "UPDATE catalog_text_pending SET work_id=work_id WHERE work_id=$1",
    [ids[index]],
  );
}
async function restore() {
  global.fetch = originalFetch;
  search.prepareTextDocument = originalPrepare;
  pool.query = originalQuery;
  for (const r of rows)
    await pool.query(
      "UPDATE catalog_documents SET metadata=$2,generation=$3 WHERE work_id=$1",
      [r.work_id, r.metadata, r.generation],
    );
  await enqueue();
  await drain();
}
async function source(id) {
  return (
    await search.searchRequest(
      "/" + search.SEARCH_INDEX + "/_doc/" + id,
      undefined,
      "GET",
    )
  )._source;
}
(async () => {
  assert.equal((await pending()).length, 0);
  rows = (
    await pool.query(
      "SELECT * FROM catalog_documents ORDER BY work_id LIMIT 12",
    )
  ).rows;
  ids = rows.map((r) => r.work_id);
  fs.writeFileSync("/results/concurrency-original.json", JSON.stringify(rows));
  // Independent repeatable-read connections and genuine preparation/HTTP overlap.
  let activeReads = 0,
    peakReads = 0,
    activeHttp = 0,
    peakHttp = 0,
    overlap = false;
  const bothReads = gate(),
    bothHttp = gate();
  let readsArrived = 0,
    httpArrived = 0;
  search.prepareTextDocument = async (db, row, input) => {
    const settings = (
      await db.query(
        "SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation",
      )
    ).rows[0];
    assert.equal(settings.ro, "on");
    assert.equal(settings.isolation, "repeatable read");
    activeReads++;
    peakReads = Math.max(peakReads, activeReads);
    if (++readsArrived <= 2) {
      if (readsArrived === 2) bothReads.resolve();
      await bothReads.promise;
    }
    try {
      overlap ||= activeHttp > 0;
      await pause(20);
      overlap ||= activeHttp > 0;
      return await originalPrepare(db, row, input);
    } finally {
      activeReads--;
    }
  };
  global.fetch = async (...a) => {
    if (!isBulk(a)) return originalFetch(...a);
    activeHttp++;
    peakHttp = Math.max(peakHttp, activeHttp);
    if (++httpArrived <= 2) {
      if (httpArrived === 2) bothHttp.resolve();
      await bothHttp.promise;
    }
    try {
      await pause(60);
      overlap ||= activeReads > 0;
      return await originalFetch(...a);
    } finally {
      activeHttp--;
    }
  };
  await enqueue();
  await bulk.projectText(1, () => false, options);
  assert.equal(peakReads, 2);
  assert.equal(peakHttp, 2);
  assert.ok(overlap);
  let event = events.at(-1);
  assert.ok(event.overlap_ms > 0);
  assert.ok(event.buffered_documents_max <= 8);
  assert.ok(event.ndjson_bytes_max <= event.options.ndjsonBytes);
  assert.ok(event.reserved_bytes_max <= event.options.memoryBytes);
  reports.independent_read_snapshots_and_overlap = true;
  reports.each_publication_follows_its_own_preparation_commit = true;
  await restore();
  // Backpressure holds ready documents, refreshes their leases and fences a queued invalidation.
  const held = gate(),
    entered = gate();
  let first = true,
    prepared = 0,
    staleSent = false;
  search.prepareTextDocument = async (...a) => {
    const d = await originalPrepare(...a);
    prepared++;
    return d;
  };
  global.fetch = async (...a) => {
    if (isBulk(a)) {
      if (first) {
        first = false;
        entered.resolve();
        await held.promise;
      }
      if (
        documents(a).some(
          (d) => d.id === ids[2] && d.generation === rows[2].generation,
        ) &&
        prepared >= 4
      )
        staleSent = true;
    }
    return originalFetch(...a);
  };
  await enqueue();
  const waiting = bulk.projectText(1, () => false, {
    ...options,
    publishLanes: 1,
    renewMs: 100,
  });
  await entered.promise;
  await until(() => prepared >= 4);
  await pool.query(
    "UPDATE catalog_text_pending SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE work_id=$1",
    [ids[2]],
  );
  await pause(750);
  assert.ok(
    (
      await pool.query(
        "SELECT lease_until>clock_timestamp()+interval '4 minutes' yes FROM catalog_text_pending WHERE work_id=$1",
        [ids[2]],
      )
    ).rows[0].yes,
  );
  await change(2, "p2b2-queued-generation");
  held.resolve();
  await waiting;
  assert.equal(staleSent, false);
  assert.equal((await source(ids[2])).generation, "p2b2-queued-generation");
  event = events.at(-1);
  assert.ok(event.lease_renewals > event.claimed);
  assert.ok(event.queue_wait_max_ms >= 700);
  reports.queued_lease_renewal_and_new_generation = true;
  await restore();
  // Expired ownership cannot be renewed or ACKed, even without another owner.
  await enqueue(1);
  const expired = (await bulk.claimText(1))[0];
  await ready();
  assert.equal((await bulk.renewTextClaims([expired]))[0].valid, false);
  assert.equal(await bulk.acknowledgeText([expired]), 0);
  await drain();
  reports.expired_lease_not_resurrected_or_acknowledged = true;
  // Expiry while queued is rejected before HTTP, then reclaimed on the next pass.
  const expiryHeld = gate(),
    expiryEntered = gate();
  let expiryFirst = true,
    expiryPrepared = 0;
  const sent = new Set();
  search.prepareTextDocument = async (...a) => {
    const d = await originalPrepare(...a);
    expiryPrepared++;
    return d;
  };
  global.fetch = async (...a) => {
    if (isBulk(a)) {
      documents(a).forEach((d) => sent.add(d.id));
      if (expiryFirst) {
        expiryFirst = false;
        expiryEntered.resolve();
        await expiryHeld.promise;
      }
    }
    return originalFetch(...a);
  };
  await enqueue(3);
  const expiring = bulk.projectText(1, () => false, {
    ...options,
    groups: 3,
    prepareLanes: 1,
    publishLanes: 1,
  });
  await expiryEntered.promise;
  await until(() => expiryPrepared === 3);
  await pool.query(
    "UPDATE catalog_text_pending SET lease_until=clock_timestamp()-interval '1 second' WHERE work_id=$1",
    [ids[2]],
  );
  expiryHeld.resolve();
  assert.equal(await expiring, 2);
  assert.ok(!sent.has(ids[2]));
  assert.equal((await pending()).length, 1);
  assert.ok(events.at(-1).lease_expired > 0);
  await restore();
  reports.queued_expired_lease_rejected_before_http = true;
  let invalidate = true;
  search.prepareTextDocument = async (db, row, input) => {
    const d = await originalPrepare(db, row, input);
    if (row.work_id === ids[0] && invalidate) {
      invalidate = false;
      await change(0, "p2b2-during-prepare");
    }
    return d;
  };
  await enqueue();
  await bulk.projectText(1, () => false, options);
  await drain();
  assert.equal((await source(ids[0])).generation, "p2b2-during-prepare");
  await restore();
  reports.concurrent_invalidation_during_preparation = true;
  await enqueue(2);
  assert.equal(
    await bulk.projectText(2, () => false, {
      groups: 1,
      prepareLanes: 1,
      publishLanes: 1,
      documents: 2,
      memoryBytes: 352 * 1024 * 1024,
      ndjsonBytes: 320 * 1024 * 1024,
    }),
    2,
  );
  assert.equal(events.at(-1).requests, 2);
  assert.ok(events.at(-1).reserved_bytes_max <= 352 * 1024 * 1024);
  reports.tight_byte_budget_flushes_staging_without_deadlock = true;
  // Two real in-flight requests for the same ID: newer accepted first, old ACK
  // attempted while the new response is still held before its own ACK.
  const oldMaySend = gate(),
    newMayAck = gate();
  let oldRevision,
    changed = false,
    oldAckChecked = false;
  global.fetch = async (...a) => {
    if (!isBulk(a)) return originalFetch(...a);
    const doc = documents(a)[0];
    if (
      doc.id === ids[0] &&
      doc.generation === rows[0].generation &&
      !changed
    ) {
      changed = true;
      oldRevision = String(JSON.parse(a[1].body.split("\n")[0]).index.version);
      await change(0, "p2b2-newest");
      await oldMaySend.promise;
      return originalFetch(...a);
    }
    const response = await originalFetch(...a);
    if (doc.id === ids[0] && doc.generation === "p2b2-newest") {
      oldMaySend.resolve();
      await newMayAck.promise;
    }
    return response;
  };
  pool.query = async (...a) => {
    const result = await originalQuery(...a);
    if (
      String(a[0]).startsWith("DELETE FROM catalog_text_pending p USING") &&
      JSON.parse(a[1][0]).some(
        (c) => c.work_id === ids[0] && c.revision === oldRevision,
      )
    ) {
      assert.equal(result.rowCount, 0);
      const current = (
        await originalQuery(
          "SELECT revision FROM catalog_text_pending WHERE work_id=$1",
          [ids[0]],
        )
      ).rows[0];
      assert.ok(current && current.revision !== oldRevision);
      oldAckChecked = true;
      newMayAck.resolve();
    }
    return result;
  };
  await enqueue();
  await bulk.projectText(1, () => false, options);
  assert.ok(oldAckChecked);
  assert.equal((await source(ids[0])).generation, "p2b2-newest");
  assert.equal(events.at(-1).acknowledged, 12);
  assert.equal((await pending()).length, 0);
  reports.out_of_order_concurrent_versions_and_stale_ack = true;
  await restore();
  // A failed item does not undo another consumer's confirmed ACK.
  let corrupt = true;
  global.fetch = async (...a) => {
    if (isBulk(a) && corrupt) {
      corrupt = false;
      const lines = a[1].body.trimEnd().split("\n");
      const d = JSON.parse(lines[1]);
      d.word_count = "bad-number";
      lines[1] = JSON.stringify(d);
      a[1] = { ...a[1], body: lines.join("\n") + "\n" };
      await pause(100);
    }
    return originalFetch(...a);
  };
  await enqueue();
  await assert.rejects(() => bulk.projectText(1, () => false, options));
  assert.ok(events.at(-1).acknowledged > 0);
  assert.ok((await pending()).some((r) => r.error === "BULK_ITEM_400"));
  await restore();
  reports.partial_error_with_successful_concurrent_bulk = true;
  // Overload must halt buffered sends, with another request already accepted.
  for (const status of [429, 503]) {
    const arrived = gate();
    let requests = 0;
    global.fetch = async (...a) => {
      if (!isBulk(a)) return originalFetch(...a);
      const number = ++requests;
      if (number === 1) {
        await arrived.promise;
        return new Response("overloaded", { status });
      }
      const response = await originalFetch(...a);
      arrived.resolve();
      await pause(100);
      return response;
    };
    await enqueue();
    await assert.rejects(() => bulk.projectText(1, () => false, options));
    assert.equal(requests, 2);
    assert.equal(events.at(-1).acknowledged, 1);
    const failed = (await pending()).find((r) => r.error === `HTTP_${status}`);
    assert.ok(failed && new Date(failed.retry_at).getTime() > Date.now());
    assert.ok((await pending()).every((r) => r.claim === null));
    await restore();
  }
  reports.overload_stops_buffered_publication_and_preserves_other_ack = true;
  // Server-side termination of a preparation connection must stop acquisition,
  // drain started requests and preserve recoverable claims.
  let terminate = true;
  search.prepareTextDocument = async (db, ...a) => {
    if (terminate) {
      terminate = false;
      const pending = db.query("SELECT pg_sleep(2)");
      const caught = pending.catch((e) => e);
      await pool.query("SELECT pg_terminate_backend($1)", [db.processID]);
      const error = await caught;
      throw error;
    }
    return originalPrepare(db, ...a);
  };
  await enqueue();
  await assert.rejects(() => bulk.projectText(1, () => false, options));
  await restore();
  reports.postgres_preparation_connection_loss_recovered = true;
  if (process.env.P2B2_POSTGRES_OUTAGE === "1") {
    let signal = true;
    search.prepareTextDocument = async (...a) => {
      if (signal) {
        signal = false;
        fs.writeFileSync("/results/pg-stop-ready", "ready");
        await pause(1500);
      }
      return originalPrepare(...a);
    };
    await enqueue();
    let leaderLost = false;
    await assert.rejects(() =>
      require("../apps/api/dist/operations-index").runProjection(
        "search",
        () => bulk.projectText(1, () => leaderLost, options),
        () => {
          leaderLost = true;
        },
      ),
    );
    await until(() => fs.existsSync("/results/pg-restarted"));
    await restore();
    await enqueue(1);
    leaderLost = false;
    assert.equal(
      await require("../apps/api/dist/operations-index").runProjection(
        "search",
        () => bulk.projectText(1, () => leaderLost, options),
        () => {
          leaderLost = true;
        },
      ),
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM operations_index WHERE kind='search'",
        )
      ).rows[0].state,
      "idle",
    );
    reports.postgres_shutdown_restart_recovered = true;
    reports.leader_loss_stops_pipeline_and_recovers_operational_state = true;
  }
  // Crash probes run the actual pipeline, with multiple claims and buffered docs.
  reports.crashes = {};
  for (const phase of ["producer", "http", "before-ack", "sigterm"]) {
    await enqueue();
    const code = `const b=require('./apps/api/dist/catalog-text-bulk'),s=require('./apps/api/dist/catalog-search'),{pool}=require('./apps/api/dist/db');let stop=false,once=true;process.on('SIGTERM',()=>{stop=true});const prep=s.prepareTextDocument;s.prepareTextDocument=async(...a)=>{const d=await prep(...a);if('${phase}'==='producer'&&once){once=false;process.kill(process.pid,'SIGKILL')}return d};const fetch0=global.fetch;global.fetch=async(...a)=>{const r=await fetch0(...a);if(String(a[0]).endsWith('/_bulk')&&once&&['http','sigterm'].includes('${phase}')){once=false;await r.clone().arrayBuffer();process.kill(process.pid,'${phase}'==='sigterm'?'SIGTERM':'SIGKILL');await new Promise(r=>setTimeout(r,50))}return r};const q=pool.query.bind(pool);pool.query=(...a)=>{if('${phase}'==='before-ack'&&String(a[0]).startsWith('DELETE FROM catalog_text_pending p USING'))process.kill(process.pid,'SIGKILL');return q(...a)};b.projectText(1,()=>stop,${JSON.stringify(options)}).then(()=>pool.end()).catch(e=>{console.error(e);process.exit(1)});`;
    const child = spawnSync(process.execPath, ["-e", code], {
      cwd: "/app",
      env: process.env,
      timeout: 30000,
      encoding: "utf8",
    });
    if (phase === "sigterm") {
      assert.equal(child.status, 0, child.stderr);
      assert.ok((await pending()).every((r) => r.claim === null));
    } else assert.equal(child.signal, "SIGKILL", child.stderr);
    const remaining = (await pending()).length;
    assert.ok(remaining > 0);
    const start = performance.now();
    await drain();
    reports.crashes[phase] = {
      pending_after: remaining,
      recovery_ms: performance.now() - start,
      lease_expiry_forced: phase !== "sigterm",
    };
  }
  // Explicit pause while a consumer is busy cancels queued work, then resumes.
  const paused = gate(),
    releaseHttp = gate();
  let once = true;
  global.fetch = async (...a) => {
    if (isBulk(a) && once) {
      once = false;
      paused.resolve();
      await releaseHttp.promise;
    }
    return originalFetch(...a);
  };
  await enqueue();
  const pausing = bulk.projectText(1, () => false, {
    ...options,
    publishLanes: 1,
    renewMs: 100,
  });
  await paused.promise;
  await pool.query(
    "UPDATE operations_index SET paused=true WHERE kind='search'",
  );
  await pause(200);
  releaseHttp.resolve();
  await pausing;
  assert.ok((await pending()).length);
  assert.ok((await pending()).every((r) => r.claim === null));
  await pool.query(
    "UPDATE operations_index SET paused=false WHERE kind='search'",
  );
  await restore();
  reports.pause_cancels_buffered_claims_and_resumes = true;
  assert.equal((await pending()).length, 0);
  fs.writeFileSync(
    "/results/concurrency-fixtures.json",
    JSON.stringify(reports, null, 2),
  );
  console.log(reports);
})()
  .finally(async () => {
    global.fetch = originalFetch;
    search.prepareTextDocument = originalPrepare;
    pool.query = originalQuery;
    await pool.query(
      "UPDATE operations_index SET paused=false WHERE kind='search'",
    );
    await pool.end();
    pg.Client.prototype.query = clientQuery;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
