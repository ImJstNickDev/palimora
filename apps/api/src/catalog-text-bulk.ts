import {
  TextCapacity,
  TextNeedsExclusive,
  TextPipelineStopped,
  TextPipelineOptions,
  textPipelineSettings,
  textNdjson,
} from "./catalog-text-pipeline";
import { randomUUID } from "node:crypto";
import { pool, transaction, DB } from "./db";
import { selectTextGroup } from "./catalog-text-preparation";
import {
  ensureSearchIndex,
  prepareTextDocument,
  SEARCH_WRITE_ALIAS,
  searchRequest,
} from "./catalog-search";

type Claim = {
  work_id: string;
  revision: string;
  claim: string;
  attempts: number;
};
type Prepared = { claim: Claim; body: Buffer };
const targetBytes = 8 * 1024 * 1024;

/** Claims survive process death. Only the matching revision AND owner may ACK. */
export async function claimText(limit: number): Promise<Claim[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw Error("Invalid text batch");
  return transaction(
    async (db) =>
      (
        await db.query(
          `
    WITH ready AS (
      SELECT p.work_id,d.generation FROM catalog_text_pending p JOIN catalog_documents d USING(work_id)
      WHERE retry_at<=now() AND (claim IS NULL OR lease_until<=now())
      ORDER BY p.work_id LIMIT $1 FOR UPDATE OF p SKIP LOCKED
    ) UPDATE catalog_text_pending p SET claim=$2,requested_generation=ready.generation,lease_until=now()+interval '5 minutes',attempts=attempts+1
      FROM ready WHERE p.work_id=ready.work_id RETURNING p.*`,
          [limit, randomUUID()],
        )
      ).rows,
  );
}
export async function acknowledgeText(claims: Claim[]) {
  if (!claims.length) return 0;
  return (
    (
      await pool.query(
        `DELETE FROM catalog_text_pending p USING
    jsonb_to_recordset($1::jsonb) AS c(work_id uuid,revision bigint,claim uuid)
    WHERE p.work_id=c.work_id AND p.revision=c.revision AND p.claim=c.claim AND p.lease_until>clock_timestamp()`,
        [JSON.stringify(claims)],
      )
    ).rowCount ?? 0
  );
}
async function release(claim: Claim, error: string | null, permanent = false) {
  const delay = !error
    ? 0
    : permanent
      ? 3600
      : Math.min(300, 2 ** Math.min(claim.attempts, 8)) + Math.random();
  await pool.query(
    `UPDATE catalog_text_pending SET claim=NULL,lease_until=NULL,error=$4,
    retry_at=now()+$5*interval '1 second' WHERE work_id=$1 AND revision=$2 AND claim=$3`,
    [claim.work_id, claim.revision, claim.claim, error, delay],
  );
}

/** Renew only still-live ownership. An expired token is never resurrected. */
export async function renewTextClaims(claims: Claim[]) {
  if (!claims.length) return [];
  return (
    await pool.query(
      `WITH input AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) c(work_id uuid,revision bigint,claim uuid)
  ), renewed AS (
    UPDATE catalog_text_pending p SET lease_until=clock_timestamp()+interval '5 minutes'
    FROM input c,catalog_documents d
    WHERE p.work_id=c.work_id AND p.revision=c.revision AND p.claim=c.claim
      AND p.lease_until>clock_timestamp() AND d.work_id=p.work_id AND d.generation=p.requested_generation
    RETURNING p.work_id,p.revision,p.claim
  ) SELECT c.work_id,c.revision,c.claim,r.work_id IS NOT NULL AS valid,
    (SELECT paused FROM operations_index WHERE kind='search') AS paused,
    COALESCE(p.revision=c.revision AND p.claim=c.claim AND p.lease_until<=clock_timestamp(),false) AS expired
    FROM input c LEFT JOIN renewed r ON (r.work_id,r.revision,r.claim)=(c.work_id,c.revision,c.claim)
    LEFT JOIN catalog_text_pending p ON p.work_id=c.work_id`,
      [JSON.stringify(claims)],
    )
  ).rows;
}

