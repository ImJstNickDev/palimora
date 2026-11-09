const assert = require("node:assert/strict"),
  fs = require("node:fs");
module.exports = async (db, search) => {
  const original = process.env.SEARCH_PARALLEL_FACETS;
  const pits = new Set(),
    cases = [];
  const run = async (flag, x) => {
    process.env.SEARCH_PARALLEL_FACETS = flag;
    const r = await search.searchWorks(db, x);
    if (r.next) pits.add(JSON.parse(Buffer.from(r.next, "base64url")).p);
    return r;
  };
  const normalized = (r) => ({
    ...r,
    next: r.next
      ? { ...JSON.parse(Buffer.from(r.next, "base64url")), p: "same-snapshot" }
      : null,
  });
  try {
    const seed = await run("0", {});
    const queries = [
      {},
      { fandom: seed.facets.fandom[0].name },
      { fulltext: "love" },
      { unclassified: seed.facets.unclassified[0].name },
      {
        fandom: seed.facets.fandom[0].name,
        fulltext: "love",
        language: "English",
      },
      ...[
        "relevance",
        "title",
        "creators",
        "published",
        "updated",
        "words",
        "hits",
        "kudos",
        "comments",
        "bookmarks",
        "archived",
        "series",
      ].flatMap((sort) => [
        { sort, direction: "asc" },
        { sort, direction: "desc" },
      ]),
    ];
    for (const q of queries) {
      const a = await run("0", q),
        b = await run("1", q);
      assert.deepEqual(normalized(b), normalized(a));
      if (a.next) {
        let cursor = a.next;
        for (let i = 0; i < 3 && cursor; i++) {
          const c = await run("0", { ...q, cursor }),
            d = await run("1", { ...q, cursor });
          assert.deepEqual(d, c);
          cursor = c.next;
        }
      }
      cases.push(q);
    }
    // Complete default traversal, both modes on the identical existing PIT cursor.
    let cursor = seed.next,
      count = seed.items.length;
    while (cursor) {
      const a = await run("0", { cursor }),
        b = await run("1", { cursor });
      assert.deepEqual(b, a);
      count += a.items.length;
      cursor = a.next;
    }
    assert.equal(count, 11032);
    // PostgreSQL authority changes while a previously opened PIT is still valid.
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      const id = seed.items[0].id;
      for (const mutation of [
        "UPDATE catalog_documents SET generation='diagnostic-stale' WHERE work_id=$1",
        "DELETE FROM catalog_documents WHERE work_id=$1",
      ]) {
        await connection.query(mutation, [id]);
        process.env.SEARCH_PARALLEL_FACETS = "0";
        const a = await search.searchWorks(connection, {});
        process.env.SEARCH_PARALLEL_FACETS = "1";
        const b = await search.searchWorks(connection, {});
        for (const r of [a, b])
          if (r.next) pits.add(JSON.parse(Buffer.from(r.next, "base64url")).p);
        assert.deepEqual(normalized(b), normalized(a));
        assert.ok(!a.items.some((x) => x.id === id));
      }
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const target = seed.items[0].id;
    const document = await search.searchRequest(
      "/" + search.SEARCH_INDEX + "/_doc/" + target,
      undefined,
      "GET",
    );
    const added = require("node:crypto").randomUUID();
    const compare = async () => {
      const a = await run("0", {}),
        b = await run("1", {});
      assert.deepEqual(normalized(b), normalized(a));
    };
    try {
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + target + "?refresh=true",
        { ...document._source, language: "p2e-test-language" },
        "PUT",
      );
      await compare();
      const a = await run("0", { cursor: seed.next }),
        b = await run("1", { cursor: seed.next });
      assert.deepEqual(a, b);
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + added + "?refresh=true",
        { ...document._source, id: added },
        "PUT",
      );
      await compare();
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + target + "?refresh=true",
        undefined,
        "DELETE",
      );
      await compare();
    } finally {
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + added + "?refresh=true",
        undefined,
        "DELETE",
      );
      await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_doc/" + target + "?refresh=true",
        document._source,
        "PUT",
      );
    }
    const expired = seed.next;
    await search.searchRequest(
      "/_search/point_in_time",
      { pit_id: [JSON.parse(Buffer.from(expired, "base64url")).p] },
      "DELETE",
    );
    await assert.rejects(
      run("1", { cursor: expired }),
      (e) => e.getResponse()?.code === "SEARCH_CURSOR_EXPIRED",
    );
    const fetch = global.fetch;
    for (const fault of [
      "error",
      "timeout",
      "shards",
      "missing",
      "transport",
    ]) {
      global.fetch = async (...args) => {
        if (fault === "transport" && String(args[0]).includes("/_msearch"))
          throw new Error("diagnostic timeout");
        const r = await fetch(...args);
        if (!String(args[0]).includes("/_msearch")) return r;
        const body = await r.json();
        if (fault === "error")
          body.responses[1] = { status: 503, error: { type: "test" } };
        if (fault === "timeout") body.responses[1].timed_out = true;
        if (fault === "shards") body.responses[1]._shards.failed = 1;
        if (fault === "missing") delete body.responses[1].aggregations;
        return new Response(JSON.stringify(body), { status: 200 });
      };
      try {
        await assert.rejects(
          run("1", {}),
          (e) => e.getResponse()?.code === "SEARCH_UNAVAILABLE",
        );
      } finally {
        global.fetch = fetch;
      }
    }
    fs.writeFileSync(
      "/results/parallel-equivalence.json",
      JSON.stringify({
        cases,
        complete_default_count: count,
        indexed_add_update_delete_and_fixed_snapshot: true,
        postgres_stale_and_deleted_authority: true,
        three_cursor_pages_each: true,
        expired_cursor: true,
        injected_partial_timeout_shard_missing: true,
      }),
    );
  } finally {
    process.env.SEARCH_PARALLEL_FACETS = original;
    await search
      .searchRequest("/_search/point_in_time", { pit_id: [...pits] }, "DELETE")
      .catch(() => {});
  }
};
