// Benchmark-only query ablation and durable bulk pacing. Never loaded by production.
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Test fixture only");
const fs = require("node:fs");
const fetch = global.fetch;
let next = performance.now();
global.fetch = async (...args) => {
  const url = String(args[0]);
  if (
    process.env.P2E_VARIANT === "no-aggs" &&
    url === "http://opensearch:9200/_search"
  ) {
    const body = JSON.parse(args[1].body);
    delete body.aggs;
    args[1] = { ...args[1], body: JSON.stringify(body) };
  }
  if (
    process.env.P2E_PACE === "1" &&
    url === "http://opensearch:9200/_bulk" &&
    !fs.existsSync("/results/unpace")
  ) {
    const docs = String(args[1].body).trimEnd().split("\n").length / 2;
    next = Math.max(next, performance.now());
    next += (docs / 20) * 1000;
    await new Promise((r) =>
      setTimeout(r, Math.max(0, next - performance.now())),
    );
  }
  return fetch(...args);
};
