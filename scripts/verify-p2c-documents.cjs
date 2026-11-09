// Full same-identity comparison after the timed pipeline, using the P2A builder
// whose output was verified against P1B.1. Reference writes use a test-only index.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pool, transaction } = require("../apps/api/dist/db");
const search = require("../apps/api/dist/catalog-search");
const oldSearch = require("../apps/api/p2a-dist/catalog-search");
const oldCatalog = require("../apps/api/p2a-dist/catalog");
const catalog = require("../apps/api/dist/catalog");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Private fixture only");
const reference = "palimora-p2c-reference";
const checkpoint = process.env.P2C_REFERENCE_REPORT
  ? JSON.parse(fs.readFileSync(process.env.P2C_REFERENCE_REPORT, "utf8"))
  : null;
const hash = (x) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const fingerprint = async () =>
  (
    await pool.query(`SELECT
 (SELECT count(*)::int FROM archive_work_heads) works,
 (SELECT count(*)::int FROM archive_snapshots) snapshots,
 (SELECT count(*)::int FROM catalog_documents) documents,
 (SELECT count(*)::int FROM catalog_snapshot_views) historical_views,
 (SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM archive_snapshots s) canonical,
 (SELECT md5(string_agg(snapshot_id::text||metadata::text||bibliography::text,'' ORDER BY snapshot_id)) FROM catalog_snapshot_views) historical`)
  ).rows[0];
