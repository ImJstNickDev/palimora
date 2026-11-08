// Real PostgreSQL/PackStore, synthetic version semantics; no original corpus mutation.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { randomUUID, createHash } = require("node:crypto"),
  { spawn } = require("node:child_process"),
  { once } = require("node:events"),
  { Pool } = require("pg");
const url = new URL(process.env.DATABASE_URL);
if (!url.pathname.endsWith("_test")) throw Error("Isolated test DB required");
const admin = new Pool({ connectionString: url.toString() }),
  schema = "test_history_" + randomUUID().replaceAll("-", "");
url.searchParams.set("options", "-c search_path=" + schema);
process.env.DATABASE_URL = url.toString();
process.env.ARCHIVE_ROOT = "/results/history-fixture-" + schema;
const { pool, migrate, transaction } = require("../apps/api/dist/db"),
  catalog = require("../apps/api/dist/catalog"),
  bib = require("../apps/api/dist/catalog-bibliography"),
  old = require("../apps/api/old-dist/catalog-bibliography"),
  archive = require("../apps/api/dist/archive");
const norm = (x, key = "") =>
  Array.isArray(x)
    ? ["tags", "entities", "filterTags"].includes(key)
      ? x
          .map((v) => norm(v))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : x.map((v) => norm(v))
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, norm(x[k], k)]),
        )
      : x;
