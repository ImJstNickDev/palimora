// Same real corpus and base, comparing the previous and current export engine.
const fs = require("node:fs/promises"),
  { dirname } = require("node:path");
const Module = require("node:module"),
  { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks"),
  assert = require("node:assert/strict");
if (
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Release fixture required");
process.env.BACKUP_CONFIG_FILE = "/benchmark/recovery/destinations.json";
process.env.BACKUP_VOLUME_BYTES = "67108864";
const { pool } = require("../apps/api/dist/db");
const { exportCorpus } = require("../apps/api/dist/archive-export");
const { openChain, verify } = require("@palimora/archive-format");
(async () => {
  const ids = JSON.parse(
    await fs.readFile("/results/recovery-plan.json", "utf8"),
  );
  const base = "/benchmark/recovery/" + ids.base + "/archive";
  const filename = require.resolve("../apps/api/dist/archive-export");
  const old = new Module(filename, module);
  old.filename = filename;
  old.paths = Module._nodeModulePaths(dirname(filename));
  old._compile(
    await fs.readFile("/results/archive-export-before-skip.cjs", "utf8"),
    filename,
  );
  const measurements = {};
  for (const [name, engine] of [
    ["before", old.exports.exportCorpus],
    ["after", exportCorpus],
  ]) {
    const id = randomUUID(),
      start = performance.now();
    await engine({
      id,
      destination: "release",
      basePaths: [base],
      stopped: () => false,
      progress: async () => {},
    });
    measurements[name] = {
      seconds: (performance.now() - start) / 1000,
      id,
      paths: [base, "/benchmark/recovery/" + id + "/archive"],
    };
    await fs.writeFile(
      "/results/export-comparison-progress.json",
      JSON.stringify(measurements, null, 2),
    );
    console.log(name, measurements[name].seconds);
  }
  const before = await openChain(measurements.before.paths),
    after = await openChain(measurements.after.paths);
  assert.deepEqual(after.manifest.catalog, before.manifest.catalog);
  const inventory = (chain) =>
    [...chain.objects]
      .map(([hash, { object }]) => [hash, object.kind, object.size])
      .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(inventory(after), inventory(before));
  await verify(after);
  await fs.writeFile(
    "/results/export-optimized.json",
    JSON.stringify(
      {
        before_seconds: measurements.before.seconds,
        seconds: measurements.after.seconds,
        objects: after.objects.size,
        volumes: after.manifest.volumes.map((v) => v.size),
        identical_catalog: true,
        identical_objects: true,
        measurements,
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
