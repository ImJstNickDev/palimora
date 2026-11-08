// Diagnostic of the existing SQL capture function, before/after bounded writes.
const fs = require("node:fs/promises"),
  { join, dirname } = require("node:path");
const Module = require("node:module"),
  { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks"),
  assert = require("node:assert/strict");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Release fixture required");
const { pool } = require("../apps/api/dist/db"),
  { openBackupTarget } = require("../apps/api/dist/backup-target");
async function implementation(before) {
  const filename = require.resolve("../apps/api/dist/backup-engine");
  const source = await fs.readFile(
    before ? "/results/backup-engine-before-batch.cjs" : filename,
    "utf8",
  );
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(dirname(filename));
  loaded._compile(
    source + "\nexports.captureQueryForBenchmark = captureQuery;",
    filename,
  );
  return loaded.exports.captureQueryForBenchmark;
}
(async () => {
  const config = JSON.parse(
    await fs.readFile("/benchmark/recovery/destinations.json", "utf8"),
  );
  const target = await openBackupTarget(
    config.destinations.find((d) => d.name === "release"),
  );
  const root = join(target.path, "capture-probe-" + randomUUID()),
    db = await pool.connect(),
    result = { rows: 10000 };
  try {
    await fs.mkdir(root, { mode: 0o700 });
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const name of ["before", "after"]) {
      const capture = await implementation(name === "before");
      let checks = 0,
        largest = 0;
      const start = performance.now();
      await capture(
        db,
        "SELECT row_to_json(t)::text AS row FROM (SELECT * FROM archive_object_data ORDER BY hash LIMIT 10000) t",
        join(root, name),
        async (n = 0) => {
          checks++;
          largest = Math.max(largest, n);
          await target.check(Math.max(8388608, n));
        },
      );
      const seconds = (performance.now() - start) / 1000,
        bytes = await fs.readFile(join(root, name));
      result[name] = {
        seconds,
        checks,
        largest_write: largest,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    assert.equal(result.before.sha256, result.after.sha256);
    await fs.writeFile(
      "/results/backup-capture-comparison.json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await fs.rm(root, { recursive: true, force: true });
    await target.close();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
