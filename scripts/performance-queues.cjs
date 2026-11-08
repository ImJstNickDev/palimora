// Low-rate aggregate queue and lock samples, no work IDs or SQL text.
const fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
(async () => {
  while (!stop && !fs.existsSync("/results/end-to-end.json")) {
    const queues = (
      await pool.query(
        "SELECT (SELECT count(*) FROM catalog_pending) catalog,(SELECT count(*) FROM catalog_snapshot_pending) historical,(SELECT count(*) FROM catalog_text_pending) text",
      )
    ).rows[0];
    const waits = (
      await pool.query(
        "SELECT state,wait_event_type,wait_event,count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2,3",
      )
    ).rows;
    fs.appendFileSync(
      "/results/queue-samples.jsonl",
      JSON.stringify({ time: Date.now(), queues, waits }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
