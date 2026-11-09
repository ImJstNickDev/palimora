const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db"),
  { store } = require("../apps/api/dist/archive");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
(async () => {
  if (process.argv[2] === "provenance") {
    const expected = JSON.parse(fs.readFileSync("/results/expected-real.json"));
    const actual = (
      await pool.query(
        "SELECT source_path, evidence->>'source_hash' hash FROM archive_records",
      )
    ).rows;
    const known = new Set(actual.map((r) => r.source_path + "|" + r.hash));
    for (const r of expected) assert.ok(known.has(r.source + "|" + r.hash));
    const signatures = {};
    for (const table of [
      "archive_origins",
      "archive_identity_links",
      "archive_entries",
      "archive_record_data",
    ])
      signatures[table] = (
        await pool.query(
          `SELECT count(*)::int n,md5(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text)) digest FROM ${table} t`,
        )
      ).rows[0];
    fs.writeFileSync(
      process.argv[3],
      JSON.stringify(
        { sampled_source_hashes_verified: expected.length, signatures },
        null,
        2,
      ),
    );
    return;
  }
  if (process.argv[2] === "readers") {
    const { catalogOperation } = require("../apps/api/dist/catalog");
    const work = (
      await pool.query(
        "SELECT id FROM archive_work_heads WHERE external_id='899999999999'",
      )
    ).rows[0].id;
    const snapshots = (
      await pool.query(
        "SELECT id FROM archive_snapshots WHERE work_id=$1 ORDER BY id",
        [work],
      )
    ).rows;
    assert.equal(snapshots.length, 2);
    const digests = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const db = await pool.connect();
        try {
          const out = [];
          for (const s of snapshots) {
            const r = await catalogOperation(db, "readerContent", {
              id: work,
              snapshot: s.id,
            });
            assert.ok(r.document.length > 100);
            out.push(createHash("sha256").update(r.document).digest("hex"));
          }
          return out;
        } finally {
          db.release();
        }
      }),
    );
    assert.deepEqual(digests[0], digests[1]);
    assert.deepEqual(digests[0], digests[2]);
    assert.notEqual(digests[0][0], digests[0][1]);
    fs.writeFileSync(
      process.argv[3],
      JSON.stringify({
        clients: 3,
        requests: 6,
        historical_versions: 2,
        document_hashes: digests[0],
        errors: 0,
      }),
    );
    return;
  }
  const synth = (
    await pool.query(
      "SELECT id,external_id FROM archive_work_heads WHERE length(external_id)=12 AND external_id >= '900000000000' AND external_id < '900000070000' ORDER BY external_id",
    )
  ).rows;
  let expectedSynthetic = {};
  const identities = new Map(synth.map((r) => [r.id, r.external_id]));
  let syntheticManifests = 0;
  if (synth.length) {
    assert.equal(synth.length, 70000);
    synth.forEach((r, i) =>
      assert.equal(r.external_id, String(900000000000 + i)),
    );
    require("node:child_process").execFileSync(
      "python3",
      [
        "-c",
        `import zipfile,hashlib,json,re
out={};total=0
for i in range(4):
 with zipfile.ZipFile('/dumps/ao3_stories/synthetic-'+str(i)+'.zip') as z:
  for e in z.infolist():
   total+=e.file_size
   assert total<=1024**3
   b=z.read(e);identity=re.search(rb'^Story URL: https://archiveofourown.org/works/(\\d+)$',b,re.M)[1].decode();assert identity not in out;out[identity]=hashlib.sha256(b).hexdigest()
assert len(out)==70000
open('/results/expected-synthetic.json','w').write(json.dumps(out))`,
      ],
      { timeout: 120000 },
    );
    expectedSynthetic = JSON.parse(
      fs.readFileSync("/results/expected-synthetic.json"),
    );
  }
  let last = "",
    verified = 0;
  const hashes = createHash("sha256");
  while (true) {
    const rows = (
      await pool.query(
        "SELECT encode(o.hash,'hex') hash,p.name pack,o.byte_offset AS offset,o.length,o.size,k.name kind FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id WHERE o.hash>decode($1,'hex') ORDER BY o.hash LIMIT 256",
        [last],
      )
    ).rows;
    if (!rows.length) break;
    const data = await store.readMany(
      rows.map((r) => ({
        ...r,
        offset: Number(r.offset),
        length: Number(r.length),
        size: Number(r.size),
      })),
    );
    for (let i = 0; i < rows.length; i++) {
      assert.equal(
        createHash("sha256").update(data[i]).digest("hex"),
        rows[i].hash,
      );
      if (rows[i].kind === "manifest") {
        const m = JSON.parse(data[i]);
        const id = identities.get(m.work_id);
        if (id) {
          assert.equal(
            m.objects.find((o) => o.name === "original.txt").hash,
            expectedSynthetic[id],
          );
          assert.equal(m.chapters.length, 1);
          syntheticManifests++;
        }
      }
      hashes.update(rows[i].hash);
      verified++;
    }
    last = rows.at(-1).hash;
  }
  if (synth.length) assert.equal(syntheticManifests, 70000);
  const signatures = {};
  for (const table of [
    "archive_work_heads",
    "archive_snapshot_data",
    "archive_chapter_revisions",
    "archive_record_data",
    "archive_origin_data",
  ]) {
    try {
      signatures[table] = (
        await pool.query(
          `SELECT count(*)::int n,md5(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text)) digest FROM ${table} t`,
        )
      ).rows[0];
    } catch (e) {
      if (e.code !== "42P01") throw e;
    }
  }
  const expected = new Map(
    (
      await pool.query("SELECT work_id,generation FROM catalog_documents")
    ).rows.map((r) => [r.work_id, r.generation]),
  );
  let after,
    documents = 0;
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
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
      assert.equal(expected.get(hit._id), hit._source.generation);
      assert.ok(expected.delete(hit._id));
      documents++;
    }
    after = page.hits.hits.at(-1).sort;
  }
  assert.equal(expected.size, 0);
  const queues = (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM catalog_pending)+(SELECT count(*)::int FROM catalog_snapshot_pending)+(SELECT count(*)::int FROM catalog_text_pending) n",
    )
  ).rows[0].n;
  assert.equal(queues, 0);
  assert.equal(documents, signatures.archive_work_heads.n);
  fs.writeFileSync(
    process.argv[2] || "/results/verification-final.json",
    JSON.stringify(
      {
        verified_objects: verified,
        synthetic_manifests_verified: syntheticManifests,
        object_hash_set: hashes.digest("hex"),
        signatures,
        search_documents: documents,
        pending: queues,
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
