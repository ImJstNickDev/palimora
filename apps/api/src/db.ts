import { Pool, PoolClient } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    `postgresql://palimora:${encodeURIComponent(readFileSync(process.env.DB_PASSWORD_FILE!, "utf8").trim())}@${process.env.DB_HOST ?? "postgres"}:5432/palimora`,
  max: 12,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
// A checked-out socket can emit another error while it closes, after its phase
// listener has been removed. Query promises still reject; retain a lifetime
// observer so a database restart does not become an uncaught process exception.
pool.on("connect", (client) =>
  client.on("error", () =>
    console.error(JSON.stringify({ event: "database_client_disconnected" })),
  ),
);
pool.on("error", () =>
  console.error(JSON.stringify({ event: "database_connection_error" })),
);
export type DB = PoolClient;
export async function transaction<T>(fn: (db: DB) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN; SET LOCAL default_toast_compression=lz4");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function migrate() {
  await transaction((db) => applyMigrations(db));
}
export async function applyMigrations(db: DB, through?: string) {
  await db.query("SET LOCAL statement_timeout=0");
  await db.query("SELECT pg_advisory_xact_lock(70210401)");
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const dir = join(__dirname, "../migrations");
  const files = readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort();
  const applied = await db.query("SELECT name FROM schema_migrations");
  if (applied.rows.some((row) => !files.includes(row.name)))
    throw Error("Database schema is newer than this API");
  for (const name of files) {
    if (through && name > through) break;
    const sql = readFileSync(join(dir, name), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const existing = await db.query(
      "SELECT hash FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0].hash !== hash)
        throw Error("Migration checksum mismatch: " + name);
      continue;
    }
    await db.query(sql);
    await db.query("INSERT INTO schema_migrations(name,hash) VALUES($1,$2)", [
      name,
      hash,
    ]);
  }
}
