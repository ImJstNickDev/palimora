// Benchmark-only preload. Aggregates contain no SQL parameters or document text.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");
const output = process.env.P0_PROFILE;
if (output) {
  if (
    !output.startsWith("/results/") ||
    !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
  )
    throw Error("Private benchmark output required");
  const totals = {},
    keys = new Map();
  const context = new (require("node:async_hooks").AsyncLocalStorage)();
  function record(key, start, bytes = 0) {
    const v = (totals[key] ??= {
      calls: 0,
      ms: 0,
      max_ms: 0,
      bytes: 0,
      histogram_ms_log2: {},
      histogram_bytes_log2: {},
    });
    const ms = performance.now() - start;
    const bucket = Math.ceil(Math.log2(Math.max(ms, 1 / 1024)));
    v.histogram_ms_log2[bucket] = (v.histogram_ms_log2[bucket] ?? 0) + 1;
    if (bytes) {
      const b = Math.ceil(Math.log2(bytes));
      v.histogram_bytes_log2[b] = (v.histogram_bytes_log2[b] ?? 0) + 1;
    }
    v.max_bytes = Math.max(v.max_bytes ?? 0, bytes);
    v.calls++;
    v.ms += ms;
    v.max_ms = Math.max(v.max_ms, ms);
    v.bytes += bytes;
  }
  const { Client } = require("pg");
  const query = Client.prototype.query;
  Client.prototype.query = function (...args) {
    const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    let fingerprint = keys.get(sql);
    if (!fingerprint) {
      fingerprint = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      if (keys.size < 1000) keys.set(sql, fingerprint);
    }
    const key = (context.getStore() ?? "other") + ".sql." + fingerprint;
    const start = performance.now();
    const cb = args.at(-1);
    if (typeof cb === "function") {
      args[args.length - 1] = (...a) => {
        record(key, start);
        cb(...a);
      };
      return query.apply(this, args);
    }
    const result = query.apply(this, args);
    if (result?.finally) return result.finally(() => record(key, start));
    return result;
  };
  const fetch = global.fetch;
  global.fetch = async function (...args) {
    const start = performance.now();
    const url = String(args[0]);
    const kind = url.includes("/_doc/")
      ? "document"
      : url.endsWith("/_bulk")
        ? "bulk"
        : "other";
    try {
      return await fetch(...args);
    } finally {
      const body = args[1]?.body;
      record(
        "http." + kind,
        start,
        typeof body === "string" || Buffer.isBuffer(body)
          ? Buffer.byteLength(body)
          : 0,
      );
    }
  };
  function wrap(owner, name) {
    // P2 re-exports this entrypoint through a read-only getter. Instrument the
    // authoritative implementation, preserving the original SQL context.
    if (
      name === "projectText" &&
      Object.getOwnPropertyDescriptor(owner, name)?.get
    )
      owner = require("../apps/api/dist/catalog-text-bulk");
    const fn = owner[name];
    owner[name] = function (...args) {
      const start = performance.now();
      const r = ["projectCatalog", "projectText"].includes(name)
        ? context.run(name, () => fn.apply(this, args))
        : fn.apply(this, args);
      if (r?.then)
        return r.then(
          (value) => {
            record(name, start, Buffer.isBuffer(value) ? value.length : 0);
            return value;
          },
          (error) => {
            record(name + ".error", start);
            throw error;
          },
        );
      record(name, start);
      return r;
    };
  }
  // Load only after pg/fetch hooks; CommonJS exported calls remain interceptable.
  for (const [file, names] of Object.entries({
    "catalog-bibliography": ["projectBibliography", "projectGraph", "plain"],
    catalog: ["projectCatalog", "loadSnapshot", "chapterBytes"],
    "catalog-search": ["projectText"],
    archive: ["readObject"],
  })) {
    const owner = require("../apps/api/dist/" + file);
    for (const name of names) wrap(owner, name);
  }
  const start = performance.now(),
    cpu = process.cpuUsage();
  const save = () =>
    fs.writeFileSync(
      output,
      JSON.stringify({
        seconds: (performance.now() - start) / 1000,
        cpu: process.cpuUsage(cpu),
        memory: process.memoryUsage(),
        totals,
      }),
    );
  setInterval(save, 5000).unref();
  process.on("exit", save);
}
