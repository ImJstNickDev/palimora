"use strict";
// This is not a general-purpose Docker proxy: callers cannot supply a Docker path or ID.
const http = require("node:http");
const project = process.env.PALIMORA_PROJECT || "palimora";
const services = new Set([
  "gateway",
  "web",
  "api",
  "ingest",
  "postgres",
  "redis",
  "opensearch",
  "metrics-proxy",
  "collector",
]);
function docker(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock", path },
      (res) => {
        let size = 0;
        const parts = [];
        res.on("data", (b) => {
          size += b.length;
          if (size > 4194304) req.destroy(Error("RESPONSE_LIMIT"));
          else parts.push(b);
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("DOCKER_UNAVAILABLE");
            resolve(JSON.parse(Buffer.concat(parts).toString()));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(4000, () => req.destroy(Error("DOCKER_TIMEOUT")));
    req.on("error", reject);
  });
}
async function snapshot() {
  const filters = encodeURIComponent(
    JSON.stringify({ label: ["com.docker.compose.project=" + project] }),
  );
  const rows = (
    await docker("/containers/json?all=1&filters=" + filters)
  ).filter(
    (c) =>
      c.Labels?.["com.docker.compose.project"] === project &&
      services.has(c.Labels?.["com.docker.compose.service"]) &&
      c.Labels?.["com.docker.compose.oneoff"] !== "True" &&
      /^[a-f0-9]{64}$/.test(c.Id),
  );
  if (rows.length > 64) throw Error("CONTAINER_LIMIT");
  const result = [];
  for (let i = 0; i < rows.length; i += 4)
    result.push(
      ...(await Promise.all(
        rows.slice(i, i + 4).map(async (c) => {
          const row = {
            id: c.Id,
            service: c.Labels["com.docker.compose.service"],
            state: c.State,
            health: /\(unhealthy\)/.test(c.Status)
              ? "unhealthy"
              : /\(healthy\)/.test(c.Status)
                ? "healthy"
                : null,
            metrics: null,
          };
          if (c.State !== "running") return row;
          try {
            const s = await docker(
              "/containers/" + c.Id + "/stats?stream=false&one-shot=true",
            );
            const io = s.blkio_stats?.io_service_bytes_recursive;
            row.metrics = {
              cpu_ns: s.cpu_stats?.cpu_usage?.total_usage ?? null,
              system_ns: s.cpu_stats?.system_cpu_usage ?? null,
              cpus:
                s.cpu_stats?.online_cpus ??
                s.cpu_stats?.cpu_usage?.percpu_usage?.length ??
                null,
              memory_bytes:
                typeof s.memory_stats?.usage === "number"
                  ? Math.max(
                      0,
                      s.memory_stats.usage -
                        (s.memory_stats.stats?.inactive_file ??
                          s.memory_stats.stats?.total_inactive_file ??
                          0),
                    )
                  : null,
              memory_limit: s.memory_stats?.limit ?? null,
              rx_bytes: s.networks
                ? Object.values(s.networks).reduce((n, v) => n + v.rx_bytes, 0)
                : null,
              tx_bytes: s.networks
                ? Object.values(s.networks).reduce((n, v) => n + v.tx_bytes, 0)
                : null,
              read_bytes: io
                ? io
                    .filter((v) => v.op.toLowerCase() === "read")
                    .reduce((n, v) => n + v.value, 0)
                : null,
              write_bytes: io
                ? io
                    .filter((v) => v.op.toLowerCase() === "write")
                    .reduce((n, v) => n + v.value, 0)
                : null,
            };
          } catch {
            row.error = "STATS_UNAVAILABLE";
          }
          return row;
        }),
      )),
    );
  return { at: new Date().toISOString(), containers: result };
}
let flight;
http
  .createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" || req.url !== "/snapshot") {
      res.writeHead(403);
      return res.end("{}");
    }
    try {
      flight ??= snapshot().finally(() => {
        flight = undefined;
      });
      res.end(JSON.stringify(await flight));
    } catch {
      res.writeHead(503);
      res.end('{"error":"DOCKER_UNAVAILABLE"}');
    }
  })
  .listen(Number(process.env.PORT || 9101), "0.0.0.0");
