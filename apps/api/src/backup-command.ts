/** Operator-only entrypoint. DATABASE_URL must identify the explicitly selected
 * source/destination; no production connection is inferred by this command. */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createBackup, inspectBackup, restoreBackup } from "./backup-engine";
import { pool as defaultPool } from "./db";
async function main() {
  const [command, settingsPath] = process.argv.slice(2);
  if (
    !process.env.DATABASE_URL ||
    !settingsPath ||
    !["create", "inspect", "restore"].includes(command)
  )
    throw Error(
      "Usage: DATABASE_URL=… node dist/backup-command.js create|inspect|restore settings.json",
    );
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const database = new Pool({ connectionString: process.env.DATABASE_URL });
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
  });
  process.once("SIGTERM", () => {
    interrupted = true;
  });
  try {
    if (command === "inspect")
      console.log(
        JSON.stringify(
          await inspectBackup(settings.target, settings.id),
          null,
          2,
        ),
      );
    else if (command === "restore") {
      const report = await restoreBackup({
        ...settings,
        database,
        stopped: () => interrupted,
      });
      // Unresolved rows can contain private notes; they remain in the database
      // report and recovery directory, never in the operator log.
      console.log(
        JSON.stringify({
          kind: report.kind,
          restored: report.restored,
          unresolved: report.unresolved.length,
        }),
      );
    } else {
      const key = process.env.AUTH_KEY_FILE
        ? (await readFile(process.env.AUTH_KEY_FILE, "utf8")).trim()
        : process.env.AUTH_KEY;
      const id = settings.id ?? randomUUID();
      console.log(JSON.stringify({ id, state: "capturing" }));
      console.log(
        JSON.stringify(
          await createBackup({
            ...settings,
            id,
            database,
            config: {
              authKey: key,
              origin: process.env.APP_ORIGIN,
              settings: settings.configuration ?? {},
            },
            stopped: () => interrupted,
          }),
        ),
      );
    }
  } finally {
    await database.end();
    await defaultPool.end();
  }
}
main().catch((error) => {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "BACKUP_OPERATION_FAILED",
  );
  process.exitCode = 1;
});
