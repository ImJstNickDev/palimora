// Real-corpus recovery rehearsal. Never accepts an existing production target.
const fs = require("node:fs/promises"),
  { join } = require("node:path"),
  { randomUUID, createHash } = require("node:crypto"),
  assert = require("node:assert/strict");
const { Pool } = require("pg");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/")
)
  throw Error("Isolated release fixture required");
const { pool, transaction } = require("../apps/api/dist/db");
const {
  createBackup,
  restoreBackup,
  inspectBackup,
} = require("../apps/api/dist/backup-engine");
const { exportCorpus } = require("../apps/api/dist/archive-export");
const { openChain, verify, MAX_VOLUME } = require("@palimora/archive-format");
const { performance } = require("node:perf_hooks");
const result = {};
const peers = [];
async function timed(name, fn) {
  console.log("recovery", name);
  const t = performance.now();
  const r = await fn();
  const key = name + "_seconds";
  const elapsed = (performance.now() - t) / 1000;
  if (result[key] === undefined) result[key] = elapsed;
  else (result.retries ??= []).push({ phase: name, seconds: elapsed });
  await fs.writeFile(
    "/results/recovery-progress.json",
    JSON.stringify(result, null, 2),
  );
  return r;
}
async function fingerprint(db, table) {
  return (
    await db.query(
      `SELECT count(*)::text rows,md5(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text)) signature FROM ${table} t`,
    )
  ).rows[0];
}
(async () => {
  try {
    Object.assign(
      result,
      JSON.parse(await fs.readFile("/results/recovery-progress.json", "utf8")),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const root = "/benchmark/recovery";
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  let ids;
  try {
    ids = JSON.parse(await fs.readFile("/results/recovery-plan.json", "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    ids = Object.fromEntries(
      [
        "base",
        "incremental",
        "full",
        "platform",
        "batch",
        "source",
        "annotation",
      ].map((k) => [k, randomUUID()]),
    );
    await fs.writeFile("/results/recovery-plan.json", JSON.stringify(ids));
  }
  await fs.writeFile(join(root, ".palimora-backup-target"), "release-recovery");
  const mounts = (await fs.readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .map((s) => s.split(" "));
  const mount = mounts
    .filter(
      (p) =>
        p[4] && (root === p[4] || root.startsWith(p[4] + "/") || p[4] === "/"),
    )
    .sort((a, b) => b[4].length - a[4].length)[0];
  const target = {
    name: "release",
    label: "Release rehearsal",
    path: root,
    marker: "release-recovery",
    device: mount[2],
    reserveBytes: 268435456,
  };
  process.env.BACKUP_CONFIG_FILE = join(root, "destinations.json");
  process.env.BACKUP_VOLUME_BYTES = "67108864";
  await fs.writeFile(
    process.env.BACKUP_CONFIG_FILE,
    JSON.stringify({ destinations: [target], restores: [] }),
  );
  result.exports_reused = {};
  for (const kind of ["base", "incremental"])
    result.exports_reused[kind] = await fs
      .access(join(root, ids[kind], "archive", "manifest.json"))
      .then(
        () => true,
        () => false,
      );
  const base = await timed("export_full", () =>
    exportCorpus({
      id: ids.base,
      destination: "release",
      basePaths: [],
      stopped: () => false,
      progress: async () => {},
    }),
  );
  result.export_base = { ...base, id: ids.base };
  const { loadSnapshot } = require("../apps/api/dist/catalog"),
    { readObject, ingestRecord } = require("../apps/api/dist/archive");
  const w = (
    await pool.query(
      "SELECT id,external_id,current_snapshot_id FROM archive_work_heads WHERE current_snapshot_id IS NOT NULL ORDER BY id LIMIT 1",
    )
  ).rows[0];
  const { manifest: m } = await transaction((db) => loadSnapshot(db, w.id));
  const batch = ids.batch,
    source = {
      id: ids.source,
      path: "release-controlled-revision",
      fingerprint: "release-only",
    };
  await pool.query(
    "INSERT INTO ingest_batches(id,state) VALUES($1,'completed') ON CONFLICT DO NOTHING",
    [batch],
  );
  await pool.query(
    "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'ingested') ON CONFLICT DO NOTHING",
    [source.id, batch, source.path, source.fingerprint],
  );
  const objects = await transaction(async (db) => {
    const out = [];
    for (const o of m.objects) {
      let bytes = await readObject(db, o.hash);
      if (o.name === m.chapters[0].name)
        bytes = Buffer.concat([
          bytes,
          Buffer.from("\n<p>Controlled release recovery revision.</p>"),
        ]);
      out.push({ name: o.name, kind: o.kind, data: bytes.toString("base64") });
    }
    return out;
  });
  await ingestRecord(source, {
    locator: "controlled",
    parser: "release-recovery-v1",
    cursor: 1,
    record: {
      external_id: w.external_id,
      source_entry: "controlled",
      metadata: m.metadata,
      chapters: m.chapters.map(({ chapter_id, revision_id, hash, ...c }) => c),
      objects,
      state: "valid",
      observed_at: null,
    },
  });
  const user = (
    await pool.query("SELECT id FROM users WHERE role='Owner' LIMIT 1")
  ).rows[0];
  assert.ok(user, "Create the release Owner through the UI first");
  await pool.query(
    "INSERT INTO library_bookmarks(user_id,work_id,notes) VALUES($1,$2,'Private release rehearsal note') ON CONFLICT(user_id,work_id) DO UPDATE SET notes=excluded.notes",
    [user.id, w.id],
  );
  const chapter = m.chapters[0].chapter_id;
  const anchor = {
    snapshot: w.current_snapshot_id,
    chapter,
    offset: 0,
    quote: "release",
    prefix: "",
    suffix: "",
  };
  await pool.query(
    "INSERT INTO library_progress(user_id,work_id,state,anchor,percent) VALUES($1,$2,'reading',$3,25) ON CONFLICT(user_id,work_id) DO NOTHING",
    [user.id, w.id, anchor],
  );
  await pool.query(
    "INSERT INTO library_annotations(id,user_id,work_id,anchor,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [ids.annotation, user.id, w.id, anchor, "Private annotation for recovery"],
  );
  const paths = [join(root, ids.base, "archive")];
  const incremental = await timed("export_incremental", () =>
    exportCorpus({
      id: ids.incremental,
      destination: "release",
      basePaths: paths,
      stopped: () => false,
      progress: async () => {},
    }),
  );
  paths.push(join(root, ids.incremental, "archive"));
  result.export_incremental = { ...incremental, id: ids.incremental };
  const chain = await openChain(paths);
  result.export_verification = await timed("export_verify", () =>
    verify(chain),
  );
  result.export_volumes = chain.archives.flatMap((a) =>
    a.manifest.volumes.map((v) => v.size),
  );
  assert.ok(result.export_volumes.every((n) => n <= MAX_VOLUME));
  assert.ok(result.export_volumes.length > 1);
  await assert.rejects(openChain([paths[1]]));
  const common = {
    database: pool,
    storage: process.env.ARCHIVE_ROOT,
    target,
    config: {
      authKey: process.env.AUTH_KEY,
      origin: process.env.APP_ORIGIN,
      settings: { ARCHIVE_ZSTD_LEVEL: "3" },
    },
    volumeBytes: 67108864,
  };
  const full = await timed("backup_full", () =>
    createBackup({ ...common, id: ids.full, kind: "full" }),
  );
  const platform = await timed("backup_platform", () =>
    createBackup({ ...common, id: ids.platform, kind: "platform" }),
  );
  const info = await inspectBackup(target, full.id);
  const name = "palimora_release_restored_test";
  await pool.query("CREATE DATABASE " + name).catch((e) => {
    if (e.code !== "42P04") throw e;
  });
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + name;
  const restored = new Pool({ connectionString: url.toString() });
  peers.push(restored);
  const storage = "/benchmark/restored";
  const report = await timed("restore_full", () =>
    restoreBackup({
      database: restored,
      target,
      id: full.id,
      storage,
      confirmation: info.confirmation,
    }),
  );
  assert.equal(report.unresolved.length, 0);
  result.tables = {};
  for (const table of [
    "archive_work_heads",
    "archive_snapshot_data",
    "archive_revision_data",
    "archive_snapshot_chapters",
    "archive_object_data",
    "users",
    "library_bookmarks",
    "library_progress",
    "library_annotations",
  ]) {
    const before = await fingerprint(pool, table),
      after = await fingerprint(restored, table);
    assert.deepEqual(after, before, table);
    result.tables[table] = before;
  }
  const { PackStore } = require("../apps/api/dist/pack");
  const store = new PackStore(storage);
  let after = Buffer.alloc(0),
    n = 0;
  await timed("restored_objects_verify", async () => {
    while (true) {
      const rows = (
        await restored.query(
          `SELECT o.hash,k.name kind,p.name pack,o.byte_offset,o.length,o.size FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id WHERE o.hash>$1 ORDER BY o.hash LIMIT 256`,
          [after],
        )
      ).rows;
      if (!rows.length) break;
      await store.readMany(
        rows.map((r) => ({
          ...r,
          hash: r.hash.toString("hex"),
          offset: Number(r.byte_offset),
          length: Number(r.length),
          size: Number(r.size),
        })),
      );
      after = rows.at(-1).hash;
      n += rows.length;
    }
  });
  result.restored_objects = n;
  await assert.rejects(
    restoreBackup({
      database: restored,
      target,
      id: full.id,
      storage,
      confirmation: "wrong",
    }),
  );
  // Clear only personal tables in the already verified disposable target.
  // Corpus and historical versions stay intact for the platform-only restore.
  if (
    !(
      await restored.query(
        "SELECT 1 FROM backup_restores WHERE manifest_hash=$1",
        [platform.hash],
      )
    ).rowCount
  )
    await restored.query("TRUNCATE users CASCADE");
  const personal = await timed("restore_platform", () =>
    restoreBackup({
      database: restored,
      target,
      id: platform.id,
      storage,
      confirmation: "RESTORE " + platform.hash,
    }),
  );
  assert.equal(personal.unresolved.length, 0);
  for (const table of [
    "archive_work_heads",
    "archive_snapshot_data",
    "archive_revision_data",
    "users",
    "library_bookmarks",
    "library_progress",
    "library_annotations",
  ])
    assert.deepEqual(
      await fingerprint(restored, table),
      await fingerprint(pool, table),
      table + " platform",
    );
  result.platform_unresolved = personal.unresolved.length;
  await fs.writeFile(
    "/results/recovery.json",
    JSON.stringify(
      {
        ...result,
        full_backup: full.id,
        platform_backup: platform.id,
        target,
        paths,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      verified_objects: n,
      works: result.tables.archive_work_heads.rows,
      versions: result.tables.archive_snapshot_data.rows,
    }),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(peers.map((p) => p.end()));
    await pool.end();
  });
