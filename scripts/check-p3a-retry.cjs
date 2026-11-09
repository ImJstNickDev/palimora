// Untimed replay: validate corpus idempotency and observe global ingest limits.
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { AsyncLocalStorage } = require("node:async_hooks");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Test only");
const db = require("../apps/api/dist/db"),
  archive = require("../apps/api/dist/archive");
const context = new AsyncLocalStorage();
let groups = 0,
  transactions = 0,
  maxGroups = 0,
  maxTransactions = 0,
  maxSources = 0;
const activeSources = new Map();
const transaction = db.transaction;
db.transaction = async (...args) => {
  if (!context.getStore()) return transaction(...args);
  transactions++;
  maxTransactions = Math.max(maxTransactions, transactions);
  try {
    return await transaction(...args);
  } finally {
    transactions--;
  }
};
for (const name of ["ingestRecords", "ingestRecord", "archiveTransaction"]) {
  const ingest = archive[name];
  archive[name] = async (source, ...args) => {
    if (context.getStore()) return ingest(source, ...args);
    groups++;
    maxGroups = Math.max(maxGroups, groups);
    const key = source?.id ?? "control";
    activeSources.set(key, (activeSources.get(key) || 0) + 1);
    maxSources = Math.max(maxSources, activeSources.size);
    try {
      return await context.run(true, () => ingest(source, ...args));
    } finally {
      groups--;
      const n = activeSources.get(key) - 1;
      if (n) activeSources.set(key, n);
      else activeSources.delete(key);
    }
  };
}
const counts = async () =>
  (
    await db.pool.query(
      "SELECT (SELECT count(*) FROM archive_work_heads) works,(SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_chapter_revisions) revisions,(SELECT count(*) FROM archive_object_data) objects",
    )
  ).rows[0];
(async () => {
  const before = await counts(),
    id = randomUUID();
  await db.pool.query(
    "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,true)",
    [id, ["part0.zip", "part1.zip", "part2.zip", "part3.zip"]],
  );
  await require("../apps/api/dist/ingest-worker").tick(id);
  assert.equal(
    (await db.pool.query("SELECT state FROM ingest_batches WHERE id=$1", [id]))
      .rows[0].state,
    "completed",
  );
  const after = await counts();
  assert.deepEqual(after, before);
  assert.ok(maxTransactions <= Number(process.env.INGEST_COMMIT_CONCURRENCY));
  assert.equal(groups, 0);
  fs.writeFileSync(
    "/results/p3a-retry.json",
    JSON.stringify({
      before,
      after,
      max_groups: maxGroups,
      max_transactions_including_pool_acquisition: maxTransactions,
      max_sources_in_commit: maxSources,
    }),
  );
  await db.pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
