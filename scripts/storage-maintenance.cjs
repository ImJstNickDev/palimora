// Ordinary post-campaign maintenance on the isolated fixture, no force merge.
const fs = require("node:fs"),
  path = require("node:path");
const { pool } = require("../apps/api/dist/db");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT != "/benchmark/main"
)
  throw Error("Private fixture required");
function bytes(root) {
  let n = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    try {
      n += e.isDirectory() ? bytes(p) : fs.statSync(p).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return n;
}
(async () => {
  const start = Date.now();
  const before = (
    await pool.query(
      "SELECT pg_database_size(current_database())::float database_bytes,wal_bytes::float FROM pg_stat_wal",
    )
  ).rows[0];
  await pool.query("VACUUM (ANALYZE)");
  await searchRequest("/" + SEARCH_INDEX + "/_refresh", {});
  await searchRequest("/" + SEARCH_INDEX + "/_flush", {});
  let previous,
    stable = 0,
    index;
  for (let i = 0; i < 30; i++) {
    index = (
      await searchRequest("/" + SEARCH_INDEX + "/_stats", undefined, "GET")
    )._all.primaries;
    stable =
      index.store.size_in_bytes === previous && index.merges.current === 0
        ? stable + 1
        : 0;
    if (stable >= 2) break;
    previous = index.store.size_in_bytes;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = (
    await pool.query(
      "SELECT pg_database_size(current_database())::float database_bytes,wal_bytes::float FROM pg_stat_wal",
    )
  ).rows[0];
  fs.writeFileSync(
    "/results/storage-maintenance.json",
    JSON.stringify(
      {
        seconds: (Date.now() - start) / 1000,
        before,
        after,
        index,
        physical: {
          pack: bytes("/benchmark/main/packs"),
          staging: bytes("/benchmark/main/staging"),
          postgres: null,
          search: null,
          archive: bytes("/benchmark/main"),
        },
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
