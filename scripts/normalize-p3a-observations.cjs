// Compare preserved evidence while validating its local snapshot/manifest links.
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db"),
  { store } = require("../apps/api/dist/archive");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
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
const hash = (x) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(x)))
    .digest("hex");
(async () => {
  const works = new Map(
    (
      await pool.query(
        "SELECT id,coalesce(external_id,'provisional:'||provisional_key) AS external_id FROM archive_works",
      )
    ).rows.map((r) => [r.id, r.external_id]),
  );
  const snapshots = new Map(
    (
      await pool.query("SELECT id,work_id,manifest_hash FROM archive_snapshots")
    ).rows.map((r) => [r.id, r]),
  );
  const manifests = new Map(),
    observations = [];
  for (const kind of ["manifest", "observation"]) {
    const rows = (
      await pool.query(
        "SELECT encode(o.hash,'hex') hash,p.name pack,o.byte_offset AS offset,o.length,o.size,k.name kind FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id WHERE k.name=$1 ORDER BY o.hash",
        [kind],
      )
    ).rows;
    for (let i = 0; i < rows.length; i += 256) {
      const part = rows.slice(i, i + 256),
        buffers = await store.readMany(
          part.map((r) => ({
            ...r,
            offset: Number(r.offset),
            length: Number(r.length),
            size: Number(r.size),
          })),
        );
      for (let j = 0; j < part.length; j++) {
        const obj = JSON.parse(buffers[j]);
        if (kind === "manifest") {
          delete obj.work_id;
          for (const c of obj.chapters ?? []) {
            delete c.chapter_id;
            delete c.revision_id;
          }
          manifests.set(part[j].hash, hash(obj));
        } else {
          const snapshot = snapshots.get(obj.snapshot_id);
          assert.ok(snapshot);
          assert.equal(snapshot.work_id, obj.work_id);
          assert.equal(snapshot.manifest_hash, obj.manifest_hash);
          assert.ok(manifests.has(obj.manifest_hash));
          obj.work_id = works.get(obj.work_id);
          assert.ok(obj.work_id);
          obj.manifest_hash = manifests.get(obj.manifest_hash);
          obj.snapshot_id = obj.manifest_hash;
          observations.push(hash(obj));
        }
      }
    }
  }
  fs.writeFileSync(
    "/results/p3a-normalized-observations.json",
    JSON.stringify({
      observations: observations.length,
      sha256: hash(observations.sort()),
    }),
  );
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
