// Optional, content-free diagnostics shared by the inline and isolated profiles.
require("./performance-p2c.cjs");
if (process.env.P0_PROFILE && process.env.P2D_DIAGNOSTICS === "1") {
  const fs = require("node:fs");
  const path = process.env.P0_PROFILE.replace(/\.json$/, "-p2d-events.jsonl");
  const emit = (e) => fs.appendFileSync(path, JSON.stringify(e) + "\n");
  let sqlCalls = 0,
    sqlMs = 0,
    sqlMax = 0,
    poolCalls = 0,
    poolMs = 0;
  const pg = require("pg"),
    query = pg.Client.prototype.query,
    connect = pg.Pool.prototype.connect;
  function observe(original, record) {
    return function (...args) {
      const started = performance.now();
      let recorded = false;
      const finish = () => {
        if (!recorded) {
          recorded = true;
          record(performance.now() - started);
        }
      };
      if (typeof args.at(-1) === "function") {
        const callback = args.at(-1);
        args[args.length - 1] = function (...values) {
          finish();
          return callback.apply(this, values);
        };
      }
      try {
        const result = original.apply(this, args);
        return result?.then ? result.finally(finish) : result;
      } catch (error) {
        finish();
        throw error;
      }
    };
  }
  pg.Client.prototype.query = observe(query, (ms) => {
    sqlCalls++;
    sqlMs += ms;
    sqlMax = Math.max(sqlMax, ms);
  });
  pg.Pool.prototype.connect = observe(connect, (ms) => {
    poolCalls++;
    poolMs += ms;
  });
  const fetch = global.fetch;
  global.fetch = async (...args) => {
    const url = String(args[0]);
    const kind = url.endsWith("/_bulk")
      ? "bulk"
      : url.endsWith("/_search")
        ? "search"
        : null;
    if (!kind) return fetch(...args);
    const start = Date.now(),
      t = performance.now();
    let status = null;
    try {
      const r = await fetch(...args);
      status = r.status;
      return r;
    } finally {
      emit({
        kind: "http",
        operation: kind,
        start,
        end: Date.now(),
        ms: performance.now() - t,
        status,
      });
    }
  };
  let previous = Date.now(),
    cpu = process.cpuUsage();
  const sample = () => {
    const now = Date.now(),
      usage = process.cpuUsage(),
      memory = process.memoryUsage();
    emit({
      kind: "process",
      pid: process.pid,
      start: previous,
      end: now,
      cpu_us: usage.user + usage.system - cpu.user - cpu.system,
      rss_bytes: memory.rss,
      heap_bytes: memory.heapUsed,
      external_bytes: memory.external,
      max_rss_bytes: process.resourceUsage().maxRSS * 1024,
      sql_calls: sqlCalls,
      sql_ms: sqlMs,
      sql_max_ms: sqlMax,
      pool_calls: poolCalls,
      pool_ms: poolMs,
    });
    previous = now;
    cpu = usage;
    sqlCalls = sqlMs = sqlMax = poolCalls = poolMs = 0;
  };
  const timer = setInterval(sample, 1000);
  timer.unref();
  process.on("exit", sample);
}