async function publishText(
  current: Prepared[],
  stats: any,
  capacity: TextCapacity,
) {
  const body = current.map((p) => p.body.toString()).join("");
  stats.requests++;
  stats.bytes += Buffer.byteLength(body);
  const httpStart = performance.now();
  capacity.phase("http", 1);
  let items: any[];
  try {
    const response = await fetch(
      (process.env.OPENSEARCH_URL ?? "http://opensearch:9200") + "/_bulk",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body,
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) {
      // Whole-request failures leave every item pending; no response body/content in logs.
      const status = response.status;
      await response.body?.cancel();
      for (const p of current)
        await release(p.claim, `HTTP_${status}`, status === 413);
      stats.failures += current.length;
      capacity.halt();
      return;
    }
    const result = await response.json();
    if (!Array.isArray(result.items) || result.items.length !== current.length)
      throw Error("Uncertain bulk response");
    items = result.items;
  } catch {
    for (const p of current) await release(p.claim, "BULK_RESULT_UNCERTAIN");
    stats.failures += current.length;
    capacity.halt();
    return;
  } finally {
    stats.http_ms += performance.now() - httpStart;
    capacity.phase("http", -1);
  }
  const complete: Claim[] = [];
  const conflicts: Claim[] = [];
  for (let i = 0; i < current.length; i++) {
    const item = items[i]?.index,
      claim = current[i].claim;
    // Strict external versioning: conflict means this revision or a newer one
    // was already accepted. Equal revisions can never replace existing bytes.
    if (
      item?._id === claim.work_id &&
      ((item.status >= 200 && item.status < 300) ||
        (item.status === 409 &&
          item.error?.type === "version_conflict_engine_exception"))
    ) {
      if (item.status === 409) conflicts.push(claim);
      else complete.push(claim);
    } else {
      const status = Number(item?.status) || 0;
      await release(
        claim,
        `BULK_ITEM_${status}`,
        status >= 400 && status < 500 && ![408, 409, 429].includes(status),
      );
      stats.failures++;
      capacity.stopClaims = true;
      if ([408, 429, 503].includes(status) || !status) capacity.halt();
    }
  }
  if (conflicts.length) {
    const flushStart = performance.now();
    stats.conflict_flushes++;
    capacity.phase("http", 1);
    try {
      // A conflict proves application, not receipt of the original durable
      // acknowledgement. Persist the observed writes before acknowledging a
      // retry whose original response was lost. Normal successful bulks do
      // not need this additional barrier.
      const result = await searchRequest(
        "/" + SEARCH_WRITE_ALIAS + "/_flush?wait_if_ongoing=true",
      );
      if (
        !(result._shards?.total > 0) ||
        result._shards.failed !== 0 ||
        result._shards.successful !== result._shards.total
      )
        throw Error("Uncertain flush");
      complete.push(...conflicts);
    } catch {
      for (const claim of conflicts)
        await release(claim, "BULK_DURABILITY_UNCERTAIN");
      stats.failures += conflicts.length;
    } finally {
      stats.http_ms += performance.now() - flushStart;
      capacity.phase("http", -1);
    }
  }
  const ackStart = performance.now();
  const acknowledged = await acknowledgeText(complete);
  stats.acknowledged += acknowledged;
  stats.ack_ms += performance.now() - ackStart;
}

