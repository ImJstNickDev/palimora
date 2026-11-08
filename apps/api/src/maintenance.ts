import { pool } from "./db";
export type MaintenanceMode =
  | "normal"
  | "maintenance_light"
  | "maintenance_full";
let cached: MaintenanceMode = "normal",
  until = 0;
/** Scheduling only. Authorization reads the persisted mode in its own transaction. */
export async function processingPolicy() {
  if (Date.now() > until) {
    const row = (await pool.query("SELECT maintenance_mode FROM instance"))
      .rows[0];
    cached = row.maintenance_mode;
    until = Date.now() + 1000;
  }
  const accelerated = cached !== "normal";
  return {
    mode: cached,
    accelerated,
    dispatchMs: accelerated ? 100 : 1000,
    projectionPasses: accelerated ? 4 : 1,
    priority: accelerated ? 1 : 10,
  };
}
