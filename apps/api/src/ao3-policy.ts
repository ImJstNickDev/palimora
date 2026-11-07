/** The same gate governs dispatch, execution, HTTP requests and admin presentation. */
export function syncGate(
  c: {
    paused: boolean;
    mode: string;
    observed_state: string;
    cooldown_until: Date | string | null;
  },
  now = Date.now(),
): string | null {
  if (c.paused) return "paused";
  if (c.mode === "force_offline") return "manual_offline";
  if (["maintenance", "blocked", "rate_limited"].includes(c.observed_state))
    return c.observed_state;
  if (c.cooldown_until && new Date(c.cooldown_until).getTime() > now)
    return "cooldown";
  if (c.mode === "force_online" || c.observed_state === "online") return null;
  return c.observed_state === "unreachable" ? "unreachable" : "unknown";
}
export function jobExecution(job: any, c: any, now = Date.now()) {
  const local = job.kind === "media" && !!job.checkpoint?.upload;
  const gate = local ? (c.paused ? "paused" : null) : syncGate(c, now);
  if (job.availability === "deleted")
    return { execution: "deleted", eligible_at: null };
  if (job.state === "blocked")
    return { execution: "paused", eligible_at: null };
  if (job.state === "running")
    return { execution: gate ? "stopping" : "running", eligible_at: null };
  if (gate)
    return {
      execution: gate === "paused" ? "paused" : "waiting_service",
      eligible_at: null,
    };
  const due = Math.max(
    new Date(job.due_at).getTime(),
    job.kind === "work" && job.started_at
      ? new Date(job.started_at).getTime() + 3600000
      : 0,
  );
  return {
    execution: due > now ? "scheduled" : "ready",
    eligible_at: new Date(due).toISOString(),
  };
}
