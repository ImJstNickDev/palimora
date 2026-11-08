// Each flow exercises first setup against its own database and PackStore.
const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const base = new URL(process.env.TEST_DATABASE_URL);
if (!base.pathname.includes("test"))
  throw Error("Disposable test database required");
(async () => {
  const pool = new Pool({ connectionString: base.toString() });
  try {
    const dedicated = new Set([
      "offline.spec.ts",
      "backups.spec.ts",
      "operations.spec.ts",
      "maintenance.spec.ts",
    ]);
    const specs = (await readdir("tests/browser"))
      .filter((s) => s.endsWith(".spec.ts") && !dedicated.has(s))
      .sort();
    const requested = process.argv.slice(2);
    if (requested.some((spec) => !specs.includes(spec)))
      throw Error("Unknown generic browser flow");
    for (const spec of requested.length ? requested : specs) {
      const name = "palimora_browser_test_" + randomUUID().replaceAll("-", "");
      const root = await mkdtemp(
        join(process.env.PALIMORA_TEST_ROOT || tmpdir(), "palimora-browser-"),
      );
      const url = new URL(base);
      url.pathname = "/" + name;
      await pool.query("CREATE DATABASE " + name);
      try {
        const code = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["node_modules/@playwright/test/cli.js", "test", spec],
            {
              stdio: "inherit",
              env: {
                ...process.env,
                TEST_DATABASE_URL: url.toString(),
                ARCHIVE_ROOT: root,
              },
            },
          );
          child.on("error", reject);
          child.on("exit", resolve);
        });
        if (code !== 0) throw Error(spec + " failed");
      } finally {
        await pool.query("DROP DATABASE " + name + " WITH (FORCE)");
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
