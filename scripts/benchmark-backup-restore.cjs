// Measure the actual bounded restore loader against its former per-row SQL.
const fs = require("node:fs/promises"),
  { dirname } = require("node:path"),
  Module = require("node:module");
const { randomUUID } = require("node:crypto"),
  { performance } = require("node:perf_hooks"),
  assert = require("node:assert/strict");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Release fixture required");
const { pool } = require("../apps/api/dist/db"),
  { openBackupTarget } = require("../apps/api/dist/backup-target");
(async () => {
  const config = JSON.parse(
    await fs.readFile("/benchmark/recovery/destinations.json", "utf8"),
  );
  const target = await openBackupTarget(
    config.destinations.find((d) => d.name === "release"),
    { readOnly: true },
  );
  const db = await pool.connect(),
    path = "/benchmark/restore-probe-" + randomUUID() + ".ndjson",
    result = { rows: 10000 };
  try {
    const filename = require.resolve("../apps/api/dist/backup-engine"),
      loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(dirname(filename));
    loaded._compile(
      (await fs.readFile(filename, "utf8")) +
        "\nexports.restoreRowsForBenchmark=restoreRows;",
      filename,
    );
    await db.query("BEGIN");
    const rows = (
      await db.query(
        "SELECT row_to_json(t)::text AS row FROM (SELECT * FROM archive_object_data ORDER BY hash LIMIT 10000) t",
      )
    ).rows;
    await fs.writeFile(path, rows.map((r) => r.row).join("\n") + "\n", {
      mode: 0o600,
    });
    await db.query(
      "CREATE TEMP TABLE restore_archive_object_data (LIKE archive_object_data INCLUDING DEFAULTS) ON COMMIT DROP",
    );
    for (const name of ["before", "after"]) {
      await db.query("TRUNCATE restore_archive_object_data");
      let checks = 0;
      const check = async () => {
          checks++;
          await target.check();
        },
        start = performance.now();
      if (name === "before")
        for (const r of rows) {
          await check();
          await db.query(
            "INSERT INTO restore_archive_object_data OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(NULL::archive_object_data,($1::jsonb)::json)",
            [r.row],
          );
        }
      else
        await loaded.exports.restoreRowsForBenchmark(
          db,
          "archive_object_data",
          path,
          check,
        );
      const seconds = (performance.now() - start) / 1000;
      const fingerprint = (
        await db.query(
          "SELECT count(*)::int rows,md5(string_agg(to_jsonb(t)::text,'' ORDER BY hash)) signature FROM restore_archive_object_data t",
        )
      ).rows[0];
      result[name] = { seconds, checks, ...fingerprint };
    }
    assert.equal(result.before.rows, 10000);
    assert.equal(result.after.rows, 10000);
    assert.equal(result.before.signature, result.after.signature);
    await fs.writeFile(
      "/results/backup-restore-comparison.json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await fs.rm(path, { force: true });
    await target.close();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
