// Real archived works; P1A tag phase ends immediately before entity processing.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { pool } = require("../apps/api/dist/db");
const bib = require("../apps/api/dist/catalog-bibliography");
const { hydrateWorks } = require("../apps/api/dist/archive-catalog");
const { loadSnapshot } = require("../apps/api/dist/catalog");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test only");
(async () => {
  const db = await pool.connect(),
    mode = process.argv[2];
  assert.ok(["old", "new"].includes(mode), "Mode must be old or new");
  const inputs = [];
  await db.query("BEGIN");
  for (const work of await hydrateWorks(
    db,
    (await db.query("SELECT * FROM archive_works ORDER BY id LIMIT 1024")).rows,
  )) {
    const { manifest } = await loadSnapshot(db, work.id);
    inputs.push({
      work,
      raw: await bib.enrichBibliography(db, work.metadata, manifest),
    });
  }
  await db.query("COMMIT");
  assert.equal(inputs.length, 1024, "Complete real-corpus sample required");
  assert.ok(
    inputs.every(
      ({ raw }) =>
        !(raw.ao3?.tags ?? []).some(
          (t) =>
            t.synonym_of !== undefined ||
            t.meta_tags !== undefined ||
            t.parents !== undefined,
        ),
    ),
    "This measurement excludes graph-edge processing",
  );
  const results = [];
  const boundary = {};
  for (const batch of [20, 64, 256]) {
    // Logged isolated tables retain uniqueness/indexes and normal WAL.
    await db.query(
      `CREATE SCHEMA p1b_tags_${mode}_${batch}; SET search_path=p1b_tags_${mode}_${batch},public`,
    );
    await db.query(
      "CREATE TABLE catalog_tags (LIKE public.catalog_tags INCLUDING ALL); CREATE TABLE catalog_work_tags (LIKE public.catalog_work_tags INCLUDING ALL); CREATE TABLE catalog_tag_edges (LIKE public.catalog_tag_edges INCLUDING ALL)",
    );
    for (const phase of ["initial", "repeat"]) {
      const before = (await db.query("SELECT pg_current_wal_insert_lsn() lsn"))
        .rows[0].lsn;
      const cpu = process.cpuUsage(),
        start = performance.now();
      let queries = 0,
        upserts = 0,
        associations = 0,
        removed = 0,
        commits = 0;
      const timed = Object.create(db);
      timed.query = async (sql, args) => {
        if (sql.startsWith("DELETE FROM catalog_entity_works")) throw boundary;
        queries++;
        const r = await db.query(sql, args);
        if (sql.startsWith("INSERT INTO catalog_tags")) upserts += r.rowCount;
        if (sql.startsWith("INSERT INTO catalog_work_tags"))
          associations += r.rowCount;
        if (sql.startsWith("DELETE FROM catalog_work_tags"))
          removed += r.rowCount;
        return r;
      };
      for (let i = 0; i < inputs.length; i += batch) {
        await timed.query("BEGIN");
        await timed.query("SELECT pg_advisory_xact_lock(70210408)");
        const group = inputs.slice(i, i + batch);
        if (mode === "new") await bib.projectTagBatch(timed, group);
        else
          for (const { work, raw } of group) {
            try {
              await bib.projectBibliography(timed, work, raw);
            } catch (e) {
              if (e !== boundary) throw e;
            }
          }
        await timed.query("COMMIT");
        commits++;
      }
      const seconds = (performance.now() - start) / 1000,
        usage = process.cpuUsage(cpu);
      const wal = Number(
        (
          await db.query(
            "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) n",
            [before],
          )
        ).rows[0].n,
      );
      const counts = (
        await db.query(
          "SELECT (SELECT count(*) FROM catalog_tags)::int tags,(SELECT count(*) FROM catalog_work_tags)::int associations",
        )
      ).rows[0];
      results.push({
        mode,
        batch,
        phase,
        works: inputs.length,
        seconds,
        queries,
        queries_per_work: queries / inputs.length,
        commits,
        upserts,
        association_inserts: associations,
        removed,
        wal_bytes: wal,
        cpu_seconds: (usage.user + usage.system) / 1e6,
        rss_mib: process.memoryUsage().rss / 1048576,
        process_peak_rss_mib: process.resourceUsage().maxRSS / 1024,
        ...counts,
      });
    }
    await db.query(
      `SET search_path=public; DROP SCHEMA p1b_tags_${mode}_${batch} CASCADE`,
    );
  }
  fs.writeFileSync(
    "/results/tags-" + mode + ".json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
  db.release();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
