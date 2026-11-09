// Use the application's persistent scheduler, including HTTP 429 backoff.
// A zero-sized claim is not evidence that a delayed/leased queue is empty.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
const { projectCatalog, projectText } = require("../apps/api/dist/catalog");
const { startProjections } = require("../apps/api/dist/operations-index");
const {
  ensureSearchIndex,
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
(async () => {
  const start = performance.now();
  await ensureSearchIndex();
  const stop = startProjections(projectCatalog, projectText);
  let pending,
    stable = 0;
  try {
    do {
      assert.ok(
        performance.now() - start < 600000,
        "Persistent rebuild timed out",
      );
      pending = (
        await pool.query(
          `SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending)+(SELECT count(*) FROM catalog_text_pending)+(SELECT count(*) FROM catalog_graph_pending) AS n`,
        )
      ).rows[0].n;
      stable = Number(pending) === 0 ? stable + 1 : 0;
      if (stable < 2) await new Promise((r) => setTimeout(r, 1000));
    } while (stable < 2);
  } finally {
    await stop();
  }
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
  const indexed = (
    await searchRequest("/" + SEARCH_INDEX + "/_count", undefined, "GET")
  ).count;
  assert.equal(
    indexed,
    (await pool.query("SELECT count(*)::int n FROM catalog_documents")).rows[0]
      .n,
  );
  fs.writeFileSync(
    "/results/" + (process.env.BENCH_LABEL || "storage-drain") + ".json",
    JSON.stringify(
      {
        scheduler: "application persistent queues",
        seconds: (performance.now() - start) / 1000,
        indexed,
        pending: Number(pending),
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
