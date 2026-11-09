// Compare complete immutable SQL relations across the private full restore.
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { Pool } = require("pg");
if (new URL(process.env.DATABASE_URL).pathname !== "/palimora_release_test")
  throw Error("Private fixture required");
const source = new Pool({ connectionString: process.env.DATABASE_URL });
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/palimora_p5_restore_test";
const restored = new Pool({ connectionString: url.toString() });
(async () => {
  const signatures = {};
  for (const table of [
    "catalog_snapshot_views",
    "archive_identity_links",
    "archive_observation_data",
    "archive_record_data",
    "archive_entries",
    "archive_origins",
    "archive_payloads",
    "archive_tags",
  ]) {
    const sql = `SELECT count(*)::int rows,encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') digest FROM ${table} t`;
    const a = (await source.query(sql)).rows[0],
      b = (await restored.query(sql)).rows[0];
    assert.deepEqual(b, a, table);
    signatures[table] = a;
  }
  fs.writeFileSync(
    "/results/restore-immutable-signatures.json",
    JSON.stringify({ all_equal: true, signatures }, null, 2),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([source.end(), restored.end()]));
