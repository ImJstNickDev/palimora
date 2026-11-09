// Export the bounded private corpus, then read TXT through the standalone CLI.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
if (
  new URL(process.env.DATABASE_URL).pathname !== "/palimora_release_test" ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
const { loadSnapshot, chapterBytes } = require("../apps/api/dist/catalog");
(async () => {
  const targetPath = "/benchmark/canonical-export-target";
  fs.mkdirSync(targetPath);
  fs.writeFileSync(
    targetPath + "/.palimora-backup-target",
    "canonical-fixture",
  );
  const mount = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((x) => x.split(" "))
    .filter((x) => targetPath.startsWith(x[4] + "/") || x[4] === "/")
    .sort((a, b) => b[4].length - a[4].length)[0];
  process.env.BACKUP_CONFIG_FILE = "/benchmark/canonical-export-config.json";
  fs.writeFileSync(
    process.env.BACKUP_CONFIG_FILE,
    JSON.stringify({
      destinations: [
        {
          name: "fixture",
          label: "Fixture",
          path: targetPath,
          marker: "canonical-fixture",
          device: mount[2],
          reserveBytes: 8 * 1024 ** 3,
        },
      ],
      restores: [],
    }),
  );
  const id = randomUUID(),
    start = performance.now();
  const { exportCorpus } = require("../apps/api/dist/archive-export");
  await exportCorpus({
    id,
    destination: "fixture",
    basePaths: [],
    stopped: () => false,
    progress: async () => {},
  });
  const output = targetPath + "/" + id + "/archive";
  const cli = "packages/archive-cli/cli.cjs";
  const env = {
    ...process.env,
    DATABASE_URL: "postgresql://unavailable/unused",
    ARCHIVE_ROOT: "/unavailable",
    AO3_DUMP_ROOT: "/unavailable",
  };
  const verified = JSON.parse(
    execFileSync(process.execPath, [cli, "verify", output], {
      env,
      encoding: "utf8",
    }),
  );
  const rows = (
    await pool.query(
      "SELECT DISTINCT s.work_id,s.id,s.manifest_hash FROM archive_snapshots s JOIN archive_records r ON r.snapshot_id=s.id WHERE r.source_path='txt.zip' ORDER BY s.id LIMIT 8",
    )
  ).rows;
  assert.equal(rows.length, 8);
  for (const row of rows) {
    const { manifest } = await loadSnapshot(pool, row.work_id, row.id);
    const portable = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "manifest", row.manifest_hash, output],
        { env, encoding: "utf8" },
      ),
    );
    assert.deepEqual(portable, manifest);
    const bytes = execFileSync(
      process.execPath,
      [
        cli,
        "chapter",
        row.manifest_hash,
        manifest.chapters[0].chapter_id,
        output,
      ],
      { env, maxBuffer: 32 * 1024 ** 2 },
    );
    assert.deepEqual(
      bytes,
      await chapterBytes(pool, manifest, manifest.chapters[0]),
    );
  }
  const m = (
    await pool.query(
      "SELECT manifest_hash FROM archive_snapshots WHERE state='metadata_only' LIMIT 1",
    )
  ).rows[0];
  const metadata = JSON.parse(
    execFileSync(process.execPath, [cli, "manifest", m.manifest_hash, output], {
      env,
      encoding: "utf8",
    }),
  );
  assert.equal(metadata.schema, "palimora-canonical-metadata-v1");
  assert.ok(metadata.metadata);
  fs.writeFileSync(
    "/results/canonical-export.json",
    JSON.stringify(
      {
        seconds: (performance.now() - start) / 1000,
        verified,
        txt_chapters: rows.length,
        metadata_only: true,
        standalone_without_database_or_dumps: true,
        content_equal: true,
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
