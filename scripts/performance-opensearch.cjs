// Optional low-frequency JVM/index telemetry; only aggregate statistics are saved.
const fs = require("node:fs");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test database required");
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
(async () => {
  while (!stopped && !fs.existsSync("/results/end-to-end.json")) {
    try {
      const r = await fetch(
        "http://opensearch:9200/_nodes/stats/jvm,process,fs,indices,thread_pool",
        { signal: AbortSignal.timeout(4000) },
      );
      if (!r.ok) throw Error("Stats unavailable");
      const nodes = Object.values((await r.json()).nodes).map((n) => ({
        jvm: n.jvm,
        process: n.process,
        fs: n.fs,
        indices: n.indices,
        thread_pool: n.thread_pool,
      }));
      fs.appendFileSync(
        "/results/opensearch-samples.jsonl",
        JSON.stringify({ time: Date.now(), nodes }) + "\n",
      );
    } catch {
      fs.appendFileSync(
        "/results/opensearch-samples.jsonl",
        JSON.stringify({ time: Date.now(), error: true }) + "\n",
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
