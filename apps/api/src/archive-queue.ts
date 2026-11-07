import { runSyncQueue } from "./ao3-scheduler";
import { executeSync } from "./ao3-worker";
import { monitorAO3 } from "./ao3-monitor";
import { maintenanceTick } from "./archive-maintenance";
import { devArchiveEnabled, resetDevArchive } from "./archive-dev-reset";

import { pool, transaction } from "./db";
import { preserve } from "./archive";
import { canonical, sha } from "./pack";
export async function deliverArchiveEvent(id: string) {
  return deliverArchiveEvents([id]);
}
export async function deliverArchiveEvents(ids: string[]) {
  if (!ids.length) return;
  await transaction(async (db) => {
    const events = (
      await db.query(
        "SELECT id,event,payload,created_at FROM archive_outbox WHERE id=ANY($1::bigint[]) ORDER BY id",
        [ids],
      )
    ).rows;
    if (events.length !== new Set(ids.map(String)).size)
      throw Error("OUTBOX_EVENT_MISSING");
    if (events.some((e) => e.event === "archive.admin.resolved")) {
      await db.query("SELECT pg_advisory_xact_lock(70210402)");
      const done = new Set(
        (
          await db.query(
            "SELECT event_id FROM archive_dispatch WHERE event_id=ANY($1::bigint[])",
            [ids],
          )
        ).rows.map((r) => String(r.event_id)),
      );
      for (const event of events) {
        if (
          event.event !== "archive.admin.resolved" ||
          done.has(String(event.id))
        )
          continue;
        const decision = canonical({
          schema: "palimora-admin-decision-v1",
          ...event,
          created_at: event.created_at.toISOString(),
        });
        await preserve(db, [{ kind: "admin_decision", bytes: decision }]);
        if (
          event.payload.kind === "metadata" &&
          event.payload.after?.metadata
        ) {
          const bytes = canonical({
            schema: "palimora-metadata-v1",
            metadata: event.payload.after.metadata,
          });
          await preserve(db, [{ kind: "metadata", bytes }]);
          await db.query(
            "INSERT INTO archive_metadata_data(hash) VALUES(decode($1,'hex')) ON CONFLICT DO NOTHING",
            [sha(bytes)],
          );
        }
      }
    }
    await db.query(
      "INSERT INTO archive_dispatch(event_id) SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING",
      [ids],
    );
  });
}
export async function runQueue(
  execute: (id: string) => Promise<void>,
  stopped: () => boolean,
) {
  const { Queue, Worker }: typeof import("bullmq") = require("bullmq");
  const connection = {
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  };
  const producer = {
    ...connection,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  };
  const queue = new Queue("palimora-ingest-v1", { connection: producer });
  const eventQueue = new Queue("palimora-archive-events-v1", {
    connection: producer,
  });
  const eventWorker = new Worker(
    "palimora-archive-events-v1",
    async (job) => {
      await deliverArchiveEvents(job.data.ids ?? [job.data.id]);
    },
    { connection, concurrency: 1 },
  );
  eventQueue.on("error", () => {});
  eventWorker.on("error", () => {});
  eventWorker.on("failed", () =>
    console.error(JSON.stringify({ event: "archive_event_retry" })),
  );
  const worker = new Worker(
    "palimora-ingest-v1",
    async (job) => {
      await execute(job.data.id);
    },
    { connection, concurrency: 1 },
  );
  worker.on("error", () =>
    console.error(JSON.stringify({ event: "ingest_queue_unavailable" })),
  );
  queue.on("error", () => {});
  const syncLoop = runSyncQueue((id) => executeSync(id, stopped), stopped);
  let probing: Promise<void> | undefined;
  try {
    while (!stopped()) {
      if (!probing)
        probing = monitorAO3(stopped)
          .catch(() =>
            console.error(JSON.stringify({ event: "ao3_monitor_retry" })),
          )
          .finally(() => {
            probing = undefined;
          });
      try {
        if (
          devArchiveEnabled() &&
          (
            await pool.query(
              "SELECT 1 FROM archive_jobs WHERE kind='reset_dev' AND state IN ('pending','running') LIMIT 1",
            )
          ).rowCount
        ) {
          await worker.pause();
          await eventWorker.pause();
          try {
            await resetDevArchive(async () => {
              await queue.obliterate({ force: true });
              await eventQueue.obliterate({ force: true });
            });
          } finally {
            worker.resume();
            eventWorker.resume();
          }
        }
        await maintenanceTick(stopped);
        const batches = (
          await pool.query(
            "SELECT id,generation FROM ingest_batches WHERE source_kind='dump' AND state IN ('pending','scanning','running')",
          )
        ).rows;
        for (const b of batches) {
          const jobId = b.id + "-" + b.generation;
          const job = await queue.getJob(jobId);
          if (job && ["completed", "failed"].includes(await job.getState()))
            await job.remove();
          await queue.add(
            "ingest",
            { id: b.id },
            {
              jobId,
              attempts: 5,
              backoff: { type: "exponential", delay: 2000 },
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
        }
        // Outbox delivery is a durable replayable administrative event feed. Future domain consumers use the same IDs.
        const events = (
          await pool.query(
            "SELECT id FROM archive_outbox WHERE NOT EXISTS(SELECT 1 FROM archive_dispatch WHERE event_id=archive_outbox.id) ORDER BY id LIMIT 4096",
          )
        ).rows;
        // Inspect the bounded failed set once, then enqueue idempotent jobs in
        // one Redis command. Ordinary acknowledgements do not lock pack writers.
        if (events.length) {
          const failed = new Map(
            (await eventQueue.getFailed(0, 99)).map((job) => [job.id, job]),
          );
          const jobs = [];
          for (let offset = 0; offset < events.length; offset += 512) {
            const ids = events
              .slice(offset, offset + 512)
              .map((e) => String(e.id));
            const jobId = "events-" + sha(ids.join(",")),
              previous = failed.get(jobId);
            if (previous) {
              if (Date.now() - (previous.finishedOn ?? Date.now()) < 60000)
                continue;
              await previous.remove();
            }
            jobs.push({
              name: "archive-event",
              data: { ids },
              opts: {
                jobId,
                attempts: 5,
                backoff: { type: "exponential", delay: 1000 },
                removeOnComplete: true,
                removeOnFail: 100,
              },
            });
          }
          if (jobs.length) await eventQueue.addBulk(jobs);
        }
      } catch {
        console.error(JSON.stringify({ event: "ingest_dispatch_retry" }));
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await probing;
    await syncLoop;
    await worker.close();
    await eventWorker.close();
    await queue.close();
    await eventQueue.close();
  }
}
