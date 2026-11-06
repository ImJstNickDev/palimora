// Optional benchmark instrumentation; never loaded by the API or worker runtime.
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const inspector = require("node:inspector");
const fs = require("node:fs");
exports.start = async function ({ archive, pool }) {
  const context = new AsyncLocalStorage(),
    spans = [],
    totals = {},
    groups = [];
  let origin = performance.now(),
    session;
  function add(label, start, finish = performance.now()) {
    const v = (totals[label] ??= { calls: 0, ms: 0 });
    v.calls++;
    v.ms += finish - start;
    spans.push({ label, start: start - origin, end: finish - origin });
  }
  function wrap(owner, name, label, scope = false) {
    const original = owner[name];
    owner[name] = async function (...args) {
      const start = performance.now();
      const run = () => original.apply(this, args);
      try {
        return await (scope ? context.run(true, run) : run());
      } finally {
        if (context.getStore() || scope) add(label, start);
      }
    };
  }
  for (const name of ["ingestRecords", "ingestRecord"]) {
    const original = archive[name];
    archive[name] = async function (...args) {
      const start = performance.now();
      try {
        return await context.run(true, () => original.apply(this, args));
      } finally {
        add("group", start);
        groups.push({
          records: name === "ingestRecords" ? args[1].length : 1,
          ms: performance.now() - start,
        });
      }
    };
  }
  wrap(archive, "objectBytes", "staging");
  wrap(
    require("../apps/api/dist/archive-staging"),
    "prepareStaging",
    "staging.prepare",
  );
  const pack = require("../apps/api/dist/pack");
  const canonical = pack.canonical;
  pack.canonical = function (...args) {
    const start = performance.now();
    try {
      return canonical(...args);
    } finally {
      if (context.getStore()) add("canonical", start);
    }
  };
  if (
    fs.existsSync(
      require("node:path").join(
        __dirname,
        "../apps/api/dist/archive-native.js",
      ),
    )
  ) {
    const preparation = require("../apps/api/dist/archive-native");
    for (const name of ["prepareCopy", "prepareDocuments", "documentHashes"])
      wrap(preparation, name, "native." + name);
    const compile = preparation.compileManifest;
    preparation.compileManifest = function (...args) {
      const start = performance.now();
      try {
        return compile(...args);
      } finally {
        if (context.getStore()) add("native.compileManifest", start);
      }
    };
  }
  const factory = archive.store.writer.bind(archive.store);
  archive.store.writer = () => {
    const writer = factory();
    wrap(writer, "append", "pack.append");
    wrap(writer, "finish", "pack.finish");
    return writer;
  };
  const codec = require("../apps/api/native/build/codec.node"),
    native = codec.batch;
  codec.batch = async function (...args) {
    const start = performance.now();
    try {
      return await native(...args);
    } finally {
      if (context.getStore())
        add(args[2] ? "codec.decode" : "codec.encode", start);
    }
  };
  const promises = require("node:fs/promises"),
    open = promises.open;
  promises.open = async function (path, ...args) {
    const f = await open(path, ...args);
    const type = String(path).endsWith(".pmpack") ? "pack" : "staging";
    for (const name of ["read", "write", "sync", "close"])
      wrap(f, name, "fs." + type + "." + name);
    return f;
  };
  const connect = pool.connect.bind(pool);
  pool.connect = function (callback) {
    const prep = (c) => {
      if (!c.__detailed) {
        c.__detailed = true;
        const query = c.query.bind(c);
        c.query = function (...args) {
          const start = performance.now(),
            active = context.getStore(),
            sql =
              typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "COPY");
          const done = () => {
            if (active)
              add(
                /^COPY/.test(sql)
                  ? "sql.copy"
                  : /^COMMIT/.test(sql)
                    ? "sql.commit"
                    : "sql.other",
                start,
              );
          };
          if (typeof args.at(-1) === "function") {
            const cb = args.at(-1);
            args[args.length - 1] = (...v) => {
              done();
              cb(...v);
            };
            return query(...args);
          }
          const result = query(...args);
          if (result?.finally) return result.finally(done);
          result.once("finish", done);
          return result;
        };
      }
      return c;
    };
    if (callback)
      return connect((e, c, release) => callback(e, e ? c : prep(c), release));
    return connect().then(prep);
  };
  if (process.env.BENCH_CPU_PROFILE) {
    session = new inspector.Session();
    session.connect();
    await new Promise((r, j) =>
      session.post("Profiler.enable", (e) => (e ? j(e) : r())),
    );
    await new Promise((r, j) =>
      session.post("Profiler.start", (e) => (e ? j(e) : r())),
    );
  }
  function union(labels) {
    const intervals = spans
      .filter((s) => labels.includes(s.label))
      .sort((a, b) => a.start - b.start);
    let sum = 0,
      left = 0,
      right = 0;
    for (const s of intervals) {
      if (s.start > right) {
        sum += right - left;
        left = s.start;
        right = s.end;
      } else right = Math.max(right, s.end);
    }
    return sum + right - left;
  }
  return async () => {
    if (session) {
      const result = await new Promise((r, j) =>
        session.post("Profiler.stop", (e, p) => (e ? j(e) : r(p))),
      );
      fs.writeFileSync(
        process.env.BENCH_CPU_PROFILE,
        JSON.stringify(result.profile),
      );
      session.disconnect();
    }
    // Exclusive wall-clock attribution even when groups overlap. SQL takes
    // precedence, then pack, then preparation; summed spans remain separate.
    const category = (label) =>
      label === "group"
        ? "group"
        : label.startsWith("sql.")
          ? "sql"
          : ["pack.append", "pack.finish"].includes(label)
            ? "pack"
            : ["staging", "staging.prepare"].includes(label)
              ? "staging"
              : null;
    const edges = spans
      .flatMap((s) =>
        category(s.label)
          ? [
              { at: s.start, kind: category(s.label), delta: 1 },
              { at: s.end, kind: category(s.label), delta: -1 },
            ]
          : [],
      )
      .sort((a, b) => a.at - b.at);
    const active = { group: 0, sql: 0, pack: 0, staging: 0 };
    const partitions = {
      group_ms: 0,
      sql_ms: 0,
      pack_ms: 0,
      staging_ms: 0,
      core_remaining_ms: 0,
    };
    let previous = 0;
    for (const edge of edges) {
      const duration = edge.at - previous;
      if (active.group) {
        partitions.group_ms += duration;
        const key = active.sql
          ? "sql_ms"
          : active.pack
            ? "pack_ms"
            : active.staging
              ? "staging_ms"
              : "core_remaining_ms";
        partitions[key] += duration;
      }
      active[edge.kind] += edge.delta;
      previous = edge.at;
    }
    return {
      partitions,
      groups,
      totals,
      wall_active_ms: Object.fromEntries(
        Object.keys(totals).map((k) => [k, union([k])]),
      ),
    };
  };
};
