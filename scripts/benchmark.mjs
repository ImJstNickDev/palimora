// Foundation-only latency probe. Credentials are supplied through environment variables.
import { performance } from "node:perf_hooks";
const base = process.env.BENCH_ORIGIN ?? "http://localhost:5173";
const transport = process.env.BENCH_URL ?? base;
const login = await fetch(transport + "/api/v1/auth/login", {
  method: "POST",
  headers: { origin: base, "content-type": "application/json" },
  body: JSON.stringify({
    username: process.env.BENCH_USERNAME,
    password: process.env.BENCH_PASSWORD,
    code: process.env.BENCH_CODE,
  }),
});
if (!login.ok) throw Error("Benchmark login failed");
const auth = await login.json(),
  cookie = login.headers.get("set-cookie").split(";")[0];
const samples = [];
let failures = 0;
const start = performance.now();
for (let batch = 0; batch < 20; batch++)
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const started = performance.now();
      const response = await fetch(transport + "/api/v1/me", {
        headers: { cookie },
      });
      await response.arrayBuffer();
      if (!response.ok) failures++;
      samples.push(performance.now() - started);
    }),
  );
samples.sort((a, b) => a - b);
const seconds = (performance.now() - start) / 1000;
console.log(
  JSON.stringify({
    endpoint: "/api/v1/me",
    requests: samples.length,
    concurrency: 10,
    failures,
    p50Ms: +samples[99].toFixed(2),
    p95Ms: +samples[189].toFixed(2),
    requestsPerSecond: +(samples.length / seconds).toFixed(2),
  }),
);
await fetch(transport + "/api/v1/auth/logout", {
  method: "POST",
  headers: {
    cookie,
    origin: base,
    "content-type": "application/json",
    "x-csrf-token": auth.csrf,
  },
  body: "{}",
});
