import { randomUUID } from "node:crypto";
import { pool, transaction } from "./db";
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
type Prepared = { claim: Claim; body: string };
const targetBytes = 8 * 1024 * 1024;
const maximumBytes = 64 * 1024 * 1024;

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
    WHERE p.work_id=c.work_id AND p.revision=c.revision AND p.claim=c.claim`,
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

export async function projectText(limit = 16, stopped = () => false) {
  await ensureSearchIndex();
  if (stopped()) return 0;
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
  };
  let start = performance.now();
  const claims = await claimText(limit);
  stats.claim_ms = performance.now() - start;
  stats.claimed = claims.length;
  let batch: Prepared[] = [],
    bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    bytes = 0;
    const body = current.map((p) => p.body).join("");
    stats.requests++;
    stats.bytes += Buffer.byteLength(body);
    const httpStart = performance.now();
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
        return;
      }
      const result = await response.json();
      if (
        !Array.isArray(result.items) ||
        result.items.length !== current.length
      )
        throw Error("Uncertain bulk response");
      items = result.items;
    } catch {
      for (const p of current) await release(p.claim, "BULK_RESULT_UNCERTAIN");
      stats.failures += current.length;
      return;
    } finally {
      stats.http_ms += performance.now() - httpStart;
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
      }
    }
    if (conflicts.length) {
      const flushStart = performance.now();
      stats.conflict_flushes++;
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
      }
    }
    const ackStart = performance.now();
    stats.acknowledged += await acknowledgeText(complete);
    stats.ack_ms += performance.now() - ackStart;
  };
  try {
    for (const claim of claims) {
      if (stopped()) {
        await release(claim, null);
        continue;
      }
      start = performance.now();
      let document: any;
      try {
        document = await transaction(async (db) => {
          await db.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
          );
          const row = (
            await db.query(
              `SELECT d.* FROM catalog_documents d
            JOIN catalog_text_pending p USING(work_id)
            WHERE p.work_id=$1 AND p.revision=$2 AND p.claim=$3 AND d.generation=p.requested_generation`,
              [claim.work_id, claim.revision, claim.claim],
            )
          ).rows[0];
          return row ? prepareTextDocument(db, row) : null;
        });
      } catch {
        await release(claim, "DOCUMENT_PREPARATION_FAILED");
        stats.failures++;
        continue;
      } finally {
        stats.prepare_ms += performance.now() - start;
      }
      if (!document) {
        await release(claim, null);
        continue;
      }
      // bigint is emitted as decimal JSON, never rounded through a JS number.
      const body =
        `{"index":{"_index":"${SEARCH_WRITE_ALIAS}","_id":"${claim.work_id}","version":${claim.revision},"version_type":"external","require_alias":true}}\n` +
        JSON.stringify(document) +
        "\n";
      const size = Buffer.byteLength(body);
      if (size > maximumBytes) {
        await release(claim, "DOCUMENT_EXCEEDS_64_MIB", true);
        stats.failures++;
        continue;
      }
      if (bytes + size > targetBytes) await flush();
      batch.push({ claim, body });
      bytes += size;
      if (bytes >= targetBytes) await flush();
    }
    await flush();
  } finally {
    if (claims.length) console.info(JSON.stringify(stats));
  }
  // Preserve existing operational failure history while successfully ACKed items
  // stay removed. Poison documents remain visible in backlog, never discarded.
  if (stats.failures)
    throw Object.assign(Error("SEARCH_BULK_PARTIAL_FAILURE"), {
      processed: stats.acknowledged,
    });
  return stats.acknowledged;
}
