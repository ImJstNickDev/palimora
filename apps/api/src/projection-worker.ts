import { migrate, pool } from "./db";
import { projectCatalog, projectText } from "./catalog";
import { searchRequest } from "./catalog-search";
import { startProjections } from "./operations-index";
import { projectionMode } from "./projection-mode";

/** A process role, not another job engine. SQL queues and existing leader locks
 * arbitrate replicas and rolling transitions from/to the inline API. */
export async function runProjectionWorker() {
  let stopping = false;
  let signal!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const requestStop = () => {
    stopping = true;
    signal();
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  let stop = async () => {};
  try {
    if (projectionMode() !== "isolated")
      throw Error("Projection worker requires PROJECTION_MODE=isolated");
    // Same migration checksum/leader guard as API, also supporting standalone boot.
    await migrate();
    if (stopping) return;
    const health = await searchRequest(
      "/_cluster/health?wait_for_status=yellow&timeout=5s",
      undefined,
      "GET",
    );
    if (health.timed_out || health.status === "red")
      throw Error("Search is not ready");
    if (stopping) return;
    stop = startProjections(projectCatalog, projectText);
    console.info(
      JSON.stringify({ event: "projection_worker_ready", pid: process.pid }),
    );
    await interrupted;
  } finally {
    // Stop claiming, finish atomic catalog work and settle/cancel buffered text.
    // Forced termination is recovered by the unchanged durable lease protocol.
    try {
      await stop();
    } finally {
      await pool.end();
      process.off("SIGTERM", requestStop);
      process.off("SIGINT", requestStop);
    }
  }
  console.info(JSON.stringify({ event: "projection_worker_stopped" }));
}

if (require.main === module)
  runProjectionWorker().catch(() => {
    console.error(
      JSON.stringify({
        event: "projection_worker_failed",
        message:
          "Check projection mode, database schema and search availability",
      }),
    );
    process.exitCode = 1;
  });
