// Optional P1B.1 instrumentation layered on the unchanged P0 profiler.
// No parameters/content retained. Inclusive nested timings must not be added.
if (process.env.P0_PROFILE) {
  require("./performance-profiler.cjs");
  const fs = require("node:fs");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const context = new AsyncLocalStorage();
  const totals = {},
    sql = {},
    departures = {};
  const record = (name, ms, rows = 0) => {
    const r = (totals[name] ??= {
      calls: 0,
      seconds: 0,
      max_seconds: 0,
      rows: 0,
    });
    r.calls++;
    r.seconds += ms / 1000;
    r.max_seconds = Math.max(r.max_seconds, ms / 1000);
    r.rows += rows;
  };
  const { Client } = require("pg");
  const query = Client.prototype.query;
  Client.prototype.query = function (...args) {
    const state = context.getStore();
    if (!state) return query.apply(this, args);
    const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    const start = performance.now();
    let next;
    if (text.startsWith("SELECT p.work_id FROM catalog_pending"))
      next = "current";
    if (
      text.startsWith(
        "SELECT p.snapshot_id,s.work_id,s.manifest_hash FROM catalog_snapshot_pending",
      )
    )
      next = "historical";
    if (next) {
      record(state.phase + "_slice", start - state.since);
      state.phase = next;
      state.since = start;
    }
    const phase = state.phase;
    const done = (r) => {
      const s = (sql[phase] ??= { calls: 0, seconds: 0, commits: 0 });
      s.calls++;
      s.seconds += (performance.now() - start) / 1000;
      if (text === "COMMIT") s.commits++;
      const category = /WITH RECURSIVE closure/.test(text)
        ? "closure"
        : /catalog_tags/.test(text)
          ? "tags"
          : /catalog_entit/.test(text)
            ? "entities"
            : /INSERT INTO catalog_snapshot_views/.test(text)
              ? "views"
              : /INSERT INTO catalog_documents/.test(text)
                ? "documents"
                : "other";
      record(phase + ".sql_" + category, performance.now() - start);
      if (text.includes("pg_advisory_xact_lock(70210408)"))
        record("bibliography_lock", performance.now() - start);
      const table = text.match(
        /^DELETE FROM (catalog_pending|catalog_snapshot_pending|catalog_text_pending)/,
      )?.[1];
      if (table)
        departures[table] = (departures[table] ?? 0) + (r?.rowCount ?? 0);
    };
    if (typeof args.at(-1) === "function") {
      const cb = args.at(-1);
      args[args.length - 1] = (...a) => {
        done(a[1]);
        cb(...a);
      };
      return query.apply(this, args);
    }
    const result = query.apply(this, args);
    return result?.then
      ? result.then(
          (r) => {
            done(r);
            return r;
          },
          (e) => {
            done();
            throw e;
          },
        )
      : result;
  };
  const catalog = require("../apps/api/dist/catalog");
  const original = catalog.projectCatalog;
  catalog.projectCatalog = (...args) => {
    const state = { phase: "coordination", since: performance.now() };
    return context.run(state, async () => {
      try {
        return await original(...args);
      } finally {
        record(state.phase + "_slice", performance.now() - state.since);
      }
    });
  };
  for (const [file, names] of Object.entries({
    "catalog-bibliography": [
      "enrichBibliographyBatch",
      "projectTagBatch",
      "projectEntityBatch",
      "projectFilterBatch",
      "projectHistoricalBibliographies",
    ],
    catalog: [
      "loadCurrentBibliographies",
      "writeCurrentDocuments",
      "materializeHistoricalViews",
    ],
  })) {
    const owner = require("../apps/api/dist/" + file);
    for (const name of names) {
      const fn = owner[name];
      owner[name] = async function (...args) {
        const start = performance.now(),
          phase = context.getStore()?.phase ?? "other";
        try {
          return await fn.apply(this, args);
        } finally {
          record(phase + "." + name, performance.now() - start);
        }
      };
    }
  }
  const save = () =>
    fs.writeFileSync(
      process.env.P0_PROFILE.replace(/\.json$/, "-bibliography.json"),
      JSON.stringify({ totals, sql, departures }),
    );
  setInterval(save, 5000).unref();
  process.on("exit", save);
}
