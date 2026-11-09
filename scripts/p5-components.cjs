// Measurement on owned test databases only. Search mode creates/deletes temporary test indexes.
if (process.argv[2] === "search") {
  const fs = require("fs"),
    assert = require("assert/strict");
  const { pool } = require("../apps/api/dist/db");
  const {
    searchRequest: request,
    SEARCH_INDEX,
  } = require("../apps/api/dist/catalog-search");
  async function searchRequest(...args) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(...args);
      } catch (e) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  (async () => {
    assert.equal(
      new URL(process.env.DATABASE_URL).pathname,
      "/palimora_p5_restore_test",
    );
    assert.equal(
      new URL(process.env.OPENSEARCH_URL).hostname,
      "restore-search",
    );
    const config = (await searchRequest("/" + SEARCH_INDEX, undefined, "GET"))[
      SEARCH_INDEX
    ];
    const groups = (
      await pool.query(
        "SELECT source_path,array_agg(DISTINCT work_id) ids FROM archive_records GROUP BY source_path ORDER BY source_path",
      )
    ).rows;
    const out = fs.existsSync("/results/category-search.json")
      ? JSON.parse(fs.readFileSync("/results/category-search.json"))
      : [];
    for (const g of groups) {
      if (out.some((r) => r.source === g.source_path)) continue;
      const index = "p5-category-" + out.length;
      await searchRequest(
        "/" + index,
        {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: config.settings.index.analysis,
          },
          mappings: config.mappings,
        },
        "PUT",
      );
      let body = "",
        sourceBytes = 0;
      for (let start = 0; start < g.ids.length; start += 1) {
        const docs = (
          await searchRequest("/" + SEARCH_INDEX + "/_mget", {
            ids: g.ids.slice(start, start + 1),
          })
        ).docs;
        for (const d of docs) {
          assert.ok(d.found);
          const s = JSON.stringify(d._source);
          sourceBytes += Buffer.byteLength(s);
          body +=
            JSON.stringify({ index: { _index: index, _id: d._id } }) +
            "\n" +
            s +
            "\n";
        }
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(process.env.OPENSEARCH_URL + "/_bulk", {
            method: "POST",
            headers: { "content-type": "application/x-ndjson" },
            body,
          });
          if (r.status === 429 && attempt < 5) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          assert.equal(r.ok, true, "Bulk HTTP " + r.status);
          assert.equal((await r.json()).errors, false);
          break;
        }
        body = "";
        await new Promise((r) => setTimeout(r, 40));
      }
      await searchRequest("/" + index + "/_refresh", {});
      await searchRequest("/" + index + "/_flush", {});
      await new Promise((r) => setTimeout(r, 1200));
      const stats = (
        await searchRequest("/" + index + "/_stats", undefined, "GET")
      )._all.primaries;
      assert.equal(stats.docs.count, g.ids.length);
      out.push({
        source: g.source_path,
        documents: g.ids.length,
        document_json_bytes: sourceBytes,
        store_bytes: stats.store.size_in_bytes,
        translog_bytes: stats.translog.size_in_bytes,
      });
      await searchRequest("/" + index, undefined, "DELETE");
      fs.writeFileSync(
        "/results/category-search.json",
        JSON.stringify(out, null, 2),
      );
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
} else {
  const fs = require("node:fs");
  if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
    throw Error("Test database only");
  const { pool } = require("../apps/api/dist/db");
  (async () => {
    const tables = (
      await pool.query(
        "SELECT s.relname,pg_relation_size(s.relid)::float heap_bytes,pg_indexes_size(s.relid)::float index_bytes,CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid)::float END toast_bytes,pg_total_relation_size(s.relid)::float total_bytes,s.n_live_tup,s.n_dead_tup,s.autovacuum_count FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid ORDER BY s.relname",
      )
    ).rows;
    const objects = (
      await pool.query(
        "SELECT k.name,count(*)::int objects,sum(o.size)::float raw_bytes,sum(o.length)::float stored_bytes FROM archive_object_data o JOIN archive_kinds k ON k.id=o.kind_id GROUP BY k.name ORDER BY k.name",
      )
    ).rows;
    fs.writeFileSync(
      process.argv[2],
      JSON.stringify({ tables, objects }, null, 2),
    );
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
