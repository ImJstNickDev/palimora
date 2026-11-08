import { findObjects, objectProjection, objectFrom } from "./archive-catalog";
import { Pool, PoolClient } from "pg";
import { constants } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  realpath,
  lstat,
} from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { openBackupTarget, BackupTarget } from "./backup-target";
import { unseal } from "./security";
import { applyMigrations } from "./db";
import { PackStore, canonical } from "./pack";
import {
  writeArchive,
  openChain,
  verify,
  fileDigest,
  digest,
  readObject as portableObject,
} from "@palimora/archive-format";

const q = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const CHUNK = 8 * 1024 * 1024;
const platformTables = new Set([
  "instance",
  "users",
  "sessions",
  "invites",
  "recovery_codes",
  "passkeys",
  "challenges",
  "rate_limits",
  "audit",
  "library_bookmarks",
  "library_readings",
  "library_collections",
  "library_members",
  "library_collection_works",
  "library_progress",
  "library_progress_versions",
  "library_annotations",
  "library_annotation_versions",
  "library_mutation_receipts",
  "personal_settings",
  "reading_heartbeat",
  "reading_intervals",
  "personal_subscriptions",
  "personal_recommendations",
  "personal_notifications",
  "personal_notification_versions",
  "personal_runtime",
  "push_devices",
  "push_deliveries",
  "ao3_control",
  "backup_destinations",
  "backup_schedules",
  "backup_runs",
  "operations_layout",
  "integrity_schedule",
]);
interface FileEntry {
  name: string;
  size: number;
  sha256: string;
  chunks: string[];
}
interface Plan {
  schema: "palimora-backup-catalog-v1";
  kind: "full" | "platform";
  id: string;
  origin: string;
  captured_at: string;
  postgres_version?: string;
  engine_version?: string;
  migrations: { name: string; hash: string }[];
  tables: string[];
  sequences: { name: string; value: string; called: boolean }[];
  files: FileEntry[];
  config: { authKey: string; origin: string; settings: Record<string, string> };
}
export interface BackupOptions {
  database: Pool;
  storage: string;
  target: BackupTarget;
  id: string;
  kind: "full" | "platform";
  config: Plan["config"];
  stopped?: () => boolean;
  volumeBytes?: number;
  progress?: (value: object) => Promise<void>;
}
function validId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("BACKUP_ID");
}
async function syncDir(path: string) {
  const f = await open(path, "r");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function writeAll(f: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const r = await f.write(bytes, offset, bytes.length - offset);
    if (!r.bytesWritten) throw Error("SHORT_WRITE");
    offset += r.bytesWritten;
  }
}
async function jsonFile(path: string, value: unknown) {
  const temp = path + ".partial";
  const f = await open(temp, "w", 0o600);
  try {
    await writeAll(f, Buffer.from(JSON.stringify(value)));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
  await syncDir(resolve(path, ".."));
}
async function tables(db: PoolClient) {
  return (
    await db.query(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    )
  ).rows.map((r) => r.name as string);
}
async function* lines(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const line of createInterface({
      input: f.createReadStream({ autoClose: false }),
      crlfDelay: Infinity,
    }))
      if (line) yield line;
  } finally {
    await f.close();
  }
}
async function captureQuery(
  db: PoolClient,
  sql: string,
  path: string,
  check: (n?: number) => Promise<void>,
) {
  const f = await open(path, "wx", 0o600);
  try {
    await db.query(`DECLARE backup_rows NO SCROLL CURSOR FOR ${sql}`);
    try {
      while (true) {
        const rows = (await db.query("FETCH 128 FROM backup_rows")).rows;
        if (!rows.length) break;
        let pending: Buffer[] = [],
          size = 0;
        const flush = async () => {
          if (!size) return;
          await check(size);
          await writeAll(f, Buffer.concat(pending, size));
          pending = [];
          size = 0;
        };
        for (const r of rows) {
          const bytes = Buffer.from(r.row + "\n");
          if (size && size + bytes.length > 1024 * 1024) await flush();
          pending.push(bytes);
          size += bytes.length;
          if (size >= 1024 * 1024) await flush();
        }
        await flush();
      }
    } finally {
      await db.query("CLOSE backup_rows");
    }
    await f.sync();
  } finally {
    await f.close();
  }
}
// Keep raw JSON until PostgreSQL decodes it: parsing in JavaScript would lose
// precision for bigint audit IDs. Full restores need no per-row reconciliation.
async function restoreRows(
  db: PoolClient,
  table: string,
  path: string,
  check: () => Promise<void>,
) {
  let pending: string[] = [],
    size = 2;
  const flush = async () => {
    if (!pending.length) return;
    await check();
    await db.query(
      `INSERT INTO ${q("restore_" + table)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${q(table)},$1::json)`,
      ["[" + pending.join(",") + "]"],
    );
    pending = [];
    size = 2;
  };
  for await (const line of lines(path)) {
    const bytes = Buffer.byteLength(line) + 1;
    if (pending.length && size + bytes > 1024 * 1024) await flush();
    pending.push(line);
    size += bytes;
    if (pending.length >= 128 || size >= 1024 * 1024) await flush();
  }
  await flush();
}
async function copyChecked(
  source: string,
  target: string,
  check: (n?: number) => Promise<void>,
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = await open(target + ".partial", "w", 0o600);
  try {
    if (!(await input.stat()).isFile()) throw Error("BACKUP_NOT_FILE");
    for await (const bytes of input.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024,
    })) {
      await check(bytes.length);
      await writeAll(output, bytes);
    }
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
  await rename(target + ".partial", target);
  await syncDir(resolve(target, ".."));
}
async function fileEntry(root: string, name: string): Promise<FileEntry> {
  const actual = await fileDigest(root, name);
  const f = await open(join(root, name), "r");
  const chunks: string[] = [];
  try {
    for (let offset = 0; offset < actual.size; offset += CHUNK) {
      const bytes = Buffer.alloc(Math.min(CHUNK, actual.size - offset));
      let n = 0;
      while (n < bytes.length) {
        const r = await f.read(bytes, n, bytes.length - n, offset + n);
        if (!r.bytesRead) throw Error("BACKUP_TRUNCATED");
        n += r.bytesRead;
      }
      chunks.push(digest(bytes));
    }
  } finally {
    await f.close();
  }
  return { name, ...actual, chunks };
}
/** Logical MVCC capture. Shared archive lock is acquired BEFORE the transaction
 * snapshot, and held until all referenced sealed packs are durably copied. */
