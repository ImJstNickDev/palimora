"use strict";
const http = require("node:http");
let previous = new Map(),
  latest = { at: null, containers: [], error: "COLLECTOR_STARTING" };
async function sample() {
  try {
    const r = await fetch(
      (process.env.METRICS_PROXY_URL || "http://metrics-proxy:9101") +
        "/snapshot",
      { signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) throw Error();
    const value = await r.json(),
      now = Date.parse(value.at),
      next = new Map();
    const containers = value.containers.map((c) => {
      const before = previous.get(c.id),
        raw = c.metrics,
        m = raw
          ? {
              memory_bytes: raw.memory_bytes,
              memory_limit: raw.memory_limit,
              cpu_percent: null,
              rx_per_second: null,
              tx_per_second: null,
              read_per_second: null,
              write_per_second: null,
            }
          : null;
      if (raw && before && now > before.at && now - before.at < 60000) {
        const seconds = (now - before.at) / 1000,
          p = before.raw;
        if (
          [raw.cpu_ns, p.cpu_ns, raw.system_ns, p.system_ns, raw.cpus].every(
            Number.isFinite,
          ) &&
          raw.cpu_ns >= p.cpu_ns &&
          raw.system_ns > p.system_ns &&
          raw.cpus > 0
        )
          m.cpu_percent =
            ((raw.cpu_ns - p.cpu_ns) / (raw.system_ns - p.system_ns)) *
            raw.cpus *
            100;
        for (const [counter, out] of [
          ["rx_bytes", "rx_per_second"],
          ["tx_bytes", "tx_per_second"],
          ["read_bytes", "read_per_second"],
          ["write_bytes", "write_per_second"],
        ])
          if (
            raw[counter] != null &&
            p[counter] != null &&
            raw[counter] >= p[counter]
          )
            m[out] = (raw[counter] - p[counter]) / seconds;
      }
      if (raw) next.set(c.id, { at: now, raw });
      return { ...c, metrics: m };
    });
    previous = next;
    latest = { at: value.at, containers, error: null };
  } catch {
    latest = { ...latest, error: "DOCKER_UNAVAILABLE" };
  }
}
let stopped = false;
async function loop() {
  while (!stopped) {
    await sample();
    await new Promise((r) =>
      setTimeout(r, Number(process.env.SAMPLE_MS || 10000)),
    );
  }
}
const server = http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" || req.url !== "/snapshot") {
      res.writeHead(404);
      return res.end("{}");
    }
    res.end(JSON.stringify(latest));
  })
  .listen(Number(process.env.PORT || 9100), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopped = true;
    server.close();
  });
void loop();
