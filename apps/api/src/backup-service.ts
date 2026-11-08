import { pool, migrate } from "./db";
import { runBackups } from "./backup-worker";
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
migrate()
  .then(() => {
    console.log("backup_worker_ready");
    return runBackups(() => stopped);
  })
  .catch(() => {
    console.error("BACKUP_WORKER_FAILED");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
