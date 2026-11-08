// Narrow current-projection benchmark on the retained real corpus. No ingest/search.
// Old and new use the same phase boundaries, inputs, transaction sizes and tables.
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { pool } = require("../apps/api/dist/db");
const bib = require("../apps/api/dist/catalog-bibliography"),
  catalog = require("../apps/api/dist/catalog");
const { hydrateWorks } = require("../apps/api/dist/archive-catalog");
const mode = process.argv[2];
if (
  !["old", "new"].includes(mode) ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Private fixture only");
const tables = [
  "catalog_tags",
  "catalog_tag_edges",
  "catalog_work_tags",
  "catalog_entities",
  "catalog_entity_works",
  "catalog_work_filters",
  "catalog_documents",
];
(async () => {
  const db = await pool.connect();
  const ids = (
    await db.query("SELECT id FROM archive_works ORDER BY id LIMIT 1024")
  ).rows.map((r) => r.id);
  assert.equal(ids.length, 1024);
  const results = [];
  for (const batch of [20, 64, 256]) {
    const schema = `p1b_current_${mode}_${batch}`;
    await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const table of tables)
      await db.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    for (const phase of ["initial", "repeat"]) {
      const phases = Object.fromEntries(
        [
          "coordination",
          "lookup_manifest",
          "tags",
          "entities",
          "filters",
          "documents",
        ].map((k) => [
          k,
          { seconds: 0, queries: 0, sql_seconds: 0, modified_rows: {} },
        ]),
      );
      let active = "coordination",
        began = performance.now(),
        commits = 0;
      const switchTo = (next) => {
        const now = performance.now();
        phases[active].seconds += (now - began) / 1000;
        active = next;
        began = now;
      };
      const timed = Object.create(db);
      timed.query = async (sql, args) => {
        if (mode === "old" && sql.startsWith("WITH RECURSIVE closure"))
          switchTo("filters");
        const metric = phases[active],
          start = performance.now();
        metric.queries++;
        const r = await db.query(sql, args);
        metric.sql_seconds += (performance.now() - start) / 1000;
        const change = sql.match(
          /^(INSERT INTO|DELETE FROM|UPDATE) (catalog_\w+)/,
        );
        if (change) {
          const key = change[1] + " " + change[2];
          metric.modified_rows[key] =
            (metric.modified_rows[key] ?? 0) + r.rowCount;
        }
        return r;
      };
      const walBefore = (
        await db.query("SELECT pg_current_wal_insert_lsn() lsn")
      ).rows[0].lsn;
      const cpu = process.cpuUsage(),
        start = performance.now();
      began = start;
      for (let i = 0; i < ids.length; i += batch) {
        switchTo("coordination");
        await timed.query("BEGIN; SET LOCAL default_toast_compression=lz4");
        await timed.query("SELECT pg_advisory_xact_lock(70210408)");
        switchTo("lookup_manifest");
        const works = await hydrateWorks(
          timed,
          (
            await timed.query(
              "SELECT * FROM archive_works WHERE id=ANY($1::uuid[])",
              [ids.slice(i, i + batch)],
            )
          ).rows,
        );
        let inputs = [];
        if (mode === "new")
          inputs = await catalog.loadCurrentBibliographies(timed, works);
        else
          for (const work of works) {
            const manifest = work.current_snapshot_id
              ? (await catalog.loadSnapshot(timed, work.id)).manifest
              : null;
            inputs.push({
              work,
              raw: await bib.enrichBibliography(timed, work.metadata, manifest),
            });
          }
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
          "Real sample must have no graph barriers",
        );
        switchTo("tags");
        const prepared = await bib.projectTagBatch(timed, inputs);
        const projected = [];
        if (mode === "old") {
          for (let k = 0; k < inputs.length; k++) {
            switchTo("entities");
            const value = await bib.projectBibliography(
              timed,
              inputs[k].work,
              inputs[k].raw,
              false,
              prepared[k],
            );
            projected.push({ work: inputs[k].work, projected: value });
          }
        } else {
          switchTo("entities");
          const entities = await bib.projectEntityBatch(
            timed,
            inputs,
            prepared,
          );
          switchTo("filters");
          const filters = await bib.projectFilterBatch(
            timed,
            works.map((w) => w.id),
          );
          for (let k = 0; k < inputs.length; k++)
            projected.push({
              work: works[k],
              projected: {
                metadata: prepared[k].metadata,
                details: {
                  tags: prepared[k].tags,
                  entities: entities[k],
                  relations: prepared[k].source.relations ?? [],
                },
                filterTags: filters.get(works[k].id) ?? [],
              },
            });
        }
        switchTo("documents");
        if (mode === "new")
          await catalog.writeCurrentDocuments(timed, projected);
        else
          for (const { work: w, projected: p } of projected) {
            const availability = (
              await timed.query(
                "SELECT availability FROM ao3_jobs WHERE kind='work' AND target=$1",
                [w.external_id],
              )
            ).rows[0]?.availability;
            if (availability && availability !== "unknown")
              p.metadata.availability = availability;
            const details = { ...p.details, filterTags: p.filterTags };
            const generation = crypto
              .createHash("sha256")
              .update(
                JSON.stringify([w.current_snapshot_id, p.metadata, details]),
              )
              .digest("hex");
            await timed.query(
              "INSERT INTO catalog_documents(work_id,snapshot_id,metadata,title,bibliography,generation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(work_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,metadata=excluded.metadata,title=excluded.title,bibliography=excluded.bibliography,generation=excluded.generation,indexed_at=now()",
              [
                w.id,
                w.current_snapshot_id,
                p.metadata,
                catalog.strings(w.metadata.title).join(" · "),
                details,
                generation,
              ],
            );
          }
        switchTo("coordination");
        await timed.query("COMMIT");
        commits++;
      }
      switchTo("coordination");
      const seconds = (performance.now() - start) / 1000,
        usage = process.cpuUsage(cpu);
      const wal_bytes = Number(
        (
          await db.query(
            "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) n",
            [walBefore],
          )
        ).rows[0].n,
      );
      const queries = Object.values(phases).reduce((n, p) => n + p.queries, 0),
        counts = {};
      for (const table of tables)
        counts[table] = Number(
          (await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n,
        );
      results.push({
        mode,
        batch,
        phase,
        works: ids.length,
        seconds,
        queries,
        queries_per_work: queries / ids.length,
        commits,
        phases,
        wal_bytes,
        node_cpu_seconds: (usage.user + usage.system) / 1e6,
        rss_mib: process.memoryUsage().rss / 1048576,
        process_peak_rss_mib: process.resourceUsage().maxRSS / 1024,
        counts,
      });
      fs.writeFileSync(
        "/results/current-" + mode + ".json",
        JSON.stringify(results, null, 2),
      );
    }
    await db.query(`SET search_path=public; DROP SCHEMA ${schema} CASCADE`);
  }
  console.log(JSON.stringify(results));
  db.release();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
