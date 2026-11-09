// Only called by the isolated P5 controller; capacity injection never enters production.
const fs = require("node:fs");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  !process.env.ARCHIVE_ROOT.startsWith("/benchmark/")
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
let calls = 0,
  waitMs = 0,
  maxWaitMs = 0,
  maxWaiting = 0;
const connect = pool.connect.bind(pool);
pool.connect = function (cb) {
  const t = performance.now();
  maxWaiting = Math.max(maxWaiting, pool.waitingCount);
  const done = () => {
    const ms = performance.now() - t;
    calls++;
    waitMs += ms;
    maxWaitMs = Math.max(maxWaitMs, ms);
  };
  if (cb)
    return connect((...args) => {
      done();
      cb(...args);
    });
  return connect().finally(done);
};
function poolSample() {
  fs.appendFileSync(
    "/results/" +
      (process.env.ARCHIVE_ROOT === "/benchmark/main"
        ? "pool-waits"
        : "csv-pool-waits") +
      ".jsonl",
    JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      calls,
      wait_ms: waitMs,
      max_wait_ms: maxWaitMs,
      max_waiting: maxWaiting,
    }) + "\n",
  );
}
const sampling = setInterval(poolSample, 5000);
sampling.unref();

const { createIngestPressure } = require("../apps/api/dist/ingest-pressure");
const pressure = createIngestPressure(pool, process.env.ARCHIVE_ROOT);
const collect = pressure.collect.bind(pressure);
pressure.collect = async () => {
  const s = await collect();
  if (fs.existsSync("/results/inject-disk-pause"))
    s.disks = s.disks.map((d) => ({ ...d, free: 1 }));
  return s;
};
require("../apps/api/dist/ingest-worker")
  .tick(process.argv[2], pressure)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(sampling);
    poolSample();
    return pool.end();
  });
