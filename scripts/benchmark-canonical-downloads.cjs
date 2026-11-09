// Real TXT downloads on the isolated P5 corpus, after pipeline measurement.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
if (
  new URL(process.env.DATABASE_URL).pathname !== "/palimora_release_test" ||
  process.env.ARCHIVE_ROOT !== "/benchmark/main"
)
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
const { downloadWork } = require("../apps/api/dist/reader-download");
(async () => {
  const row = (
    await pool.query(
      "SELECT DISTINCT r.work_id,r.snapshot_id,w.external_id FROM archive_records r JOIN archive_works w ON w.id=r.work_id WHERE r.source_path='txt.zip' ORDER BY w.external_id LIMIT 1",
    )
  ).rows[0];
  assert.ok(row);
  const results = [];
  for (const format of ["html", "epub", "pdf"]) {
    const start = performance.now(),
      cpu = process.cpuUsage();
    const result = await downloadWork(pool, {
      id: row.work_id,
      snapshot: row.snapshot_id,
      format,
    });
    let bytes = 0;
    for await (const chunk of result.stream) bytes += Buffer.byteLength(chunk);
    const used = process.cpuUsage(cpu);
    results.push({
      format,
      bytes,
      ms: performance.now() - start,
      node_cpu_ms: (used.user + used.system) / 1000,
      peak_node_rss_kib: process.resourceUsage().maxRSS,
    });
  }
  fs.writeFileSync(
    "/results/canonical-downloads.json",
    JSON.stringify(
      {
        samples: 1,
        selection: "first external identity among TXT fixture records",
        cpu_excludes_subprocesses: true,
        results,
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
