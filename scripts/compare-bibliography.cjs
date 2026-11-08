// Content stays in the private fixture. Public output contains only counts.
// Capture P1A, clone its canonical DB/PackStore, rebuild projections, then compare.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db");
const [mode, filename] = process.argv.slice(2);
if (
  !["capture", "compare"].includes(mode) ||
  !filename?.startsWith("/results/") ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw Error("Isolated fixture and private /results file required");
function normalized(value, field = "") {
  if (Array.isArray(value)) {
    const result = value.map((v) => normalized(v));
    if (["tags", "entities", "filterTags"].includes(field))
      result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return result;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalized(value[k], k)]),
    );
  return value;
}
const relations = {
  heads: `SELECT id::text key,jsonb_build_object('external_id',external_id,'snapshot',current_snapshot_id,'metadata_hash',encode(metadata_hash,'hex')) value FROM archive_work_heads`,
  snapshots: `SELECT id::text key,to_jsonb(s) value FROM archive_snapshots s`,
  identities: `SELECT work_id::text||':'||canonical_work_id::text key,to_jsonb(l) value FROM archive_identity_links l`,
  documents: `SELECT work_id::text key,jsonb_build_object('snapshot',snapshot_id,'metadata',metadata,'title',title,'bibliography',bibliography) value FROM catalog_documents`,
  historical: `SELECT snapshot_id::text key,jsonb_build_object('metadata',metadata,'bibliography',bibliography) value FROM catalog_snapshot_views`,
  tags: `SELECT id key,to_jsonb(t) value FROM catalog_tags t`,
  entities: `SELECT id key,to_jsonb(e) value FROM catalog_entities e`,
  edges: `SELECT child||':'||parent||':'||kind key,to_jsonb(e) value FROM catalog_tag_edges e`,
  work_tags: `SELECT work_id::text||':'||tag_id key,to_jsonb(t) value FROM catalog_work_tags t`,
  work_entities: `SELECT work_id::text||':'||entity_id key,to_jsonb(e) value FROM catalog_entity_works e`,
  filters: `SELECT work_id::text||':'||tag_id key,to_jsonb(f) value FROM catalog_work_filters f`,
};
(async () => {
  const db = await pool.connect();
  const result = {
    schema: "palimora.bibliography-equivalence.v1",
    relations: {},
  };
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const pending = (
      await db.query(
        "SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending)+(SELECT count(*) FROM catalog_graph_pending)+(SELECT count(*) FROM catalog_text_pending) n",
      )
    ).rows[0].n;
    assert.equal(Number(pending), 0, "Drain all queues before comparison");
    for (const [name, sql] of Object.entries(relations)) {
      const hashes = [];
      await db.query(
        `DECLARE ${name}_cursor NO SCROLL CURSOR FOR SELECT * FROM (${sql}) r ORDER BY key COLLATE "C"`,
      );
      while (true) {
        const rows = (await db.query(`FETCH FORWARD 256 FROM ${name}_cursor`))
          .rows;
        if (!rows.length) break;
        for (const row of rows)
          hashes.push([
            row.key,
            crypto
              .createHash("sha256")
              .update(JSON.stringify(normalized(row.value)))
              .digest("hex"),
          ]);
      }
      await db.query(`CLOSE ${name}_cursor`);
      result.relations[name] = hashes;
    }
    assert.equal(result.relations.heads.length, 11032);
    assert.equal(result.relations.documents.length, 11032);
    assert.equal(
      result.relations.historical.length,
      result.relations.snapshots.length,
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  if (mode === "capture") {
    fs.writeFileSync(filename, JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    const reference = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(reference.schema, result.schema);
    const differences = {};
    for (const [name, rows] of Object.entries(result.relations)) {
      const expected = new Map(reference.relations[name]);
      let added = 0,
        changed = 0;
      for (const [id, hash] of rows) {
        if (!expected.has(id)) added++;
        else if (expected.get(id) !== hash) changed++;
        expected.delete(id);
      }
      differences[name] = { added, changed, removed: expected.size };
    }
    fs.writeFileSync(
      path.join(path.dirname(filename), "equivalence-result.json"),
      JSON.stringify(differences, null, 2),
      { mode: 0o600 },
    );
    assert.ok(
      Object.values(differences).every((v) =>
        Object.values(v).every((n) => n === 0),
      ),
      "Bibliographic values or relationships differ; see private aggregate result",
    );
  }
  console.log(
    JSON.stringify({
      mode,
      counts: Object.fromEntries(
        Object.entries(result.relations).map(([name, rows]) => [
          name,
          rows.length,
        ]),
      ),
    }),
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
