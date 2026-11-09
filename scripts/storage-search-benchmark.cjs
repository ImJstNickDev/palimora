// Run only in an isolated clone, with OPENSEARCH_URL=http://localhost:9200.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const base = "http://localhost:9200",
  source = "palimora-works-v2";
async function req(p, b, method = b ? "POST" : "GET") {
  let r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: b && JSON.stringify(b),
  });
  let j = await r.json();
  if (!r.ok) throw Error(JSON.stringify(j));
  return j;
}
async function main() {
  const config = (await req("/" + source))[source],
    results =
      process.env.STORAGE_CANDIDATES && fs.existsSync("/output/search.json")
        ? JSON.parse(fs.readFileSync("/output/search.json"))
        : [];
  assert.equal(
    config.mappings._source,
    undefined,
    "Benchmark input must be an unfiltered baseline, never a filtered index",
  );
  const sourceCount = (await req("/" + source + "/_count")).count;
  for (const [name, codec, level, exclude] of [
    ["a", "default", null, false],
    ["b", "default", null, true],
    ["c-best", "best_compression", null, false],
    ["c-zstd1", "zstd", 1, false],
    ["c-zstd3", "zstd", 3, false],
    ["c-zstd6", "zstd", 6, false],
    ["d-zstd3", "zstd", 3, true],
    ["e-zstd3", "zstd", 3, true],
  ]) {
    if (
      process.env.STORAGE_CANDIDATES &&
      !process.env.STORAGE_CANDIDATES.split(",").includes(name)
    )
      continue;
    const index = "storage-bench-" + name,
      mappings = structuredClone(config.mappings);
    if (exclude) mappings._source = { excludes: ["text"] };
    if (name === "e-zstd3") {
      // These duplicate multifields are queryable but never sorted/aggregated.
      mappings.properties.title.fields.sort.doc_values = false;
      mappings.properties.creators.fields.sort.doc_values = false;
    }
    await fetch(base + "/" + index, { method: "DELETE" });
    await req(
      "/" + index,
      {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: config.settings.index.analysis,
          "index.codec": codec,
          ...(level ? { "index.codec.compression_level": level } : {}),
        },
        mappings,
      },
      "PUT",
    );
    let page = await req("/" + source + "/_search?scroll=5m", {
        size: 64,
        sort: ["_doc"],
        query: { match_all: {} },
      }),
      n = 0,
      peak = 0;
    const begin = performance.now();
    while (page.hits.hits.length) {
      const body = page.hits.hits
        .map(
          (h) =>
            JSON.stringify({ index: { _index: index, _id: h._id } }) +
            "\n" +
            JSON.stringify(h._source) +
            "\n",
        )
        .join("");
      const r = await fetch(base + "/_bulk", {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body,
      });
      const bulk = await r.json();
      assert.equal(bulk.errors, false);
      n += page.hits.hits.length;
      if (n % 512 === 0) {
        let s = await req("/" + index + "/_stats");
        peak = Math.max(
          peak,
          s._all.primaries.store.size_in_bytes +
            s._all.primaries.translog.size_in_bytes,
        );
      }
      page = await req("/_search/scroll", {
        scroll: "5m",
        scroll_id: page._scroll_id,
      });
    }
    await req("/_search/scroll", { scroll_id: [page._scroll_id] }, "DELETE");
    assert.equal(n, sourceCount);
    const seconds = (performance.now() - begin) / 1000,
      writing = (await req("/" + index + "/_stats"))._all.primaries;
    await req("/" + index + "/_refresh", {});
    await req("/" + index + "/_flush", {});
    const settled = (await req("/" + index + "/_stats"))._all.primaries;
    const queries = [
      { match_all: {} },
      { query_string: { query: "love", fields: ["text.*"] } },
      { query_string: { query: '"I love you"', fields: ["text.*"] } },
      { query_string: { query: "love AND NOT death", fields: ["text.*"] } },
    ];
    for (const query of queries) {
      const body = {
        query,
        size: 100,
        _source: false,
        sort: ["_score", { id: "asc" }],
        docvalue_fields: ["generation"],
        aggs: {
          language: { terms: { field: "language", size: 100 } },
          fandom: { terms: { field: "fandom", size: 100 } },
        },
      };
      const a = await req("/" + source + "/_search", body),
        b = await req("/" + index + "/_search", body);
      for (const r of [a, b]) for (const h of r.hits.hits) delete h._index;
      assert.deepEqual(b.hits, a.hits);
      assert.deepEqual(b.aggregations, a.aggregations);
    }
    results.push({
      name,
      codec,
      level,
      exclude,
      n,
      seconds,
      docs_per_second: n / seconds,
      peak_sampled_bytes: peak,
      writing,
      settled,
      queries_equal: queries.length,
    });
    fs.writeFileSync("/output/search.json", JSON.stringify(results, null, 2));
    console.log(name, n, seconds, settled.store.size_in_bytes);
  }
  const mappings = structuredClone(config.mappings);
  try {
    await req(
      "/storage-bench-derived",
      {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: config.settings.index.analysis,
          "index.derived_source.enabled": true,
        },
        mappings,
      },
      "PUT",
    );
    fs.writeFileSync(
      "/output/derived.json",
      JSON.stringify({ created: true, validated: false }),
    );
  } catch (e) {
    fs.writeFileSync(
      "/output/derived.json",
      JSON.stringify({ created: false, error: String(e) }),
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