export async function createBackup(o: BackupOptions) {
  validId(o.id);
  if (typeof o.storage !== "string" || !o.storage)
    throw Error("BACKUP_STORAGE_REQUIRED");
  if (!/^[a-f0-9]{64}$/i.test(o.config.authKey))
    throw Error("BACKUP_AUTH_KEY_REQUIRED");
  if (!["full", "platform"].includes(o.kind)) throw Error("BACKUP_KIND");
  const originURL = new URL(o.config.origin);
  if (
    !["https:", "http:"].includes(originURL.protocol) ||
    originURL.username ||
    originURL.password
  )
    throw Error("BACKUP_ORIGIN");
  const target = await openBackupTarget(o.target),
    db = await o.database.connect().catch(async (error) => {
      await target.close();
      throw error;
    });
  const root = join(target.path, o.id),
    capture = join(root, "capture"),
    output = join(root, "archive");
  const check = async (n = 0) => {
    if (o.stopped?.()) throw Error("BACKUP_INTERRUPTED");
    await target.check(n);
  };
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended($1,70210460))", [
      o.id,
    ]);
    await check();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await syncDir(target.path);
    if (!(await lstat(root)).isDirectory()) throw Error("BACKUP_DIRECTORY");
    const origin =
      (await db.query("SELECT current_database() AS name")).rows[0].name +
      ":" +
      (await realpath(o.storage));
    let plan: Plan | undefined;
    try {
      plan = JSON.parse(await readFile(join(root, "capture.json"), "utf8"));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      plan &&
      (plan.id !== o.id || plan.origin !== origin || plan.kind !== o.kind)
    )
      throw Error("BACKUP_REQUEST_CONFLICT");
    if (!plan) {
      // A crashed MVCC snapshot cannot be resumed: discard only this operation's
      // unpublished capture and start a new consistent snapshot.
      await rm(capture, { recursive: true, force: true });
      await mkdir(capture, { mode: 0o700 });
      await db.query(
        "SELECT pg_advisory_lock_shared(70210401),pg_advisory_lock_shared(70210402)",
      );
      locked = true;
      await db.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout=0",
      );
      await db.query(
        "DECLARE backup_secrets NO SCROLL CURSOR FOR SELECT totp_secret AS secret FROM users WHERE totp_secret IS NOT NULL UNION ALL SELECT private_key FROM personal_runtime WHERE private_key IS NOT NULL UNION ALL SELECT subscription FROM push_devices UNION ALL SELECT credentials FROM ao3_control WHERE credentials IS NOT NULL UNION ALL SELECT cookies FROM ao3_control WHERE cookies IS NOT NULL",
      );
      try {
        while (true) {
          const secrets = (await db.query("FETCH 128 FROM backup_secrets"))
            .rows;
          if (!secrets.length) break;
          for (const row of secrets) {
            try {
              unseal(row.secret, Buffer.from(o.config.authKey, "hex"));
            } catch {
              throw Error("BACKUP_AUTH_KEY_MISMATCH");
            }
          }
        }
      } finally {
        await db.query("CLOSE backup_secrets");
      }
      const all = await tables(db),
        selected =
          o.kind === "full" ? all : all.filter((t) => platformTables.has(t));
      plan = {
        schema: "palimora-backup-catalog-v1",
        id: o.id,
        kind: o.kind,
        origin,
        captured_at: new Date().toISOString(),
        postgres_version: (await db.query("SHOW server_version")).rows[0]
          .server_version,
        engine_version: "palimora-backup-engine-v1",
        config: o.config,
        migrations: (
          await db.query(
            "SELECT name,hash FROM schema_migrations ORDER BY name",
          )
        ).rows,
        tables: selected,
        sequences: [],
        files: [],
      };
      for (const table of selected) {
        await o.progress?.({ phase: "catalog", table });
        await captureQuery(
          db,
          `SELECT row_to_json(t)::text AS row FROM ${q(table)} t`,
          join(capture, table + ".ndjson"),
          check,
        );
      }
      if (o.kind === "full")
        await captureQuery(
          db,
          `SELECT row_to_json(t)::text AS row FROM (
        SELECT e.id AS event_id,s.user_id,s.kind,s.target,s.created_at AS subscription_created_at
        FROM archive_outbox e CROSS JOIN personal_subscriptions s
        WHERE e.event='work.snapshot.published' AND NOT EXISTS(SELECT 1 FROM personal_event_receipts r WHERE r.event_id=e.id)
        AND ((e.producer_xid IS NOT NULL AND NOT pg_visible_in_snapshot(e.producer_xid,s.start_snapshot))
          OR (e.producer_xid IS NULL AND EXISTS(SELECT 1 FROM backup_notification_eligibility b WHERE b.event_id=e.id AND b.user_id=s.user_id AND b.kind=s.kind AND b.target=s.target AND b.subscription_created_at=s.created_at)))
      ) t`,
          join(capture, "notification-boundaries.ndjson"),
          check,
        );
      if (o.kind === "platform") {
        for (const [name, sql] of Object.entries({
          works: "SELECT id,external_id FROM archive_work_heads",
          snapshots: "SELECT id,work_id,manifest_hash FROM archive_snapshots",
          chapters: "SELECT id,work_id,source_key FROM archive_chapters",
        }))
          await captureQuery(
            db,
            `SELECT row_to_json(t)::text AS row FROM (${sql}) t`,
            join(capture, "refs-" + name + ".ndjson"),
            check,
          );
      }
      if (o.kind === "platform") {
        const snapshotFile = join(capture, "refs-snapshots.ndjson");
        const f = await open(snapshotFile + ".signed", "wx", 0o600);
        try {
          for await (const line of lines(snapshotFile)) {
            await check();
            const row = JSON.parse(line);
            row.signature = await snapshotSignature(
              db,
              new PackStore(o.storage),
              row.manifest_hash,
            );
            await writeAll(f, Buffer.from(JSON.stringify(row) + "\n"));
          }
          await f.sync();
        } finally {
          await f.close();
        }
        await rename(snapshotFile + ".signed", snapshotFile);
      }
      const seqs = (
        await db.query(
          "SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename",
        )
      ).rows;
      for (const { name } of seqs) {
        if (
          o.kind === "platform" &&
          !["audit_id_seq", "personal_notification_bucket"].includes(name)
        )
          continue;
        const r = (
          await db.query(
            `SELECT last_value::text AS value,is_called AS called FROM ${q(name)}`,
          )
        ).rows[0];
        plan.sequences.push({ name, ...r });
      }
      if (o.kind === "full") {
        const packs = (
          await db.query(
            "SELECT DISTINCT pack FROM archive_objects ORDER BY pack",
          )
        ).rows;
        let copied = 0;
        for (const { pack } of packs) {
          await o.progress?.({
            phase: "packs",
            completed: copied++,
            total: packs.length,
          });
          if (!/^[a-f0-9-]+\.pmpack$/.test(pack)) throw Error("PACK_PATH");
          await copyChecked(
            join(o.storage, "packs", pack),
            join(capture, pack),
            check,
          );
        }
        // Verify the snapshot's locators against the copied bytes, not a later DB view.
        await verifyPackRows(db, new PackStore(capture), check, true);
      }
      for (const name of (await readdir(capture)).sort()) {
        await check();
        plan.files.push(await fileEntry(capture, name));
      }
      await syncDir(capture);
      await jsonFile(join(root, "capture.json"), plan);
      await db.query("COMMIT");
      await db.query(
        "SELECT pg_advisory_unlock_shared(70210402),pg_advisory_unlock_shared(70210401)",
      );
      locked = false;
    }
    // A valid published archive makes retries idempotent, including a crash before cleanup.
    try {
      const chain = await openChain([output]);
      await verify(chain);
      if (
        chain.manifest.catalog &&
        (chain.manifest.catalog as Plan).id === o.id
      ) {
        await rm(capture, { recursive: true, force: true });
        return { id: o.id, hash: chain.hash };
      }
      throw Error("BACKUP_REQUEST_CONFLICT");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const f of plan.files) {
      await check();
      const actual = await fileDigest(capture, f.name);
      if (actual.sha256 !== f.sha256 || actual.size !== f.size)
        throw Error("BACKUP_CAPTURE_CORRUPT");
    }
    await rm(output, { recursive: true, force: true });
    async function* objects() {
      let completed = 0;
      for (const file of plan!.files) {
        await o.progress?.({
          phase: "volumes",
          completed: completed++,
          total: plan!.files.length,
        });
        const f = await open(join(capture, file.name), "r");
        try {
          for (
            let offset = 0, i = 0;
            offset < file.size;
            offset += CHUNK, i++
          ) {
            await check();
            const bytes = Buffer.alloc(Math.min(CHUNK, file.size - offset));
            let n = 0;
            while (n < bytes.length) {
              const r = await f.read(bytes, n, bytes.length - n, offset + n);
              if (!r.bytesRead) throw Error("BACKUP_TRUNCATED");
              n += r.bytesRead;
            }
            yield { hash: file.chunks[i], kind: "backup_chunk", bytes };
          }
        } finally {
          await f.close();
        }
      }
    }
    const result = await writeArchive({
      format: "palimora-backup-v1",
      root: output,
      origin: plan.origin,
      catalog: plan,
      objects: objects(),
      volumeBytes: o.volumeBytes,
      check: () => check(CHUNK),
      stopped: o.stopped,
    });
    await verify(await openChain([output]));
    await rm(capture, { recursive: true, force: true });
    return { id: o.id, hash: result.hash };
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    if (locked)
      await db.query(
        "SELECT pg_advisory_unlock_shared(70210402),pg_advisory_unlock_shared(70210401)",
      );
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1,70210460))", [
      o.id,
    ]);
    db.release();
    await target.close();
  }
}
async function verifyPackRows(
  db: PoolClient,
  store: PackStore,
  check: () => Promise<void>,
  flat = false,
) {
  await db.query(
    `DECLARE backup_objects NO SCROLL CURSOR FOR SELECT ${objectProjection} FROM ${objectFrom} ORDER BY o.hash`,
  );
  try {
    while (true) {
      const rows = (await db.query("FETCH 128 FROM backup_objects")).rows;
      if (!rows.length) break;
      for (const r of rows) {
        await check();
        const bytes = await store.read(
          {
            ...r,
            offset: Number(r.byte_offset),
            length: Number(r.length),
            size: Number(r.size),
          },
          flat ? store.root : undefined,
        );
        if (r.kind === "manifest" || r.kind === "chunk_manifest") {
          const doc = JSON.parse(bytes.toString());
          const refs = [...(doc.objects ?? []), ...(doc.chunks ?? [])].map(
            (x: any) => x.hash,
          );
          if (doc.metadata_hash) refs.push(doc.metadata_hash);
          const hashes = [...new Set(refs)];
          if (
            hashes.some(
              (h) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h),
            )
          )
            throw Error("BACKUP_REFERENCE_INVALID");
          if (
            hashes.length &&
            (
              await db.query(
                "SELECT count(*) FROM archive_object_data WHERE hash=ANY($1::bytea[])",
                [hashes.map((hash) => Buffer.from(hash, "hex"))],
              )
            ).rows[0].count !== String(hashes.length)
          )
            throw Error("BACKUP_REFERENCE_MISSING");
        }
      }
    }
  } finally {
    await db.query("CLOSE backup_objects");
  }
}

