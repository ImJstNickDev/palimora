// Private benchmark only: exact last successful canonical commit, inclusive spans.
const fs = require("node:fs");
if (
  !process.env.ARCHIVE_ROOT?.startsWith("/benchmark/") ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw Error("Private fixture required");
const spans = {},
  archive = require("../apps/api/dist/archive");
let active = 0,
  peak = 0,
  lastCommit = null;
for (const name of [
  "ingestRecords",
  "ingestRecord",
  "archiveTransaction",
  "preserve",
  "objectBytes",
]) {
  const original = archive[name];
  archive[name] = async function (...args) {
    const start = performance.now();
    if (["ingestRecords", "ingestRecord", "archiveTransaction"].includes(name))
      peak = Math.max(peak, ++active);
    try {
      const result = await original.apply(this, args);
      if (
        ["ingestRecords", "ingestRecord", "archiveTransaction"].includes(name)
      )
        lastCommit = Date.now();
      return result;
    } finally {
      const value = (spans[name] ??= { calls: 0, ms: 0 });
      value.calls++;
      value.ms += performance.now() - start;
      if (
        ["ingestRecords", "ingestRecord", "archiveTransaction"].includes(name)
      )
        active--;
    }
  };
}
const save = () =>
  fs.writeFileSync(
    "/results/p3-ingest-spans.json",
    JSON.stringify({ last_commit_ms: lastCommit, peak, spans }),
  );
setInterval(save, 1000).unref();
process.on("exit", save);
function wrap(owner, name, label) {
  const fn = owner[name];
  owner[name] = async function (...args) {
    const start = performance.now();
    try {
      return await fn.apply(this, args);
    } finally {
      const v = (spans[label] ??= { calls: 0, ms: 0 });
      v.calls++;
      v.ms += performance.now() - start;
    }
  };
}
wrap(
  require("../apps/api/dist/archive-staging"),
  "prepareStaging",
  "staging.prepare",
);
wrap(
  require("../apps/api/dist/ingest-progress"),
  "commitProgress",
  "checkpoint",
);
const writer = archive.store.writer.bind(archive.store);
archive.store.writer = () => {
  const w = writer();
  wrap(w, "append", "pack.append");
  wrap(w, "finish", "pack.finish");
  return w;
};
const { Client } = require("pg"),
  query = Client.prototype.query;
Client.prototype.query = function (...args) {
  const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "COPY");
  const label = /^COPY/.test(sql)
    ? "sql.copy"
    : /^COMMIT/.test(sql)
      ? "sql.commit"
      : "sql.other";
  const start = performance.now(),
    done = () => {
      const v = (spans[label] ??= { calls: 0, ms: 0 });
      v.calls++;
      v.ms += performance.now() - start;
    };
  if (typeof args.at(-1) === "function") {
    const cb = args.at(-1);
    args[args.length - 1] = (...a) => {
      done();
      cb(...a);
    };
    return query.apply(this, args);
  }
  const result = query.apply(this, args);
  if (result?.finally) return result.finally(done);
  result.once("finish", done);
  return result;
};