let created = false;
(async () => {
  const before = await fingerprint();
  for (const k of ["works", "snapshots", "documents", "historical_views"])
    assert.equal(before[k], 11032);
  if (checkpoint) {
    assert.equal(checkpoint.verified, 11032);
    assert.equal(checkpoint.full_source_hashes_equal, true);
    assert.deepEqual(
      before,
      checkpoint.counts,
      "Clone must preserve reference identities and history",
    );
  }
  if (!checkpoint) {
    const description = (
      await search.searchRequest("/" + search.SEARCH_INDEX, undefined, "GET")
    )[search.SEARCH_INDEX];
    const exists = await search.searchRequest(
      "/" + reference,
      undefined,
      "HEAD",
      true,
    );
    assert.equal(exists.status, 404, "Reference index must not already exist");
    await search.searchRequest(
      "/" + reference,
      {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: description.settings.index.analysis,
        },
        mappings: description.mappings,
      },
      "PUT",
    );
    created = true;
  }
  let cursor = "",
    verified = 0;
  const digest = crypto.createHash("sha256");
  for (;;) {
    const rows = (
      await pool.query(
        "SELECT * FROM catalog_documents WHERE work_id::text>$1 ORDER BY work_id LIMIT 64",
        [cursor],
      )
    ).rows;
    if (!rows.length) break;
    const expected = checkpoint
      ? null
      : await transaction(async (db) => {
          await db.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
          );
          const docs = [];
          for (const row of rows)
            docs.push(
              JSON.parse(
                JSON.stringify(await oldSearch.prepareTextDocument(db, row)),
              ),
            );
          return docs;
        });
    const actual = await search.searchRequest(
      "/" + search.SEARCH_INDEX + "/_mget",
      { ids: rows.map((r) => r.work_id) },
    );
    for (let i = 0; i < rows.length; i++) {
      assert.ok(actual.docs[i].found);
      if (expected)
        assert.equal(
          hash(actual.docs[i]._source),
          hash(expected[i]),
          "Complete _source mismatch",
        );
      assert.equal(actual.docs[i]._source.generation, rows[i].generation);
      assert.equal(actual.docs[i]._source.snapshot, rows[i].snapshot_id);
      digest.update(rows[i].work_id + hash(actual.docs[i]._source));
      verified++;
    }
    if (expected) {
      let lines = "",
        bytes = 0;
      const flush = async () => {
        if (!lines) return;
        const r = await fetch(
          (process.env.OPENSEARCH_URL ?? "http://opensearch:9200") + "/_bulk",
          {
            method: "POST",
            headers: { "content-type": "application/x-ndjson" },
            body: lines,
            signal: AbortSignal.timeout(30000),
          },
        );
        assert.ok(r.ok);
        const result = await r.json();
        assert.equal(result.errors, false);
        assert.ok(
          result.items.every(
            (i) => i.index.status >= 200 && i.index.status < 300,
          ),
        );
        lines = "";
        bytes = 0;
      };
      for (let i = 0; i < expected.length; i++) {
        const line =
          JSON.stringify({
            index: { _index: reference, _id: rows[i].work_id },
          }) +
          "\n" +
          JSON.stringify(expected[i]) +
          "\n";
        const size = Buffer.byteLength(line);
        if (bytes && bytes + size > 8 * 1024 * 1024) await flush();
        lines += line;
        bytes += size;
      }
      await flush();
    }
    cursor = rows.at(-1).work_id;
  }
  assert.equal(verified, 11032);
  const sourceDigest = digest.digest("hex");
  if (checkpoint)
    assert.equal(
      sourceDigest,
      checkpoint.source_digest,
      "Complete clone source digest changed",
    );
  await search.searchRequest(
    "/" +
      (checkpoint ? "" : reference + ",") +
      search.SEARCH_INDEX +
      "/_refresh",
    {},
  );
  const queries = [
    { match_all: {} },
    { match: { "text.en": "love" } },
    { match: { title: "love" } },
    { term: { availability: "unknown" } },
    { range: { word_count: { gte: 10000 } } },
  ];
  const results = [];
  for (const query of queries) {
    const run = async (index) => {
      const r = await search.searchRequest("/" + index + "/_search", {
        size: 100,
        query,
        sort: [{ id: "asc" }],
        track_total_hits: true,
      });
      return { total: r.hits.total.value, ids: r.hits.hits.map((h) => h._id) };
    };
    const a = await run(search.SEARCH_INDEX);
    const result = { total: a.total, first100_ids_sha256: hash(a.ids) };
    if (checkpoint)
      assert.deepEqual(result, checkpoint.searches[results.length]);
    else assert.deepEqual(a, await run(reference));
    results.push(result);
  }
  const samples = (
    await pool.query(
      "SELECT work_id,snapshot_id FROM (SELECT work_id,snapshot_id,row_number() over(order by work_id) n FROM catalog_documents) d WHERE n%1379=1",
    )
  ).rows;
  for (const row of samples)
    await transaction(async (db) => {
      const request = { id: row.work_id, snapshot: row.snapshot_id };
      assert.deepEqual(
        await catalog.catalogOperation(db, "readerWork", request),
        await oldCatalog.catalogOperation(db, "readerWork", request),
      );
    });
  assert.deepEqual(await fingerprint(), before);
  const queues = (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM catalog_pending) current,(SELECT count(*)::int FROM catalog_snapshot_pending) historical,(SELECT count(*)::int FROM catalog_graph_pending) graph,(SELECT count(*)::int FROM catalog_text_pending) text",
    )
  ).rows[0];
  assert.ok(Object.values(queues).every((x) => x === 0));
  const report = {
    reference_commit: "ad6f91ff16d8f66aaa36fd70025fbd096414cfc6",
    reference_chain:
      "P2A builder previously byte-verified against P1B.1; same database identities/timestamps in this comparison",
    verified,
    full_source_hashes_equal: true,
    ids_generations_snapshots_equal: true,
    source_digest: sourceDigest,
    saved_same_identity_reference: Boolean(checkpoint),
    searches: results,
    reader_historical_samples: samples.length,
    canonical_and_history_unchanged: true,
    counts: before,
    queues,
  };
  fs.writeFileSync(
    "/results/p2c-equivalence.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})()
  .finally(async () => {
    if (created)
      await search.searchRequest("/" + reference, undefined, "DELETE");
    await pool.end();
    await require("../apps/api/p2a-dist/db").pool.end();
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
