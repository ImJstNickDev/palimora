import { readFile, statfs, open, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { BackupTarget, openBackupTarget } from "./backup-target";
import { pool } from "./db";
export interface BackupConfig {
  destinations: (BackupTarget & { label: string })[];
  restores: {
    name: string;
    label: string;
    databaseUrlFile: string;
    storage: string;
    storageTarget?: BackupTarget;
  }[];
}
export async function backupConfig(): Promise<BackupConfig> {
  if (!process.env.BACKUP_CONFIG_FILE)
    return { destinations: [], restores: [] };
  const c = JSON.parse(
    await readFile(process.env.BACKUP_CONFIG_FILE, "utf8"),
  ) as BackupConfig;
  if (!Array.isArray(c.destinations) || !Array.isArray(c.restores))
    throw Error("BACKUP_CONFIG");
  for (const group of [c.destinations, c.restores]) {
    const seen = new Set();
    for (const r of group) {
      if (
        !/^[a-z0-9_-]{1,64}$/.test(r.name) ||
        seen.has(r.name) ||
        typeof r.label !== "string" ||
        r.label.length > 100
      )
        throw Error("BACKUP_CONFIG");
      seen.add(r.name);
    }
  }
  return c;
}
export async function destination(name: string) {
  const d = (await backupConfig()).destinations.find((d) => d.name === name);
  if (!d) throw Error("BACKUP_DESTINATION_UNKNOWN");
  return d;
}
export async function probeDestination(name: string) {
  const d = await destination(name);
  let target;
  try {
    target = await openBackupTarget(d);
    const disk = await statfs(target.path);
    const probe = join(target.path, ".probe-" + randomUUID());
    const f = await open(probe, "wx", 0o600);
    try {
      await f.write("palimora");
      await f.sync();
    } finally {
      await f.close();
      await unlink(probe);
    }
    return {
      available: true,
      writable: true,
      free: disk.bavail * disk.bsize,
      total: disk.blocks * disk.bsize,
      error: null,
    };
  } catch (e: any) {
    return {
      available: false,
      writable: false,
      free: null,
      total: null,
      error: safeBackupError(e),
    };
  } finally {
    await target?.close();
  }
}
export function safeBackupError(e: any) {
  return /^[A-Z][A-Z_]{2,80}$/.test(e?.message)
    ? e.message
    : ((
        {
          ENOENT: "BACKUP_MOUNT_UNAVAILABLE",
          EACCES: "BACKUP_PERMISSION_DENIED",
          EROFS: "BACKUP_READ_ONLY",
          ENOSPC: "BACKUP_SPACE_INSUFFICIENT",
        } as any
      )[e?.code] ?? "BACKUP_OPERATION_FAILED");
}
export async function restoreConnection(name: string) {
  const config = (await backupConfig()).restores.find((t) => t.name === name);
  if (!config) throw Error("RESTORE_TARGET_UNKNOWN");
  const current = resolve(process.env.ARCHIVE_ROOT ?? "/storage"),
    target = resolve(config.storage);
  if (
    target === current ||
    target.startsWith(current + "/") ||
    current.startsWith(target + "/")
  )
    throw Error("RESTORE_TARGET_IS_SOURCE");
  const database = new Pool({
    connectionString: (await readFile(config.databaseUrlFile, "utf8")).trim(),
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const sql =
      "SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port";
    const [a, b] = await Promise.all([pool.query(sql), database.query(sql)]);
    if (JSON.stringify(a.rows[0]) === JSON.stringify(b.rows[0]))
      throw Error("RESTORE_TARGET_IS_SOURCE");
    return { config, database };
  } catch (e) {
    await database.end();
    throw e;
  }
}
export async function restoreReadiness(name: string, kind: string) {
  const { config, database } = await restoreConnection(name);
  try {
    if (config.storageTarget) {
      const storage = await openBackupTarget(config.storageTarget);
      await storage.close();
    }
    if (kind === "full") {
      try {
        await lstat(config.storage);
        throw Error("RESTORE_STORAGE_NOT_EMPTY");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const tables = (
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=current_schema()",
      )
    ).rows;
    if (kind === "platform") {
      if (!tables.some((t) => t.tablename === "users"))
        throw Error("RESTORE_CORPUS_REQUIRED");
      if ((await database.query("SELECT 1 FROM users LIMIT 1")).rowCount)
        throw Error("RESTORE_USERS_EXIST");
    } else if (tables.length) throw Error("RESTORE_DATABASE_NOT_EMPTY");
    return { name, label: config.label, ready: true, error: null };
  } catch (e) {
    return {
      name,
      label: config.label,
      ready: false,
      error: safeBackupError(e),
    };
  } finally {
    await database.end();
  }
}
