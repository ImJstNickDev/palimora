// Interleaved warm SQL-wrapper overhead on real PostgreSQL; no app data touched.
const fs = require("node:fs");
const { Client } = require("pg");
const { pool } = require("../apps/api/dist/db");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
(async () => {
  const db = await pool.connect();
  const original = Client.prototype.query;
  process.env.P0_PROFILE = "/results/overhead-projection-profile.json";
  require("./performance-profiler.cjs");
  const instrumented = Client.prototype.query;
  const result = {
    off: [],
    on: [],
    order: ["off", "on", "on", "off", "off", "on"],
    queries_per_sample: 3000,
  };
  try {
    Client.prototype.query = original;
    for (let i = 0; i < 3000; i++) await db.query("SELECT 1");
    for (const mode of result.order) {
      Client.prototype.query = mode === "on" ? instrumented : original;
      for (let i = 0; i < 100; i++) await db.query("SELECT 1");
      const t = performance.now();
      for (let i = 0; i < 3000; i++) await db.query("SELECT 1");
      result[mode].push((performance.now() - t) / 3000);
    }
    fs.writeFileSync("/results/profiler-overhead.json", JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    Client.prototype.query = original;
    db.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