(async () => {
  await admin.query("CREATE SCHEMA " + schema);
  await migrate();
  const batch = randomUUID(),
    source = {
      id: randomUUID(),
      path: "history-fixture.zip",
      fingerprint: "history-fixture",
    };
  await pool.query(
    "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
    [batch],
  );
  await pool.query(
    "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
    [source.id, batch, source.path, source.fingerprint],
  );
  for (let v = 0; v < 3; v++) {
    const record = {
      external_id: "history-work",
      source_entry: "version-" + v,
      state: "valid",
      observed_at: `2026-01-0${v + 1}T00:00:00Z`,
      metadata: {
        title: ["Version " + v],
        creators: ["Local writer"],
        unclassified: ["Known"],
        ao3: {
          schema: "palimora-ao3-v1",
          anonymous: v === 2,
          tags: [
            {
              kind: "freeform",
              name: v === 2 ? "Current" : "Past",
              id: "ignored-historical-id",
              canonical: false,
              meta_tags: ["ignored-edge"],
            },
          ],
          ...(v === 0
            ? {
                series: [
                  { id: "history-series", name: "First", notes: "first" },
                ],
              }
            : v === 1
              ? {
                  series: [
                    { id: "history-series", name: "Second", notes: "second" },
                  ],
                }
              : {}),
        },
      },
      chapters: [{ name: "chapter" }],
      objects: [
        {
          name: "chapter",
          kind: "chapter_html",
          data: Buffer.from("<p>Version " + v + "</p>").toString("base64"),
        },
        {
          name: "preface",
          kind: "document_html",
          data: Buffer.from(
            '<a href="https://archiveofourown.org/collections/shared">Shared collection</a>',
          ).toString("base64"),
        },
      ],
    };
    await archive.ingestRecords(
      source,
      [{ record, locator: "v" + v, parser: "history-test", cursor: v + 1 }],
      { authoritative: true },
    );
  }
  await archive.ingestRecords(
    source,
    [
      {
        record: {
          external_id: "alias-target",
          source_entry: "alias",
          metadata: { title: ["Alias"] },
          chapters: [],
          objects: [],
          state: "valid",
          observed_at: null,
        },
        locator: "alias",
        parser: "history-test",
        cursor: 4,
      },
    ],
    { authoritative: true },
  );
  await catalog.projectCatalog(20, 0);
  const work = (
    await pool.query(
      "SELECT id FROM archive_work_heads WHERE external_id='history-work'",
    )
  ).rows[0].id;
  const alias = (
    await pool.query(
      "SELECT id FROM archive_work_heads WHERE external_id='alias-target'",
    )
  ).rows[0].id;
  const snapshots = (
    await pool.query(
      "SELECT id,manifest_hash FROM archive_snapshots WHERE work_id=$1 ORDER BY observed_at,id",
      [work],
    )
  ).rows;
  assert.equal(snapshots.length, 3);
  const input = [];
  await transaction(async (db) => {
    for (const s of snapshots) {
      const m = JSON.parse(
        (await archive.readObject(db, s.manifest_hash)).toString(),
      );
      input.push({
        work: { id: work, current_snapshot_id: s.id },
        raw: await bib.enrichBibliography(db, m.metadata, m),
      });
    }
    const known = await bib.ensureTag(db, {
        kind: "freeform",
        name: "Known",
        id: "known-source",
        canonical: true,
      }),
      parent = await bib.ensureTag(db, {
        kind: "freeform",
        name: "Parent",
        id: "parent-source",
      }),
      ancestor = await bib.ensureTag(db, {
        kind: "freeform",
        name: "Ancestor",
        id: "ancestor-source",
      }),
      current = (
        await db.query("SELECT id FROM catalog_tags WHERE name='Current'")
      ).rows[0];
    await db.query("INSERT INTO catalog_tag_edges VALUES($1,$2,'meta')", [
      current.id,
      parent.id,
    ]);
    await db.query(
      "INSERT INTO catalog_tag_edges VALUES($1,$2,'synonym'),($2,$1,'meta')",
      [parent.id, ancestor.id],
    );
  });
  const currentState = async (db) =>
    (
      await db.query(
        `SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(d) ORDER BY work_id) FROM catalog_documents d),(SELECT jsonb_agg(to_jsonb(t) ORDER BY work_id,tag_id) FROM catalog_work_tags t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY work_id,entity_id) FROM catalog_entity_works t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY work_id,tag_id) FROM catalog_work_filters t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM archive_work_heads t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM archive_snapshots t))::text) digest`,
      )
    ).rows[0].digest;
  const before = await currentState(pool);
  async function differential(useNew) {
    const db = await pool.connect();
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(70210408)");
    let output = [];
    if (useNew) output = await bib.projectHistoricalBibliographies(db, input);
    else
      for (const i of input)
        output.push(await old.projectBibliography(db, i.work, i.raw, true));
    const entities = (
        await db.query("SELECT * FROM catalog_entities ORDER BY id")
      ).rows,
      tags = (await db.query("SELECT * FROM catalog_tags ORDER BY id")).rows;
    assert.equal(
      (
        await db.query(
          "SELECT details->>'notes' notes FROM catalog_entities WHERE source_id='history-series'",
        )
      ).rows[0].notes,
      "first",
    );
    assert.equal(tags.find((t) => t.name === "Past").source_id, null);
    assert.equal(output[2].metadata.creators[0], "Anonymous");
    assert.equal(
      output[2].details.entities.some((e) => e.kind === "author"),
      false,
    );
    assert.ok(
      output[0].filterTags.includes(tags.find((t) => t.name === "Current").id),
    );
    assert.ok(
      !output[0].filterTags.includes(tags.find((t) => t.name === "Past").id),
    );
    assert.equal(await currentState(db), before);
    await db.query("ROLLBACK");
    db.release();
    return norm({ output, entities, tags });
  }
  const original = await differential(true);
  assert.deepEqual(original, await differential(false));
  const ancestorId = original.tags.find((t) => t.name === "Ancestor").id;
  assert.ok(original.output[0].filterTags.includes(ancestorId));
  assert.equal(
    new Set(original.output[0].filterTags).size,
    original.output[0].filterTags.length,
  );
  await pool.query("DELETE FROM catalog_tag_edges WHERE kind='synonym'");
  const changed = await differential(true);
  assert.deepEqual(changed, await differential(false));
  assert.ok(!changed.output[0].filterTags.includes(ancestorId));
  // Three versions share one document_html object; read/verify it once per batch.
  const batchDb = await pool.connect();
  await batchDb.query("BEGIN");
  const read = archive.store.readMany,
    counts = new Map();
  archive.store.readMany = async function (records, ...args) {
    for (const r of records) counts.set(r.hash, (counts.get(r.hash) ?? 0) + 1);
    return read.call(this, records, ...args);
  };
  try {
    const views = await catalog.materializeHistoricalViews(
      batchDb,
      snapshots.map((s) => s.id),
    );
    assert.deepEqual(
      snapshots.map((s) => views.get(s.id).metadata.title[0]),
      ["Version 0", "Version 1", "Version 2"],
    );
    assert.equal(counts.size, 4);
    assert.ok([...counts.values()].every((n) => n === 1));
  } finally {
    archive.store.readMany = read;
    await batchDb.query("ROLLBACK");
    batchDb.release();
  }
  // Explicit aliases used to differ before the background had materialized a view.
  let aliasDifference;
  await transaction(async (db) => {
    const a = await old.projectBibliography(
        db,
        input[0].work,
        input[0].raw,
        true,
      ),
      b = await old.projectBibliography(
        db,
        { ...input[0].work, id: alias },
        input[0].raw,
        true,
      );
    aliasDifference =
      JSON.stringify(a.details.entities) !== JSON.stringify(b.details.entities);
  });
  assert.equal(aliasDifference, true);
  await pool.query(
    "INSERT INTO archive_identity_links(work_id,canonical_work_id) VALUES($1,$2)",
    [work, alias],
  );
  await pool.query("DELETE FROM catalog_pending");
  // Same snapshot through owner and canonical alias, concurrent with the queue.
  const reads = await Promise.all([
    transaction((db) =>
      catalog.catalogOperation(db, "readerWork", {
        id: work,
        snapshot: snapshots[0].id,
      }),
    ),
    transaction((db) =>
      catalog.catalogOperation(db, "readerWork", {
        id: alias,
        snapshot: snapshots[0].id,
      }),
    ),
    catalog.projectCatalog(0, 2),
  ]);
  assert.deepEqual(reads[0].metadata, reads[1].metadata);
  assert.deepEqual(reads[0].bibliography, reads[1].bibliography);
  const cached = (
    await pool.query(
      "SELECT * FROM catalog_snapshot_views WHERE snapshot_id=$1",
      [snapshots[0].id],
    )
  ).rows[0];
  assert.ok(cached);
  // Materializer returns exactly the persisted view; reader calls above exercise ACL/alias resolution.
  const repeated = await Promise.all(
    Array.from({ length: 3 }, () =>
      transaction(async (db) =>
        (await catalog.materializeHistoricalViews(db, [snapshots[0].id])).get(
          snapshots[0].id,
        ),
      ),
    ),
  );
  for (const r of repeated) assert.deepEqual(r, cached);
  const physical = (
    await pool.query(
      "SELECT xmin::text,ctid::text FROM catalog_snapshot_views WHERE snapshot_id=$1",
      [snapshots[0].id],
    )
  ).rows[0];
  await pool.query(
    "UPDATE catalog_tags SET canonical=false WHERE name='Known'",
  );
  await transaction((db) =>
    catalog.materializeHistoricalViews(db, [snapshots[0].id]),
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT xmin::text,ctid::text FROM catalog_snapshot_views WHERE snapshot_id=$1",
        [snapshots[0].id],
      )
    ).rows[0],
    physical,
  );
  while (await catalog.projectCatalog(0, 20)) {}
  // Kill after bulk INSERT, before ACK/COMMIT. The queue and absence of the view survive.
  await pool.query("DELETE FROM catalog_snapshot_views WHERE snapshot_id=$1", [
    snapshots[1].id,
  ]);
  await pool.query("INSERT INTO catalog_snapshot_pending VALUES($1)", [
    snapshots[1].id,
  ]);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {pool}=require('./apps/api/dist/db');const {materializeHistoricalViews}=require('./apps/api/dist/catalog');(async()=>{const db=await pool.connect();await db.query('BEGIN');await materializeHistoricalViews(db,[process.env.HISTORY_SNAPSHOT]);process.send('ready');setInterval(()=>{},1000);})().catch(e=>{console.error(e);process.exit(1)});`,
    ],
    {
      env: { ...process.env, HISTORY_SNAPSHOT: snapshots[1].id },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw Error("Child exited before materialization");
    }),
  ]);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  clearTimeout(timeout);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_snapshot_views WHERE snapshot_id=$1",
        [snapshots[1].id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_snapshot_pending WHERE snapshot_id=$1",
        [snapshots[1].id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(await catalog.projectCatalog(0, 20), 1);
  assert.equal(await currentState(pool), before);
  // Rollback all view/dictionary effects on a failed transaction, then retry.
  await pool.query("DELETE FROM catalog_snapshot_views WHERE snapshot_id=$1", [
    snapshots[2].id,
  ]);
  await assert.rejects(
    transaction(async (db) => {
      await catalog.materializeHistoricalViews(db, [snapshots[2].id]);
      throw Error("injected");
    }),
    /injected/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_snapshot_views WHERE snapshot_id=$1",
        [snapshots[2].id],
      )
    ).rows[0].n,
    0,
  );
  await transaction((db) =>
    catalog.materializeHistoricalViews(db, [snapshots[2].id]),
  );
  const report = {
    versions: 3,
    shared_pack_objects_read_once: true,
    equivalence: true,
    first_entity_fact: true,
    historical_tag_attributes_ignored: true,
    current_graph_filter_semantics: true,
    anonymous: true,
    alias_difference_preexisting: aliasDifference,
    on_demand_background_concurrency: true,
    immutable_existing_views: true,
    crash_after_insert_and_retry: true,
    rollback: true,
    current_documents_associations_generations_unchanged: true,
  };
  fs.writeFileSync(
    "/results/history-functional.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await pool.end();
  await require("../apps/api/old-dist/db").pool.end();
  await admin.query("DROP SCHEMA " + schema + " CASCADE");
  await admin.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