export interface RestoreOptions {
  database: Pool;
  target: BackupTarget;
  id: string;
  storage: string;
  confirmation: string;
  stopped?: () => boolean;
  storageTarget?: BackupTarget;
}
async function localMigrations(plan: Plan) {
  const dir = join(__dirname, "../migrations");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  if (
    !plan.migrations.length ||
    plan.migrations.some((m, i) => m.name !== names[i])
  )
    throw Error("BACKUP_SCHEMA_VERSION");
  for (const m of plan.migrations)
    if (digest(await readFile(join(dir, m.name))) !== m.hash)
      throw Error("BACKUP_MIGRATION_CHECKSUM");
}
function validatePlan(plan: Plan) {
  if (
    plan?.schema !== "palimora-backup-catalog-v1" ||
    !["full", "platform"].includes(plan.kind) ||
    !Array.isArray(plan.files) ||
    !Array.isArray(plan.tables) ||
    !Array.isArray(plan.sequences) ||
    !/^[a-f0-9]{64}$/i.test(plan.config?.authKey)
  )
    throw Error("BACKUP_MANIFEST");
  const seen = new Set<string>();
  for (const f of plan.files) {
    if (
      !/^(?:[a-z_][a-z0-9_-]*\.ndjson|[a-f0-9-]+\.pmpack)$/.test(f.name) ||
      seen.has(f.name) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Array.isArray(f.chunks) ||
      f.chunks.some((h) => !/^[a-f0-9]{64}$/.test(h))
    )
      throw Error("BACKUP_FILE");
    seen.add(f.name);
  }
  if (
    new Set(plan.tables).size !== plan.tables.length ||
    plan.tables.some((t) => !seen.has(t + ".ndjson"))
  )
    throw Error("BACKUP_TABLES");
}
export async function inspectBackup(targetConfig: BackupTarget, id: string) {
  validId(id);
  const target = await openBackupTarget(targetConfig, { readOnly: true });
  try {
    const chain = await openChain([join(target.path, id, "archive")]);
    if (chain.manifest.format !== "palimora-backup-v1")
      throw Error("BACKUP_FORMAT");
    const plan = chain.manifest.catalog as Plan;
    validatePlan(plan);
    await localMigrations(plan);
    await verify(chain);
    return {
      id,
      hash: chain.hash,
      kind: plan.kind,
      captured_at: plan.captured_at,
      tables: plan.tables,
      files: plan.files.length,
      bytes: plan.files.reduce((n, f) => n + f.size, 0),
      confirmation: `RESTORE ${chain.hash}`,
    };
  } finally {
    await target.close();
  }
}
/** No in-place destructive restore: full requires an empty schema; platform
 * requires a corpus with no local users. Retry receipts are transactional. */
