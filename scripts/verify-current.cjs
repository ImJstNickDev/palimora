// Differential entity/filter fixtures against P1B.1a; all changes roll back.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { pool } = require("../apps/api/dist/db"),
  bib = require("../apps/api/dist/catalog-bibliography"),
  catalog = require("../apps/api/dist/catalog");
const mode = process.argv[2];
if (
  !["old", "new"].includes(mode) ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw Error("Test only");
const normalized = (v, k = "") =>
  Array.isArray(v)
    ? ["tags", "entities", "filterTags"].includes(k)
      ? v
          .map((x) => normalized(x))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : v.map((x) => normalized(x))
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, normalized(v[k], k)]),
        )
      : v;
(async () => {
  const db = await pool.connect();
  const works = (
    await db.query(
      "SELECT id,current_snapshot_id,external_id FROM archive_work_heads ORDER BY id LIMIT 6",
    )
  ).rows.map((w) => ({ ...w, metadata: { title: ["P1B1b fixture"] } }));
  const tag = (name, extra = {}) => ({
    id: "p1b1b-" + name,
    name: "P1B1b " + name,
    kind: "freeform",
    ...extra,
  });
  const raw = (source = {}, extra = {}) => ({
    title: ["P1B1b fixture"],
    ao3: { schema: "palimora-ao3-v1", ...source },
    ...extra,
  });
  const inputs = [
    {
      work: works[0],
      raw: raw({
        authors: [
          {
            id: "p1b1b-shared",
            name: "P1B1b first",
            url: "https://archiveofourown.org/users/p1b1b",
            description: "kept",
            statistics: { works: 2, words: 10 },
          },
        ],
        series: [
          { id: "p1b1b-series", name: "P1B1b series", position: 1 },
          { id: "p1b1b-series", name: "P1B1b series second", position: 2 },
        ],
        collections: [
          {
            id: "p1b1b-collection",
            name: "P1B1b collection",
            parent_id: "p1b1b-parent",
            creators: ["p1b1b-shared"],
          },
        ],
        tags: [tag("root"), tag("parent", { meta_tags: ["p1b1b-root"] })],
        relations: [{ type: "related", work_id: "123" }],
      }),
    },
    {
      work: works[1],
      raw: raw({
        authors: [
          {
            id: "p1b1b-shared",
            name: "P1B1b last",
            notes: "added",
            statistics: { words: 30 },
          },
        ],
        series: [
          { id: "p1b1b-series", name: "P1B1b final series", position: 3 },
        ],
        tags: [tag("child", { synonym_of: "p1b1b-parent" })],
      }),
    },
    {
      work: works[2],
      raw: raw(
        {
          anonymous: true,
          authors: [{ id: "p1b1b-shared", name: "P1B1b anonymous evidence" }],
          pseuds: [
            {
              id: "p1b1b-pseud",
              name: "P1B1b pseud",
              owner_id: "p1b1b-shared",
            },
          ],
          tags: [tag("child")],
        },
        { creators: ["P1B1b hidden"] },
      ),
    },
    {
      work: works[3],
      raw: raw(
        {},
        {
          creators: ["P1B1b URL author"],
          author_urls: [
            "https://archiveofourown.org/users/p1b1b-user/pseuds/p1b1b-pseud",
          ],
          freeform: ["P1B1b child"],
        },
      ),
    },
    {
      work: works[4],
      raw: raw(
        {},
        {
          creators: ["P1B1b local"],
          series: ["P1B1b local series"],
          collections: ["P1B1b local collection"],
        },
      ),
    },
    {
      work: works[5],
      raw: raw(
        { tags: [tag("parent", { meta_tags: [] })] },
        { creators: ["P1B1b local"] },
      ),
    },
  ];
  async function state(output) {
    const result = { output };
    const queries = {
      entities:
        "SELECT * FROM catalog_entities WHERE name LIKE 'P1B1b %' OR source_id LIKE 'p1b1b-%' ORDER BY id",
      associations:
        "SELECT * FROM catalog_entity_works WHERE work_id=ANY($1::uuid[]) ORDER BY work_id,entity_id",
      filters:
        "SELECT * FROM catalog_work_filters WHERE work_id=ANY($1::uuid[]) ORDER BY work_id,tag_id",
      tags: "SELECT * FROM catalog_tags WHERE name LIKE 'P1B1b %' ORDER BY id",
      edges:
        "SELECT e.* FROM catalog_tag_edges e JOIN catalog_tags t ON t.id=e.child WHERE t.name LIKE 'P1B1b %' ORDER BY child,parent,kind",
    };
    for (const [name, sql] of Object.entries(queries))
      result[name] = (
        await db.query(
          sql,
          sql.includes("$1") ? [works.map((w) => w.id)] : undefined,
        )
      ).rows;
    return normalized(result);
  }
  async function project(items) {
    const output = [];
    for await (const r of bib.projectCurrentBibliographies(db, items))
      output.push(r);
    return output;
  }
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(70210408)");
  const first = await project(inputs),
    snapshot = await state(first);
  assert.equal(first[2].projected.metadata.creators[0], "Anonymous");
  assert.equal(first[2].projected.details.entities.length, 0);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM catalog_entity_works e JOIN catalog_entities t ON t.id=e.entity_id WHERE e.work_id=$1 AND t.kind IN('author','pseud')",
        [works[2].id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(first[1].projected.filterTags.length, 3);
  assert.equal(first[3].projected.filterTags.length, 3);
  assert.equal(first[5].projected.filterTags.length, 1);
  if (mode === "new") {
    await db.query("SAVEPOINT no_op_probe");
    // Repeat a stable graph group; filter/document generations must be independent of batch size.
    const stable = inputs.slice(2, 5),
      out = await project(stable);
    await catalog.writeCurrentDocuments(db, out);
    const physical = async () => {
      const r = {};
      for (const table of [
        "catalog_entity_works",
        "catalog_work_filters",
        "catalog_documents",
      ])
        r[table] = (
          await db.query(
            `SELECT ctid::text,xmin::text FROM ${table} WHERE work_id=ANY($1::uuid[]) ORDER BY ctid`,
            [stable.map((i) => i.work.id)],
          )
        ).rows;
      return r;
    };
    const before = await physical();
    for (const i of stable)
      await catalog.writeCurrentDocuments(db, await project([i]));
    assert.deepEqual(await physical(), before);
    await db.query("ROLLBACK TO SAVEPOINT no_op_probe");
  }
  const changed = [
    {
      work: works[0],
      raw: raw({
        series: [{ id: "p1b1b-series", name: "P1B1b moved", position: 9 }],
        tags: [],
      }),
    },
    {
      work: works[2],
      raw: raw(
        {},
        { creators: ["P1B1b revealed"], freeform: ["P1B1b parent"] },
      ),
    },
  ];
  const after = await state(await project(changed));
  await db.query("ROLLBACK");
  const result = { snapshot, after };
  if (mode === "old")
    fs.writeFileSync(
      "/results/current-fixture-reference.json",
      JSON.stringify(result),
      { flag: "wx" },
    );
  else
    assert.deepEqual(
      result,
      JSON.parse(
        fs.readFileSync("/results/current-fixture-reference.json", "utf8"),
      ),
    );
  // A uniqueness conflict after an earlier statement must roll the whole batch back.
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(70210408)");
  await db.query(
    "INSERT INTO catalog_entities(id,kind,source_id,name) VALUES('p1b1b-conflict','author','p1b1b-shared','P1B1b collision')",
  );
  await assert.rejects(project(inputs), (e) => e.code === "23505");
  await db.query("ROLLBACK");
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(70210408)");
  await project(inputs);
  await db.query("ROLLBACK");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM catalog_entities WHERE name LIKE 'P1B1b %' OR source_id LIKE 'p1b1b-%'",
      )
    ).rows[0].n,
    0,
  );
  if (mode === "new") {
    await db.query("BEGIN");
    const foreign = {
      ...works[0],
      current_snapshot_id: works[1].current_snapshot_id,
    };
    await assert.rejects(
      catalog.loadCurrentBibliographies(db, [foreign]),
      (e) => e.getStatus?.() === 404,
    );
    await db.query(
      "INSERT INTO archive_identity_links(work_id,canonical_work_id) VALUES($1,$2)",
      [works[1].id, works[0].id],
    );
    const expected = await catalog.loadSnapshot(
      db,
      works[0].id,
      works[1].current_snapshot_id,
    );
    assert.deepEqual(
      (await catalog.loadCurrentBibliographies(db, [foreign]))[0].raw,
      await bib.enrichBibliography(db, foreign.metadata, expected.manifest),
    );
    const { readObjectBatches } = require("../apps/api/dist/archive");
    await assert.rejects(async () => {
      for await (const object of readObjectBatches(db, ["0".repeat(64)]))
        void object;
    }, /OBJECT_MISSING/);
    await db.query("ROLLBACK");
  }
  console.log(
    JSON.stringify({
      mode,
      shared_entity_precedence: true,
      anonymous: true,
      pseuds_and_scoped_identities: true,
      recursive_filters_and_graph_barriers: true,
      changed_associations: true,
      rollback_retry: true,
      ...(mode === "new"
        ? {
            equivalence: true,
            unchanged_associations_filters_documents: true,
            batch_independent_generation: true,
            snapshot_ownership_aliases_and_missing_objects: true,
          }
        : {}),
    }),
  );
  db.release();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
