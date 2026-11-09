// Benchmark-only phase intervals layered on the original P0/P1B.1 profilers.
// No SQL arguments, document contents or credentials are retained.
if (process.env.P0_PROFILE) {
  require("./performance-bibliography-profiler.cjs");
  const fs = require("node:fs");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const context = new AsyncLocalStorage();
  const path = process.env.P0_PROFILE.replace(/\.json$/, "-p2c-events.jsonl");
  const emit = (event) => fs.appendFileSync(path, JSON.stringify(event) + "\n");
  if (process.env.P2C_EVENT_LOOP === "1") {
    const delay = require("node:perf_hooks").monitorEventLoopDelay({
      resolution: 10,
    });
    let htmlMs = 0,
      htmlMax = 0,
      htmlCalls = 0,
      encodingMs = 0,
      encodingMax = 0;
    const bibliography = require("../apps/api/dist/catalog-bibliography");
    const plain = bibliography.plain;
    bibliography.plain = (...args) => {
      const start = performance.now();
      try {
        return plain(...args);
      } finally {
        const ms = performance.now() - start;
        htmlMs += ms;
        htmlMax = Math.max(htmlMax, ms);
        htmlCalls++;
      }
    };
    try {
      const pipeline = require("../apps/api/dist/catalog-text-pipeline");
      const encode = pipeline.textNdjson;
      pipeline.textNdjson = (...args) => {
        const start = performance.now();
        try {
          return encode(...args);
        } finally {
          const ms = performance.now() - start;
          encodingMs += ms;
          encodingMax = Math.max(encodingMax, ms);
        }
      };
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
    const fetchSearch = global.fetch;
    global.fetch = async (...args) => {
      if (!String(args[0]).endsWith("/_search")) return fetchSearch(...args);
      const start = Date.now();
      try {
        return await fetchSearch(...args);
      } finally {
        emit({ kind: "interactive_search_http", start, end: Date.now() });
      }
    };
    delay.enable();
    const timer = setInterval(() => {
      emit({
        kind: "event_loop",
        end: Date.now(),
        samples: delay.count,
        mean_ms: delay.mean / 1e6,
        p95_ms: delay.percentile(95) / 1e6,
        max_ms: delay.max / 1e6,
        html_ms: htmlMs,
        html_max_ms: htmlMax,
        html_calls: htmlCalls,
        encoding_ms: encodingMs,
        encoding_max_ms: encodingMax,
      });
      delay.reset();
      htmlMs = htmlMax = htmlCalls = encodingMs = encodingMax = 0;
    }, 1000);
    timer.unref();
    process.on("exit", () => delay.disable());
  }
  const finish = (s) => {
    const end = Date.now();
    emit({ kind: s.phase, start: s.since, end, rows: s.rows });
    s.since = end;
    s.rows = 0;
  };
  const { Client } = require("pg");
  const query = Client.prototype.query;
  Client.prototype.query = function (...args) {
    const state = context.getStore();
    if (!state) return query.apply(this, args);
    const sql = String(args[0]?.text ?? args[0]);
    const phase = sql.startsWith("SELECT p.work_id FROM catalog_pending")
      ? "current"
      : sql.startsWith(
            "SELECT p.snapshot_id,s.work_id,s.manifest_hash FROM catalog_snapshot_pending",
          )
        ? "historical"
        : null;
    if (phase) {
      finish(state);
      state.phase = phase;
    }
    const result = query.apply(this, args);
    if (phase && result?.then)
      return result.then((r) => {
        state.rows = r.rowCount;
        return r;
      });
    return result;
  };
  const catalog = require("../apps/api/dist/catalog");
  const project = catalog.projectCatalog;
  catalog.projectCatalog = (...args) =>
    context.run(
      { phase: "coordination", since: Date.now(), rows: 0 },
      async () => {
        try {
          return await project(...args);
        } finally {
          finish(context.getStore());
        }
      },
    );
  const search = require("../apps/api/dist/catalog-search");
  let textOwner = search;
  if (Object.getOwnPropertyDescriptor(search, "projectText")?.get)
    textOwner = require("../apps/api/dist/catalog-text-bulk");
  const text = textOwner.projectText;
  textOwner.projectText = async (...args) => {
    const start = Date.now();
    let rows = 0;
    try {
      rows = await text(...args);
      return rows;
    } finally {
      emit({ kind: "text", start, end: Date.now(), rows });
    }
  };
  let flushInputs = () => {};
  if (search.prepareTextDocument) {
    const prepare = search.prepareTextDocument;
    const inputs = { batch: 0, legacy: 0 };
    search.prepareTextDocument = async (db, row, input) => {
      inputs[input === undefined ? "legacy" : "batch"]++;
      return prepare(db, row, input);
    };
    flushInputs = () => {
      if (inputs.batch || inputs.legacy)
        emit({ kind: "preparation_inputs", ...inputs });
      inputs.batch = inputs.legacy = 0;
    };
    process.on("exit", flushInputs);
  }
  const archive = require("../apps/api/dist/archive");
  const ingest = archive.ingestRecords;
  archive.ingestRecords = async (...args) => {
    const start = Date.now();
    try {
      return await ingest(...args);
    } finally {
      emit({
        kind: "canonical_commit",
        start,
        end: Date.now(),
        rows: args[1].length,
      });
    }
  };
  const info = console.info;
  console.info = (message, ...args) => {
    if (
      typeof message === "string" &&
      message.includes('"event":"text_bulk"')
    ) {
      emit({ kind: "bulk_pass", end: Date.now(), ...JSON.parse(message) });
      // SIGTERM need not emit process exit; retain counters after each durable pass.
      flushInputs();
    }
    info(message, ...args);
  };
}