export async function restoreBackup(o: RestoreOptions) {
  validId(o.id);
  if (typeof o.storage !== "string" || !o.storage)
    throw Error("BACKUP_STORAGE_REQUIRED");
  const target = await openBackupTarget(o.target, { readOnly: true }),
    db = await o.database.connect().catch(async (error) => {
      await target.close();
      throw error;
    });
  const storageRoot = resolve(o.storage);
  const storageTarget = o.storageTarget
    ? await openBackupTarget(o.storageTarget).catch(async (error) => {
        await target.close();
        db.release();
        throw error;
      })
    : undefined;
  if (
    storageTarget &&
    dirname(storageRoot) !== resolve(o.storageTarget!.path)
  ) {
    await storageTarget.close();
    await target.close();
    db.release();
    throw Error("RESTORE_STORAGE_TARGET");
  }
  const root = storageTarget
    ? join(storageTarget.path, basename(storageRoot))
    : storageRoot;
  const check = async () => {
    if (o.stopped?.()) throw Error("RESTORE_INTERRUPTED");
    await target.check();
    await storageTarget?.check();
  };
  let begun = false;
  try {
    const chain = await openChain([join(target.path, o.id, "archive")]);
    if (chain.manifest.format !== "palimora-backup-v1")
      throw Error("BACKUP_FORMAT");
    const plan = chain.manifest.catalog as Plan;
    validatePlan(plan);
    await localMigrations(plan);
    if (o.confirmation !== `RESTORE ${chain.hash}`)
      throw Error("RESTORE_CONFIRMATION_REQUIRED");
    await check();
    await verify(chain);
    await db.query(
      "BEGIN; SET LOCAL statement_timeout=0; SET LOCAL lock_timeout='5s'",
    );
    begun = true;
    await db.query(
      "SELECT pg_advisory_xact_lock(70210401),pg_advisory_xact_lock(70210402),pg_advisory_xact_lock(70210460)",
    );
    let names = await tables(db);
    if (names.includes("backup_restores")) {
      const prior = (
        await db.query("SELECT * FROM backup_restores WHERE manifest_hash=$1", [
          chain.hash,
        ])
      ).rows[0];
      if (prior) {
        if (prior.storage_root !== storageRoot)
          throw Error("RESTORE_TARGET_CHANGED");
        await verifyPackRows(db, new PackStore(root), check);
        await db.query("COMMIT");
        begun = false;
        await cleanupRestore(root, chain.hash, plan);
        return prior.report;
      }
    }
    if (plan.kind === "full" && names.length)
      throw Error("RESTORE_DATABASE_NOT_EMPTY");
    if (plan.kind === "platform") {
      if (!names.includes("users")) throw Error("RESTORE_CORPUS_REQUIRED");
      // Strong table locks prevent a concurrent bootstrap or library writer from
      // racing the emptiness check. Existing user data is never overwritten.
      await db.query(
        `LOCK TABLE ${names.map(q).join(",")} IN ACCESS EXCLUSIVE MODE`,
      );
      if ((await db.query("SELECT 1 FROM users LIMIT 1")).rowCount)
        throw Error("RESTORE_USERS_EXIST");
      const migrations = (
        await db.query("SELECT name,hash FROM schema_migrations ORDER BY name")
      ).rows;
      if (JSON.stringify(migrations) !== JSON.stringify(plan.migrations))
        throw Error("RESTORE_PLATFORM_SCHEMA_MISMATCH");
    } else await applyMigrations(db, plan.migrations.at(-1)!.name);
    names = await tables(db);
    const expected =
      plan.kind === "full" ? names : names.filter((t) => platformTables.has(t));
    if (
      JSON.stringify([...plan.tables].sort()) !==
      JSON.stringify([...expected].sort())
    )
      throw Error("BACKUP_TABLE_SCOPE");
    if (plan.kind === "full") {
      if (!storageTarget && (await realpath(dirname(root))) !== dirname(root))
        throw Error("RESTORE_STORAGE_SYMLINK");
      try {
        await mkdir(root, { mode: 0o700 });
        await syncDir(dirname(root));
        await jsonFile(join(root, ".palimora-restore"), { hash: chain.hash });
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        const marker = JSON.parse(
          await readFile(join(root, ".palimora-restore"), "utf8"),
        );
        if (marker.hash !== chain.hash) throw Error("RESTORE_STORAGE_EXISTS");
      }
    } else {
      if ((await realpath(root)) !== storageRoot)
        throw Error("RESTORE_STORAGE_SYMLINK");
    }
    if (!(await lstat(root)).isDirectory())
      throw Error("RESTORE_STORAGE_SYMLINK");
    const stage = join(root, ".restore-" + chain.hash);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    if (!(await lstat(stage)).isDirectory()) throw Error("RESTORE_DIRECTORY");
    const { statfs } = await import("node:fs/promises");
    for (const file of plan.files) {
      await check();
      const dest = join(stage, file.name);
      if (plan.kind === "full" && file.name.endsWith(".pmpack")) {
        try {
          const ready = await fileDigest(join(root, "packs"), file.name);
          if (ready.sha256 !== file.sha256 || ready.size !== file.size)
            throw Error("RESTORE_PACK_CONFLICT");
          continue;
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      try {
        const existing = await fileDigest(stage, file.name);
        if (existing.sha256 === file.sha256 && existing.size === file.size)
          continue;
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      const f = await open(dest + ".partial", "w", 0o600),
        checksum = createHash("sha256");
      let size = 0;
      try {
        for (const hash of file.chunks)
          for await (const bytes of portableObject(chain, hash)) {
            await check();
            const disk = await statfs(root, { bigint: true });
            if (disk.bavail * disk.bsize < BigInt(bytes.length) + 268435456n)
              throw Object.assign(Error("RESTORE_SPACE_INSUFFICIENT"), {
                code: "ENOSPC",
              });
            await writeAll(f, bytes);
            checksum.update(bytes);
            size += bytes.length;
          }
        if (size !== file.size || checksum.digest("hex") !== file.sha256)
          throw Error("BACKUP_FILE_CHECKSUM");
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(dest + ".partial", dest);
      await syncDir(stage);
    }
    if (plan.kind === "full") {
      await mkdir(join(root, "packs"), { recursive: true });
      await mkdir(join(root, "staging"), { recursive: true });
      for (const file of plan.files.filter((f) => f.name.endsWith(".pmpack"))) {
        try {
          const existing = await fileDigest(join(root, "packs"), file.name);
          if (existing.sha256 !== file.sha256)
            throw Error("RESTORE_PACK_CONFLICT");
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
          await rename(join(stage, file.name), join(root, "packs", file.name));
        }
      }
      await syncDir(stage);
      await syncDir(join(root, "packs"));
      await syncDir(root);
    }
    const report: {
      kind: string;
      restored: number;
      unresolved: { table: string; reason: string; row: unknown }[];
    } = { kind: plan.kind, restored: 0, unresolved: [] };
    // Only user triggers are disabled, transactionally and only on destination
    // tables. FK enforcement stays enabled and is explicitly validated before commit.
    const constraints = (
      await db.query(
        `SELECT c.conname AS name,t.relname AS table,c.condeferrable AS deferred,c.condeferred AS initially FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE c.contype='f' AND t.relnamespace=current_schema()::regnamespace`,
      )
    ).rows;
    for (const c of constraints)
      if (plan.tables.includes(c.table))
        await db.query(
          `ALTER TABLE ${q(c.table)} ALTER CONSTRAINT ${q(c.name)} DEFERRABLE INITIALLY DEFERRED`,
        );
    for (const t of plan.tables)
      await db.query(`ALTER TABLE ${q(t)} DISABLE TRIGGER USER`);
    // Full capture has every table. Platform has no users yet; DELETE is used
    // for seeded singleton configuration, avoiding TRUNCATE's inbound FK scope.
    if (plan.kind === "full")
      await db.query(`TRUNCATE ${plan.tables.map(q).join(",")}`);
    else for (const t of plan.tables) await db.query(`DELETE FROM ${q(t)}`);
    const maps =
      plan.kind === "platform"
        ? await referenceMaps(db, stage, new PackStore(root))
        : undefined;
    for (const t of plan.tables) {
      await db.query(
        `CREATE TEMP TABLE ${q("restore_" + t)} (LIKE ${q(t)} INCLUDING DEFAULTS) ON COMMIT DROP`,
      );
      if (!maps) {
        await restoreRows(db, t, join(stage, t + ".ndjson"), check);
        continue;
      }
      for await (const line of lines(join(stage, t + ".ndjson"))) {
        await check();
        let expression = "$1::jsonb";
        const parameters: any[] = [line];
        if (maps) {
          const row = JSON.parse(line);
          try {
            const original = JSON.parse(line);
            remapRow(row, maps);
            const changes: { path: string[]; value: unknown }[] = [];
            const diff = (before: any, after: any, path: string[]) => {
              if (before === after) return;
              if (
                before &&
                after &&
                typeof before === "object" &&
                typeof after === "object"
              ) {
                for (const key of Object.keys(after))
                  diff(before[key], after[key], [...path, key]);
              } else changes.push({ path, value: after });
            };
            diff(original, row, []);
            for (const change of changes) {
              parameters.push(change.path, JSON.stringify(change.value));
              expression = `jsonb_set(${expression},$${parameters.length - 1}::text[],$${parameters.length}::jsonb)`;
            }
          } catch {
            report.unresolved.push({
              table: t,
              reason: "CORPUS_REFERENCE_UNRESOLVED",
              row: line,
            });
            continue;
          }
        }
        await db.query(
          `INSERT INTO ${q("restore_" + t)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(NULL::${q(t)},(${expression})::json)`,
          parameters,
        );
      }
    }
    if (maps) await pruneReferences(db, plan.tables, report);
    for (const t of plan.tables) {
      const inserted = await db.query(
        `INSERT INTO ${q(t)} OVERRIDING SYSTEM VALUE SELECT * FROM ${q("restore_" + t)}`,
      );
      report.restored += inserted.rowCount ?? 0;
    }
    if (plan.kind === "full") {
      await db.query("DELETE FROM backup_notification_eligibility");
      for await (const line of lines(
        join(stage, "notification-boundaries.ndjson"),
      ))
        await db.query(
          "INSERT INTO backup_notification_eligibility SELECT * FROM json_populate_record(NULL::backup_notification_eligibility,$1::json)",
          [line],
        );
    }
    // PostgreSQL transaction IDs are local to a cluster. Never compare captured
    // pg_snapshot/xid8 values against the destination's transaction timeline.
    await db.query(
      "UPDATE personal_subscriptions SET start_snapshot=pg_current_snapshot()",
    );
    if (plan.kind === "full")
      await db.query("UPDATE archive_outbox SET producer_xid=NULL");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const c of constraints)
      if (plan.tables.includes(c.table))
        await db.query(
          `ALTER TABLE ${q(c.table)} ALTER CONSTRAINT ${q(c.name)} ${c.deferred ? "DEFERRABLE" : "NOT DEFERRABLE"} INITIALLY ${c.initially ? "DEFERRED" : "IMMEDIATE"}`,
        );
    for (const t of plan.tables)
      await db.query(`ALTER TABLE ${q(t)} ENABLE TRIGGER USER`);
    const seqs = new Set(
      (
        await db.query(
          "SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema()",
        )
      ).rows.map((r) => r.name),
    );
    for (const s of plan.sequences) {
      if (
        !seqs.has(s.name) ||
        !/^\d+$/.test(s.value) ||
        (plan.kind === "platform" &&
          !["audit_id_seq", "personal_notification_bucket"].includes(s.name))
      )
        throw Error("BACKUP_SEQUENCE");
      // ALTER RESTART is transactional, unlike setval.
      await db.query(
        `ALTER SEQUENCE ${q(s.name)} RESTART WITH ${BigInt(s.value) + (s.called ? 1n : 0n)}`,
      );
    }
    if (plan.kind === "full") await applyMigrations(db);
    await verifyPackRows(db, new PackStore(root), check);
    // Search is derived. A new epoch avoids accepting stale OpenSearch results.
    if (plan.kind === "full") {
      await db.query(
        "UPDATE catalog_search_state SET epoch=gen_random_uuid(); INSERT INTO catalog_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING; INSERT INTO catalog_text_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING; INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshot_data ON CONFLICT DO NOTHING",
      );
    }
    if (names.includes("backup_runs"))
      await db.query(
        "UPDATE backup_runs SET state='paused' WHERE state IN ('pending','running','pause_requested','cancel_requested'); UPDATE backup_schedules SET enabled=false",
      );
    if (names.includes("integrity_schedule"))
      await db.query("UPDATE integrity_schedule SET enabled=false");
    if (names.includes("archive_jobs"))
      await db.query(
        "UPDATE archive_jobs SET state='paused' WHERE kind IN('scrub','repair') AND state IN('pending','running','pause_requested')",
      );
    await db.query(
      "UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE parent_session_id IS NOT NULL",
    );
    await jsonFile(join(stage, "configuration.json"), plan.config);
    await jsonFile(join(stage, "report.json"), report);
    await db.query(
      "INSERT INTO backup_restores(manifest_hash,kind,storage_root,report) VALUES($1,$2,$3,$4)",
      [chain.hash, plan.kind, storageRoot, report],
    );
    await check();
    await db.query("COMMIT");
    begun = false;
    await cleanupRestore(root, chain.hash, plan);
    return report;
  } finally {
    if (begun) await db.query("ROLLBACK");
    db.release();
    await target.close();
    await storageTarget?.close();
  }
}
type ReferenceMaps = {
  work: Map<string, string>;
  snapshot: Map<string, string>;
  chapter: Map<string, string>;
};
async function referenceMaps(
  db: PoolClient,
  stage: string,
  store: PackStore,
): Promise<ReferenceMaps> {
  const maps: ReferenceMaps = {
    work: new Map(),
    snapshot: new Map(),
    chapter: new Map(),
  };
  for await (const line of lines(join(stage, "refs-works.ndjson"))) {
    const r = JSON.parse(line);
    const found = (
      await db.query(
        "SELECT id FROM archive_work_heads WHERE (id=$1 AND external_id IS NOT DISTINCT FROM $2) OR ($2::text IS NOT NULL AND external_id=$2)",
        [r.id, r.external_id],
      )
    ).rows;
    if (found.length === 1) maps.work.set(r.id, found[0].id);
  }
  for await (const line of lines(join(stage, "refs-snapshots.ndjson"))) {
    const r = JSON.parse(line),
      work = maps.work.get(r.work_id);
    if (!work) continue;
    const candidates = (
      await db.query(
        "SELECT id,manifest_hash FROM archive_snapshots WHERE work_id=$1 ORDER BY (id=$2) DESC",
        [work, r.id],
      )
    ).rows;
    const found = [];
    for (const c of candidates)
      if (
        c.manifest_hash === r.manifest_hash ||
        (r.signature &&
          (await snapshotSignature(db, store, c.manifest_hash)) === r.signature)
      )
        found.push(c);
    if (found.length === 1 || found[0]?.id === r.id)
      maps.snapshot.set(r.id, found[0].id);
  }
  for await (const line of lines(join(stage, "refs-chapters.ndjson"))) {
    const r = JSON.parse(line),
      work = maps.work.get(r.work_id);
    if (!work) continue;
    const found = (
      await db.query(
        "SELECT id FROM archive_chapters WHERE work_id=$1 AND source_key=$2",
        [work, r.source_key],
      )
    ).rows;
    if (found.length === 1) maps.chapter.set(r.id, found[0].id);
  }
  return maps;
}
function remapRow(row: any, maps: ReferenceMaps) {
  const mapped = (map: Map<string, string>, value: string) => {
    const result = map.get(value);
    if (!result) throw Error("UNRESOLVED");
    return result;
  };
  function visit(value: any) {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (value[key] === null) continue;
      if (key === "work_id") value[key] = mapped(maps.work, value[key]);
      else if (key === "snapshot_id" || key === "snapshot")
        value[key] = mapped(maps.snapshot, value[key]);
      else if (key === "chapter" && typeof value[key] === "string")
        value[key] = mapped(maps.chapter, value[key]);
      else visit(value[key]);
    }
  }
  visit(row);
  if (row.kind === "work" && typeof row.target === "string")
    row.target = mapped(maps.work, row.target);
}
async function pruneReferences(
  db: PoolClient,
  selected: string[],
  report: { unresolved: any[] },
) {
  const foreign = (
    await db.query(`SELECT t.relname AS child,p.relname AS parent,
    array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.i) AS child_keys,
    array(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.i) AS parent_keys
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class p ON p.oid=c.confrelid WHERE c.contype='f' AND t.relnamespace=current_schema()::regnamespace`)
  ).rows;
  let removed;
  do {
    removed = 0;
    for (const f of foreign) {
      if (!selected.includes(f.child)) continue;
      const parent = selected.includes(f.parent)
        ? "restore_" + f.parent
        : f.parent;
      const all = f.child_keys
        .map((k: string) => `c.${q(k)} IS NOT NULL`)
        .join(" AND ");
      const equal = f.child_keys
        .map((k: string, i: number) => `c.${q(k)}=p.${q(f.parent_keys[i])}`)
        .join(" AND ");
      const rows = (
        await db.query(
          `DELETE FROM ${q("restore_" + f.child)} c WHERE ${all} AND NOT EXISTS(SELECT 1 FROM ${q(parent)} p WHERE ${equal}) RETURNING row_to_json(c) AS row`,
        )
      ).rows;
      removed += rows.length;
      for (const r of rows)
        report.unresolved.push({
          table: f.child,
          reason: "DEPENDENT_REFERENCE_UNRESOLVED",
          row: r.row,
        });
    }
  } while (removed);
}

async function snapshotSignature(
  db: PoolClient,
  store: PackStore,
  hash: string,
) {
  const r = (await findObjects(db, [hash]))[0];
  if (!r) throw Error("BACKUP_REFERENCE_MISSING");
  const doc = JSON.parse(
    (
      await store.read({
        ...r,
        offset: Number(r.byte_offset),
        length: Number(r.length),
        size: Number(r.size),
      })
    ).toString(),
  );
  delete doc.work_id;
  for (const chapter of doc.chapters ?? []) {
    delete chapter.chapter_id;
    delete chapter.revision_id;
  }
  return digest(canonical(doc));
}

async function cleanupRestore(root: string, hash: string, plan: Plan) {
  const stage = join(root, ".restore-" + hash);
  for (const file of plan.files)
    for (const name of [file.name, file.name + ".partial"])
      await rm(join(stage, name), { force: true });
  await syncDir(stage);
}