export async function projectText(
  limit = 16,
  stopped = () => false,
  overrides: Partial<TextPipelineOptions> = {},
) {
  const options = textPipelineSettings(overrides);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256 ||
    options.documents < limit
  )
    throw Error("Invalid text batch/document capacity");
  await ensureSearchIndex();
  if (stopped()) return 0;
  const capacity = new TextCapacity(options, stopped);
  const stats = {
    event: "text_bulk",
    claimed: 0,
    acknowledged: 0,
    requests: 0,
    bytes: 0,
    http_ms: 0,
    prepare_ms: 0,
    claim_ms: 0,
    ack_ms: 0,
    failures: 0,
    conflict_flushes: 0,
    lease_renewals: 0,
    lease_expired: 0,
    lease_rejected: 0,
    renewal_queries: 0,
    cancelled: 0,
  };
  type Group = { remaining: number; started: number };
  const key = (c: Claim) => c.work_id + ":" + c.revision + ":" + c.claim;
  const active = new Map<string, { claim: Claim; group: Group }>();
  const queue: { items: Prepared[]; bytes: number; ready: number }[] = [];
  let issued = 0,
    exhausted = false,
    fatal: unknown,
    monitoring = true;
  let wakeMonitor: (() => void) | undefined;
  const fail = (e: unknown) => {
    if (!(e instanceof TextPipelineStopped)) fatal ??= e;
    capacity.halt();
  };
  const finish = (claim: Claim) => {
    const value = active.get(key(claim));
    if (!value) return;
    active.delete(key(claim));
    capacity.releaseDocuments(1);
    if (--value.group.remaining === 0) {
      const elapsed = performance.now() - value.group.started;
      capacity.stats.groups++;
      capacity.stats.group_total_ms += elapsed;
      capacity.stats.group_max_ms = Math.max(
        capacity.stats.group_max_ms,
        elapsed,
      );
    }
  };
  const renew = async (claims: Claim[], publishing = false) => {
    const rows = await renewTextClaims(claims);
    if (publishing && rows.some((r) => r.paused)) {
      capacity.halt();
      capacity.check();
    }
    stats.renewal_queries++;
    stats.lease_renewals += rows.filter((r) => r.valid).length;
    stats.lease_expired += rows.filter((r) => r.expired).length;
    return new Set<string>(rows.filter((r) => r.valid).map((r) => key(r)));
  };
  const allowed = async () =>
    !(
      await pool.query(
        "SELECT paused FROM operations_index WHERE kind='search'",
      )
    ).rows[0].paused;
  const monitor = (async () => {
    let nextRenew = performance.now() + options.renewMs;
    while (monitoring) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1000, options.renewMs));
        wakeMonitor = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (!monitoring) break;
      try {
        capacity.check();
        if (!(await allowed())) {
          capacity.halt();
          break;
        }
        if (performance.now() >= nextRenew && active.size) {
          await renew([...active.values()].map((v) => v.claim));
          nextRenew = performance.now() + options.renewMs;
        }
      } catch (e) {
        fail(e);
        break;
      }
    }
  })();
  async function producer() {
    let batch: Prepared[] = [],
      bytes = 0;
    const enqueue = () => {
      if (!batch.length) return;
      queue.push({ items: batch, bytes, ready: performance.now() });
      batch = [];
      bytes = 0;
      capacity.wake();
    };
    try {
      while (!exhausted && !capacity.stopClaims && issued < options.groups) {
        capacity.check();
        const ticket = issued++;
        if (ticket >= options.groups) break;
        await capacity.reserveDocuments(limit);
        let claims: Claim[];
        const started = performance.now();
        try {
          if (!(await allowed()) || capacity.stopClaims || exhausted) {
            capacity.releaseDocuments(limit);
            break;
          }
          capacity.check();
          claims = await claimText(limit);
        } catch (e) {
          capacity.releaseDocuments(limit);
          throw e;
        }
        stats.claim_ms += performance.now() - started;
        capacity.releaseDocuments(limit - claims.length);
        if (!claims.length) {
          exhausted = true;
          break;
        }
        stats.claimed += claims.length;
        const group = { remaining: claims.length, started };
        for (const claim of claims) active.set(key(claim), { claim, group });
        let preparationLimit = claims.length,
          exclusive = false;
        for (let offset = 0; offset < claims.length; ) {
          capacity.check();
          const permit = await capacity.prepare(exclusive);
          let consumed = 0;
          let prepared: { claim: Claim; document?: any; error?: unknown }[] =
            [];
          try {
            const prepareStart = performance.now();
            capacity.phase("prepare", 1);
            let preparationClient: DB | undefined;
            const disconnected = (error: Error) => fail(error);
            try {
              prepared = await transaction(async (db) => {
                preparationClient = db;
                // Pack reads can leave a checked-out connection idle between SQL
                // statements. Observe disconnects until COMMIT/ROLLBACK releases it.
                db.on("error", disconnected);
                await db.query(
                  "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
                );
                const selected = await selectTextGroup(
                  db,
                  claims.slice(offset, offset + preparationLimit),
                  permit.admit,
                );
                consumed = selected.consumed;
                const rows = new Map(selected.rows.map((r) => [r.work_id, r]));
                const result: typeof prepared = [];
                for (const claim of claims.slice(offset, offset + consumed)) {
                  const row = rows.get(claim.work_id);
                  if (!row || stopped()) {
                    result.push({ claim });
                    continue;
                  }
                  try {
                    result.push({
                      claim,
                      document: await prepareTextDocument(
                        db,
                        row,
                        selected.inputs.get(claim.work_id),
                      ),
                    });
                  } catch (error) {
                    result.push({ claim, error });
                  }
                }
                return result;
              });
            } catch (error) {
              const code = (error as { code?: string })?.code ?? "";
              if (
                /^(08|53|58|57|40)/.test(code) ||
                /ECONN|ETIMEDOUT|EPIPE/.test(code) ||
                /connection|connect.*timeout/i.test(
                  (error as Error)?.message ?? "",
                )
              )
                throw error;
              if (error instanceof TextNeedsExclusive) {
                exclusive = true;
                continue;
              }
              if (preparationLimit > 1) {
                preparationLimit = Math.max(
                  1,
                  Math.floor(preparationLimit / 2),
                );
                continue;
              }
              consumed ||= 1;
              prepared = claims
                .slice(offset, offset + consumed)
                .map((claim) => ({ claim, error }));
            } finally {
              preparationClient?.off("error", disconnected);
              stats.prepare_ms += performance.now() - prepareStart;
              capacity.phase("prepare", -1);
            }
            offset += consumed;
            preparationLimit = claims.length - offset;
            for (const entry of prepared) {
              const { claim, document, error } = entry;
              capacity.check();
              if (error || !document) {
                const oversized =
                  error instanceof Error &&
                  error.message === "DOCUMENT_EXCEEDS_64_MIB";
                await release(
                  claim,
                  error
                    ? oversized
                      ? "DOCUMENT_EXCEEDS_64_MIB"
                      : "DOCUMENT_PREPARATION_FAILED"
                    : null,
                  oversized,
                );
                if (error) {
                  stats.failures++;
                  capacity.stopClaims = true;
                }
                finish(claim);
                continue;
              }
              if (!capacity.encodingReady()) enqueue();
              const encoding = await capacity.reserveEncoding();
              try {
                const header = `{"index":{"_index":"${SEARCH_WRITE_ALIAS}","_id":"${claim.work_id}","version":${claim.revision},"version_type":"external","require_alias":true}}\n`;
                const body = textNdjson(header, document);
                entry.document = undefined;
                encoding.retain(body.length);
                if (bytes + body.length > targetBytes) enqueue();
                batch.push({ claim, body });
                bytes += body.length;
                if (bytes >= targetBytes) enqueue();
              } catch (e) {
                if (
                  !(e instanceof Error) ||
                  e.message !== "DOCUMENT_EXCEEDS_64_MIB"
                )
                  throw e;
                await release(claim, e.message, true);
                stats.failures++;
                capacity.stopClaims = true;
                finish(claim);
              } finally {
                encoding.cancel();
              }
            }
            enqueue();
          } finally {
            permit.release();
          }
          exclusive = false;
          if (!options.overlap) await capacity.drainPayload();
        }
      }
    } catch (e) {
      fail(e);
    } finally {
      enqueue();
    }
  }
  async function consumer() {
    try {
      for (;;) {
        capacity.check();
        const next = queue.shift();
        if (!next) {
          if (capacity.finishedProducers) return;
          await capacity.available();
          continue;
        }
        const began = performance.now(),
          wait = began - next.ready;
        capacity.stats.queue_wait_ms += wait;
        capacity.stats.queue_wait_max_ms = Math.max(
          capacity.stats.queue_wait_max_ms,
          wait,
        );
        try {
          // Revalidate immediately before HTTP, and extend ownership for the request.
          const valid = await renew(
            next.items.map((p) => p.claim),
            true,
          );
          capacity.check();
          const current: Prepared[] = [];
          for (const p of next.items) {
            if (valid.has(key(p.claim))) current.push(p);
            else {
              stats.lease_rejected++;
              await release(p.claim, null);
            }
          }
          if (current.length) {
            const size = current.reduce((n, p) => n + p.body.length, 0);
            capacity.body(2 * size);
            try {
              await publishText(current, stats, capacity);
            } finally {
              capacity.body(-2 * size);
            }
          }
          for (const p of next.items) finish(p.claim);
        } finally {
          capacity.releasePayload(next.bytes, next.items.length);
          capacity.stats.publication_total_ms += performance.now() - began;
        }
      }
    } catch (e) {
      fail(e);
    }
  }
  const consumers = Array.from({ length: options.publishLanes }, () =>
    consumer(),
  );
  const producers = Array.from({ length: options.prepareLanes }, () =>
    producer(),
  );
  await Promise.all(producers);
  capacity.finishedProducers = true;
  capacity.wake();
  await Promise.all(consumers);
  monitoring = false;
  wakeMonitor?.();
  await monitor;
  // No task or SQL transaction survives this pass. Failed cleanup leaves leases
  // persisted for recovery, never an in-memory-only acknowledgement.
  for (const batch of queue.splice(0))
    capacity.releasePayload(batch.bytes, batch.items.length);
  if (active.size) {
    const remaining = [...active.values()].map((v) => v.claim);
    try {
      await pool.query(
        `UPDATE catalog_text_pending p SET claim=NULL,lease_until=NULL,
        error=CASE WHEN $2::boolean THEN 'PIPELINE_INTERRUPTED' ELSE error END,
        retry_at=CASE WHEN $2::boolean THEN now()+interval '2 seconds' ELSE retry_at END
        FROM jsonb_to_recordset($1::jsonb) c(work_id uuid,revision bigint,claim uuid)
        WHERE (p.work_id,p.revision,p.claim)=(c.work_id,c.revision,c.claim)`,
        [JSON.stringify(remaining), !!fatal],
      );
      stats.cancelled += remaining.length;
    } catch (e) {
      fatal ??= e;
    }
    for (const claim of remaining) finish(claim);
  }
  capacity.phase("prepare", 0);
  const wall = performance.now() - capacity.started;
  if (stats.claimed)
    console.info(
      JSON.stringify({
        ...stats,
        ...capacity.stats,
        wall_ms: wall,
        overlap_percent: (100 * capacity.stats.overlap_ms) / wall,
        preparation_inactive_wall_ms: wall - capacity.stats.prepare_wall_ms,
        http_inactive_wall_ms: wall - capacity.stats.http_wall_ms,
        options,
      }),
    );
  if (fatal || stats.failures)
    throw Object.assign(Error("SEARCH_BULK_PARTIAL_FAILURE"), {
      processed: stats.acknowledged,
    });
  return stats.acknowledged;
}
