// Actual full backup + restore to a fresh database/store, with separate search node.
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { execFileSync } = require("node:child_process");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT != "/benchmark/main"
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db"),
  { Pool } = require("pg");
const {
  createBackup,
  inspectBackup,
  restoreBackup,
} = require("../apps/api/dist/backup-engine");
(async () => {
  const t = Date.now(),
    targetPath = "/benchmark/backup-target";
  fs.mkdirSync(targetPath);
  fs.writeFileSync(targetPath + "/.palimora-backup-target", "p5-fixture");
  const mount = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((x) => x.split(" "))
    .filter((x) => targetPath.startsWith(x[4] + "/") || x[4] === "/")
    .sort((a, b) => b[4].length - a[4].length)[0];
  const target = {
    name: "p5",
    path: targetPath,
    marker: "p5-fixture",
    device: mount[2],
    reserveBytes: 8 * 1024 ** 3,
  };
  const config = {
    authKey: process.env.AUTH_KEY,
    origin: process.env.APP_ORIGIN,
    settings: {
      ARCHIVE_ZSTD_LEVEL: "3",
      INGEST_PRESSURE_MODE: "throughput-first",
    },
  };
  const { seal, unseal, hashPassword } = require("../apps/api/dist/security");
  await pool.query(
    "INSERT INTO users(id,username,password_hash,role,totp_secret) VALUES($1,'p5owner',$2,'Owner',$3) ON CONFLICT(lower(username)) DO NOTHING",
    [
      randomUUID(),
      await hashPassword("Isolated P5 restore password 862!"),
      seal("p5-fixture-secret"),
    ],
  );
  execFileSync(
    process.execPath,
    ["scripts/p5-verify.cjs", "/results/backup-source-verification.json"],
    { stdio: "inherit" },
  );
  await pool.query(
    "INSERT INTO catalog_pending(work_id) SELECT id FROM archive_work_heads LIMIT 10 ON CONFLICT DO NOTHING",
  );
  const backup = await createBackup({
    database: pool,
    storage: process.env.ARCHIVE_ROOT,
    target,
    config,
    id: randomUUID(),
    kind: "full",
    volumeBytes: 64 * 1024 ** 2,
  });
  const backupSeconds = (Date.now() - t) / 1000;
  const meta = await inspectBackup(target, backup.id);
  await pool.query("CREATE DATABASE palimora_p5_restore_test");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/palimora_p5_restore_test";
  const db = new Pool({ connectionString: url.toString() });
  try {
    const t2 = Date.now(),
      restored = "/benchmark/restored";
    const result = await restoreBackup({
      database: db,
      target,
      id: backup.id,
      storage: restored,
      confirmation: meta.confirmation,
    });
    assert.equal(result.unresolved.length, 0);
    assert.equal(
      unseal(
        (await db.query("SELECT totp_secret FROM users")).rows[0].totp_secret,
        Buffer.from(config.authKey, "hex"),
      ),
      "p5-fixture-secret",
    );
    const restoreSeconds = (Date.now() - t2) / 1000;
    const pending = (
      await db.query("SELECT count(*)::int n FROM catalog_pending")
    ).rows[0].n;
    assert.ok(pending >= 10);
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      ARCHIVE_ROOT: restored,
      OPENSEARCH_URL: "http://restore-search:9200",
      BENCH_LABEL: "restored",
    };
    execFileSync(
      process.execPath,
      process.env.STORAGE_OVERHAUL_ONLY === "1"
        ? ["scripts/storage-drain.cjs"]
        : ["scripts/benchmark-release.cjs", "project"],
      { env, stdio: "inherit", timeout: 600000 },
    );
    execFileSync(
      process.execPath,
      ["scripts/p5-verify.cjs", "/results/backup-restored-verification.json"],
      { env, stdio: "inherit", timeout: 600000 },
    );
    const source = JSON.parse(
        fs.readFileSync("/results/backup-source-verification.json"),
      ),
      copy = JSON.parse(
        fs.readFileSync("/results/backup-restored-verification.json"),
      );
    assert.deepEqual(copy, source);
    fs.writeFileSync(
      "/results/backup-restore.json",
      JSON.stringify(
        {
          kind: "full",
          backup_seconds: backupSeconds,
          restore_seconds: restoreSeconds,
          manifest_sha256: meta.hash,
          backup_payload_bytes: meta.bytes,
          restored_pending: pending,
          objects: copy.verified_objects,
          signatures_equal: true,
          secret_decrypted: true,
          derived_documents: copy.search_documents,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.end();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
