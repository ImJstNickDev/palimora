// Sample activity/wait classes only, never SQL text or query parameters.
const fs = require("node:fs"),
  { Pool } = require("pg");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Private fixture required");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "palimora-observer",
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
pool.on("error", () => {});
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
(async () => {
  while (!stopped) {
    try {
      const r = await pool.query(
        `SELECT application_name,state,wait_event_type,wait_event,count(*)::int connections,count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid))>0)::int blocked,max(extract(epoch from clock_timestamp()-query_start)) FILTER(WHERE state='active')::float oldest_active_seconds FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY 1,2,3,4`,
      );
      fs.appendFileSync(
        "/results/postgres-activity.jsonl",
        JSON.stringify({ time: Date.now(), rows: r.rows }) + "\n",
      );
    } catch {
      fs.appendFileSync(
        "/results/postgres-activity.jsonl",
        JSON.stringify({ time: Date.now(), error: true }) + "\n",
      );
    }
    if (!stopped) await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
})().catch(() => (process.exitCode = 1));
