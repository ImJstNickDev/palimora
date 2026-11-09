// Run only after the timed pipeline, inside its private test container.
const fs = require("node:fs"),
  path = require("node:path");
const crypto = require("node:crypto");
const { pool } = require("../apps/api/dist/db");
const { store } = require("../apps/api/dist/archive");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
function bytes(root) {
  let apparent = 0,
    allocated = 0,
    files = 0;
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, name.name);
    if (name.isDirectory()) {
      const x = bytes(p);
      apparent += x.apparent;
      allocated += x.allocated;
      files += x.files;
    } else {
      const s = fs.statSync(p);
      apparent += s.size;
      allocated += s.blocks * 512;
      files++;
    }
  }
  return { apparent, allocated, files };
}
(async () => {
  const stable = (x) =>
    Array.isArray(x)
      ? x.map(stable)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, stable(x[k])]),
          )
        : x;
  const manifests = [];
  const counts = (
    await pool.query(
      `SELECT (SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_chapter_revisions) revisions,(SELECT count(*) FROM archive_object_data) objects,(SELECT sum(size) FROM archive_object_data) raw_bytes,(SELECT sum(length) FROM archive_object_data) referenced_record_bytes,(SELECT count(*) FROM archive_packs) packs,pg_database_size(current_database()) database_bytes`,
    )
  ).rows[0];
  let verified = 0,
    last = "";
  while (true) {
    const rows = (
      await pool.query(
        `SELECT encode(o.hash,'hex') hash,p.name pack,o.byte_offset AS offset,o.length,o.size,k.name kind FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id WHERE o.hash>decode($1,'hex') ORDER BY o.hash LIMIT 256`,
        [last],
      )
    ).rows;
    if (!rows.length) break;
    const buffers = await store.readMany(
      rows.map((r) => ({
        ...r,
        offset: Number(r.offset),
        length: Number(r.length),
        size: Number(r.size),
      })),
    );
    for (const [index, r] of rows.entries()) {
      const data = buffers[index];
      if (r.kind === "manifest") {
        const m = JSON.parse(data);
        delete m.work_id;
        for (const chapter of m.chapters ?? []) {
          delete chapter.chapter_id;
          delete chapter.revision_id;
        }
        manifests.push(
          crypto
            .createHash("sha256")
            .update(JSON.stringify(stable(m)))
            .digest("hex"),
        );
      }
      verified++;
    }
    last = rows.at(-1).hash;
  }
  const sources = (
    await pool.query(
      "SELECT path,state,checkpoint,imported,duplicates,gaps FROM ingest_sources ORDER BY path",
    )
  ).rows;
  const content = (
    await pool.query(`SELECT k.name,count(*)::text objects,sum(o.size)::text bytes,
    md5(string_agg(encode(o.hash,'hex'),'' ORDER BY o.hash)) hash_set
    FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id
    WHERE k.name <> 'manifest' GROUP BY k.name ORDER BY k.name`)
  ).rows;
  const logical = (
    await pool.query(`SELECT
    (SELECT count(*) FROM archive_snapshot_chapters) snapshot_chapters,
    (SELECT count(*) FROM ingest_results) acquisitions,
    (SELECT count(*) FROM catalog_snapshot_views) historical_views,
    (SELECT count(*) FROM catalog_documents) documents`)
  ).rows[0];
  const metadata = (
    await pool.query(`SELECT
    (SELECT md5(string_agg(h.external_id||d.metadata::text||d.bibliography::text,'' ORDER BY h.external_id)) FROM catalog_documents d JOIN archive_work_heads h ON h.id=d.work_id) current,
    (SELECT md5(string_agg(h.external_id||v.metadata::text||v.bibliography::text,'' ORDER BY h.external_id)) FROM catalog_snapshot_views v JOIN archive_snapshots s ON s.id=v.snapshot_id JOIN archive_work_heads h ON h.id=s.work_id) historical`)
  ).rows[0];
  const {
    searchRequest,
    SEARCH_INDEX,
  } = require("../apps/api/dist/catalog-search");

  const ids = new Map(
    (
      await pool.query("SELECT id,external_id FROM archive_work_heads")
    ).rows.map((r) => [r.id, r.external_id]),
  );
  const documents = [];
  let after;
  while (true) {
    const page = await searchRequest("/" + SEARCH_INDEX + "/_search", {
      size: 1000,
      sort: [{ id: "asc" }],
      ...(after ? { search_after: after } : {}),
      query: { match_all: {} },
    });
    if (!page.hits.hits.length) break;
    for (const hit of page.hits.hits) {
      const d = hit._source;
      for (const k of ["id", "snapshot", "generation", "epoch", "archived_at"])
        delete d[k];
      documents.push([
        ids.get(hit._id),
        crypto
          .createHash("sha256")
          .update(JSON.stringify(stable(d)))
          .digest("hex"),
      ]);
    }
    after = page.hits.hits.at(-1).sort;
  }
  documents.sort((a, b) => a[0].localeCompare(b[0]));
  const search_content_sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(documents))
    .digest("hex");
  const { scanPackRecords } = require("../apps/api/dist/pack");
  const physicalHashes = new Set();
  let physicalRecords = 0,
    physicalDuplicates = 0,
    duplicateRecordBytes = 0;
  const packSizes = [];
  for (const pack of fs.readdirSync(path.join(store.root, "packs"))) {
    packSizes.push(fs.statSync(path.join(store.root, "packs", pack)).size);
    for await (const r of scanPackRecords(store.root, pack)) {
      physicalRecords++;
      if (physicalHashes.has(r.hash)) {
        physicalDuplicates++;
        duplicateRecordBytes += r.length;
      }
      physicalHashes.add(r.hash);
    }
  }
  packSizes.sort((a, b) => a - b);
  const result = {
    counts,
    physical: {
      records: physicalRecords,
      unique_hashes: physicalHashes.size,
      duplicates: physicalDuplicates,
      duplicate_record_bytes: duplicateRecordBytes,
      pack_sizes: packSizes,
    },
    cache: fs.existsSync(path.join(store.root, "cache"))
      ? bytes(path.join(store.root, "cache"))
      : { apparent: 0, allocated: 0, files: 0 },
    normalized_manifest_sha256: crypto
      .createHash("sha256")
      .update(manifests.sort().join(""))
      .digest("hex"),
    metadata,
    search_content_sha256,
    search_documents: documents.length,
    content,
    logical,
    sources,
    verified_objects: verified,
    storage: bytes(store.root),
    packs: bytes(path.join(store.root, "packs")),
    staging: bytes(path.join(store.root, "staging")),
  };
  fs.writeFileSync(
    "/results/p3a-storage.json",
    JSON.stringify(result, null, 2),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
