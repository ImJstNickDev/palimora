const assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db");
const {
  projectCurrentBibliographies,
  projectTagBatch,
  projectBibliography,
} = require("../apps/api/dist/catalog-bibliography");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const db = await pool.connect();
  const works = (
    await db.query(
      "SELECT id,current_snapshot_id FROM archive_work_heads ORDER BY id LIMIT 4",
    )
  ).rows;
  const tag = (name, id, canonical) => ({
    kind: "freeform",
    name,
    id,
    canonical,
  });
  const raw = (tags, extra = {}) => ({
    title: ["test"],
    ao3: { schema: "palimora-ao3-v1", tags },
    ...extra,
  });
  const inputs = [
    {
      work: works[0],
      raw: raw(
        [
          tag("P1B shared", "p1b-shared", false),
          tag("P1B local", undefined, undefined),
          { kind: "fandom", name: "P1B ambiguous", id: "p1b-fandom" },
          { kind: "characters", name: "P1B ambiguous", id: "p1b-character" },
        ],
        {
          unclassified: ["P1B parent", "P1B ambiguous"],
          warnings: ["P1B repeated", "P1B repeated"],
        },
      ),
    },
    {
      work: works[1],
      raw: raw([
        tag("P1B shared", "p1b-ignored", true),
        tag("P1B local", "p1b-local", true),
        tag("P1B parent", "p1b-parent", true),
      ]),
    },
    {
      work: works[2],
      raw: raw([
        {
          ...tag("P1B child", "p1b-child", false),
          synonym_of: "p1b-shared",
          meta_tags: ["p1b-parent", "p1b-future"],
          parents: ["p1b-parent"],
        },
      ]),
    },
    {
      work: works[3],
      raw: raw([tag("P1B future", "p1b-future", true)]),
    },
  ];
  const norm = (v) =>
    Array.isArray(v)
      ? v
          .map(norm)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, norm(v[k])]),
          )
        : v;
  async function scenario(bulk) {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(70210408)");
    const output = [];
    if (bulk)
      for await (const r of projectCurrentBibliographies(db, inputs))
        output.push(r.projected);
    else
      for (const i of inputs)
        output.push(await projectBibliography(db, i.work, i.raw));
    const tags = (
      await db.query(
        "SELECT * FROM catalog_tags WHERE name LIKE 'P1B %' ORDER BY name",
      )
    ).rows;
    const associations = (
      await db.query(
        "SELECT * FROM catalog_work_tags WHERE work_id=ANY($1::uuid[]) ORDER BY work_id,tag_id",
        [works.map((w) => w.id)],
      )
    ).rows;
    const filters = (
      await db.query(
        "SELECT * FROM catalog_work_filters WHERE work_id=ANY($1::uuid[]) ORDER BY work_id,tag_id",
        [works.map((w) => w.id)],
      )
    ).rows;
    const edges = (
      await db.query(
        "SELECT e.* FROM catalog_tag_edges e JOIN catalog_tags t ON t.id=e.child WHERE t.name LIKE 'P1B %' ORDER BY child,parent,kind",
      )
    ).rows;
    if (bulk) {
      const before = (
        await db.query(
          "SELECT xmin::text,ctid::text FROM catalog_work_tags WHERE work_id=$1 ORDER BY tag_id",
          [works[1].id],
        )
      ).rows;
      await projectTagBatch(db, [inputs[1]]);
      assert.deepEqual(
        (
          await db.query(
            "SELECT xmin::text,ctid::text FROM catalog_work_tags WHERE work_id=$1 ORDER BY tag_id",
            [works[1].id],
          )
        ).rows,
        before,
      );
      await projectTagBatch(db, [{ work: works[0], raw: raw([]) }]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM catalog_work_tags WHERE work_id=$1",
            [works[0].id],
          )
        ).rows[0].n,
        0,
      );
    }
    await db.query("ROLLBACK");
    return norm({ output, tags, associations, filters, edges });
  }
  assert.deepEqual(await scenario(true), await scenario(false));
  await db.query("BEGIN");
  await assert.rejects(
    projectTagBatch(db, [
      {
        work: works[0],
        raw: raw([
          tag("P1B collision A", "p1b-conflict", true),
          tag("P1B collision B", "p1b-conflict", true),
        ]),
      },
    ]),
    (e) => e.code === "23505",
  );
  await db.query("ROLLBACK");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM catalog_tags WHERE name LIKE 'P1B %'",
      )
    ).rows[0].n,
    0,
  );
  // Disconnect a backend after the bulk writes, before COMMIT. PostgreSQL must
  // discard every tag/association write and release the shared projection lock.
  const interrupted = await pool.connect();
  interrupted.on("error", () => {});
  await interrupted.query("BEGIN");
  await interrupted.query("SELECT pg_advisory_xact_lock(70210408)");
  const pid = (await interrupted.query("SELECT pg_backend_pid() pid")).rows[0]
    .pid;
  await projectTagBatch(interrupted, inputs.slice(0, 2));
  assert.equal(
    (await db.query("SELECT pg_terminate_backend($1) terminated", [pid]))
      .rows[0].terminated,
    true,
  );
  interrupted.release(true);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM catalog_tags WHERE name LIKE 'P1B %'",
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(await scenario(true), await scenario(false));
  console.log(
    JSON.stringify({
      equivalence: true,
      shared_tags: true,
      edges_and_filters: true,
      no_op_associations: true,
      removal: true,
      conflict_rollback_and_retry: true,
      backend_disconnect_after_bulk_writes: true,
    }),
  );
  db.release();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
