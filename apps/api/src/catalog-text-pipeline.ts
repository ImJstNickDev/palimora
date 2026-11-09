/** Transient capacity only: PostgreSQL owns every claim and recovery decision. */
export const textMaximumBytes = 64 * 1024 * 1024;
export const textPreparationWindow = 16 * 1024 * 1024;
const MiB = 1024 * 1024;
export type TextPipelineOptions = {
  prepareLanes: number;
  publishLanes: number;
  groups: number;
  documents: number;
  ndjsonBytes: number;
  memoryBytes: number;
  renewMs: number;
  overlap: boolean;
};
export function textPipelineSettings(
  overrides: Partial<TextPipelineOptions> = {},
): TextPipelineOptions {
  const number = (
    key: keyof TextPipelineOptions,
    env: string,
    fallback: number,
    min: number,
    max: number,
    scale = 1,
  ) => {
    const n = overrides[key] ?? Number(process.env[env] ?? fallback) * scale;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
      throw Error(`Invalid ${env}`);
    return n;
  };
  const result = {
    prepareLanes: number(
      "prepareLanes",
      "PROJECTION_TEXT_PREPARE_LANES",
      1,
      1,
      2,
    ),
    publishLanes: number(
      "publishLanes",
      "PROJECTION_TEXT_PUBLISH_LANES",
      1,
      1,
      2,
    ),
    groups: number("groups", "PROJECTION_TEXT_GROUPS", 8, 1, 64),
    documents: number("documents", "PROJECTION_TEXT_DOCUMENTS", 256, 1, 4096),
    ndjsonBytes: number(
      "ndjsonBytes",
      "PROJECTION_TEXT_NDJSON_MIB",
      384,
      320 * MiB,
      1024 * MiB,
      MiB,
    ),
    memoryBytes: number(
      "memoryBytes",
      "PROJECTION_TEXT_MEMORY_MIB",
      448,
      352 * MiB,
      2048 * MiB,
      MiB,
    ),
    renewMs: number("renewMs", "PROJECTION_TEXT_RENEW_MS", 60000, 100, 60000),
    overlap: overrides.overlap ?? process.env.PROJECTION_TEXT_OVERLAP !== "0",
  };
  if (
    result.memoryBytes <
    result.prepareLanes * 2 * textPreparationWindow + 5 * textMaximumBytes
  )
    throw Error("Text memory budget cannot make progress");
  if (
    !result.overlap &&
    (result.prepareLanes !== 1 || result.publishLanes !== 1)
  )
    throw Error("Sequential text profile requires one lane per stage");
  return result;
}
export class TextPipelineStopped extends Error {}
export class TextNeedsExclusive extends Error {}

/** Counts encoded JSON before allocating an oversized scalar. JSON.stringify
 * remains the serializer, including dates, key order and lone-surrogate escapes. */
export function textNdjson(header: string, document: any): Buffer {
  let size = Buffer.byteLength(header) + 1;
  const quoted = (s: string) => {
    let n = Buffer.byteLength(s) + 2;
    for (const m of s.matchAll(/[\u0000-\u001f"\\\ud800-\udfff]/g)) {
      const c = m[0].charCodeAt(0),
        i = m.index!;
      if (c >= 0xd800) {
        const paired =
          c <= 0xdbff
            ? s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff
            : s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff;
        if (!paired) n += 3;
      } else n += c < 32 && ![8, 9, 10, 12, 13].includes(c) ? 5 : 1;
    }
    return n;
  };
  let root = true;
  const included = (v: unknown) =>
    v !== undefined && typeof v !== "function" && typeof v !== "symbol";
  const json = JSON.stringify(document, function (key, value) {
    if (!included(value) && !Array.isArray(this)) return value;
    if (!root && !Array.isArray(this)) size += quoted(key) + 1;
    root = false;
    if (value === null || !included(value)) size += 4;
    else if (typeof value === "string") size += quoted(value);
    else if (typeof value === "object") {
      const length = Array.isArray(value)
        ? value.length
        : Object.keys(value).filter((k) => included(value[k])).length;
      size += 2 + Math.max(0, length - 1);
    } else
      size += String(
        typeof value === "number" && !Number.isFinite(value) ? null : value,
      ).length;
    if (size > textMaximumBytes) throw Error("DOCUMENT_EXCEEDS_64_MIB");
    return value;
  });
  const body = Buffer.from(header + json + "\n");
  if (body.length > textMaximumBytes) throw Error("DOCUMENT_EXCEEDS_64_MIB");
  return body;
}

export class TextCapacity {
  halted = false;
  stopClaims = false;
  finishedProducers = false;
  private wakes = new Set<() => void>();
  private documents = 0;
  private preparations = 0;
  private exclusive = false;
  private exclusiveWaiters = 0;
  private preparationBytes = 0;
  private reservedPayload = 0;
  private payloadBytes = 0;
  private payloadDocuments = 0;
  private bodyBytes = 0;
  private preparing = 0;
  private http = 0;
  private updated = performance.now();
  readonly started = this.updated;
  readonly stats = {
    producer_wait_ms: 0,
    consumer_idle_ms: 0,
    queue_wait_ms: 0,
    queue_wait_max_ms: 0,
    prepare_wall_ms: 0,
    http_wall_ms: 0,
    overlap_ms: 0,
    preparation_concurrency_max: 0,
    http_concurrency_max: 0,
    buffered_documents_max: 0,
    ndjson_bytes_max: 0,
    reserved_bytes_max: 0,
    claimed_documents_max: 0,
    exceptional_preparations: 0,
    exceptional_input_bytes_max: 0,
    groups: 0,
    group_total_ms: 0,
    group_max_ms: 0,
    publication_total_ms: 0,
  };
  constructor(
    readonly options: TextPipelineOptions,
    private stopped: () => boolean,
  ) {}
  wake() {
    for (const fn of this.wakes) fn();
    this.wakes.clear();
  }
  halt() {
    this.halted = true;
    this.wake();
  }
  check() {
    if (this.stopped()) this.halt();
    if (this.halted) throw new TextPipelineStopped();
  }
  private async wait(kind: "producer_wait_ms" | "consumer_idle_ms") {
    const start = performance.now();
    await new Promise<void>((resolve) => this.wakes.add(resolve));
    this.stats[kind] += performance.now() - start;
  }
  async reserveDocuments(count: number) {
    for (;;) {
      this.check();
      if (
        this.documents + count <= this.options.documents &&
        (this.options.overlap || this.documents === 0)
      )
        break;
      await this.wait("producer_wait_ms");
    }
    this.documents += count;
    this.stats.claimed_documents_max = Math.max(
      this.stats.claimed_documents_max,
      this.documents,
    );
  }
  releaseDocuments(count: number) {
    this.documents -= count;
    this.wake();
  }
  async prepare(exclusive = false) {
    if (exclusive) this.exclusiveWaiters++;
    try {
      for (;;) {
        this.check();
        if (
          exclusive
            ? this.preparations === 0 && this.reservedPayload === 0
            : !this.exclusive &&
              !this.exclusiveWaiters &&
              this.preparations < this.options.prepareLanes &&
              this.preparationBytes +
                2 * textPreparationWindow +
                this.reservedPayload <=
                this.options.memoryBytes
        )
          break;
        await this.wait("producer_wait_ms");
      }
    } finally {
      if (exclusive) this.exclusiveWaiters--;
    }
    this.preparations++;
    this.exclusive = exclusive;
    let bytes = 2 * textPreparationWindow;
    this.preparationBytes += bytes;
    if (exclusive) this.stats.exceptional_preparations++;
    this.peak();
    return {
      admit: (inputBytes: number) => {
        if (inputBytes > textPreparationWindow && !exclusive)
          throw new TextNeedsExclusive();
        if (exclusive) {
          const next = Math.max(bytes, 2 * inputBytes);
          this.preparationBytes += next - bytes;
          bytes = next;
          this.stats.exceptional_input_bytes_max = Math.max(
            this.stats.exceptional_input_bytes_max,
            inputBytes,
          );
          this.peak();
        }
      },
      release: () => {
        this.preparations--;
        this.preparationBytes -= bytes;
        if (exclusive) this.exclusive = false;
        this.wake();
      },
    };
  }
  encodingReady() {
    // Encoded buffer plus temporary UTF-16 strings (map/join or stringify).
    const reservation = 5 * textMaximumBytes;
    return (
      this.reservedPayload + reservation <= this.options.ndjsonBytes &&
      (this.preparationBytes + this.reservedPayload + reservation <=
        this.options.memoryBytes ||
        (this.exclusive && this.reservedPayload === 0))
    );
  }
  async drainPayload() {
    while (this.reservedPayload) {
      this.check();
      await this.wait("producer_wait_ms");
    }
  }
  async reserveEncoding() {
    const reservation = 5 * textMaximumBytes;
    for (;;) {
      this.check();
      if (this.encodingReady()) break;
      await this.wait("producer_wait_ms");
    }
    this.reservedPayload += reservation;
    this.peak();
    let retained = false;
    return {
      retain: (bytes: number) => {
        retained = true;
        this.reservedPayload -= reservation - 5 * bytes;
        this.payloadBytes += bytes;
        this.payloadDocuments++;
        this.peak();
        this.wake();
      },
      cancel: () => {
        if (!retained) {
          this.reservedPayload -= reservation;
          this.wake();
        }
      },
    };
  }
  releasePayload(bytes: number, documents: number) {
    this.reservedPayload -= 5 * bytes;
    this.payloadBytes -= bytes;
    this.payloadDocuments -= documents;
    this.wake();
  }
  private peak() {
    this.stats.buffered_documents_max = Math.max(
      this.stats.buffered_documents_max,
      this.payloadDocuments,
    );
    this.stats.ndjson_bytes_max = Math.max(
      this.stats.ndjson_bytes_max,
      this.payloadBytes + this.bodyBytes,
    );
    this.stats.reserved_bytes_max = Math.max(
      this.stats.reserved_bytes_max,
      this.preparationBytes + this.reservedPayload,
    );
  }
  body(bytes: number) {
    this.bodyBytes += bytes;
    this.peak();
  }
  phase(stage: "prepare" | "http", delta: number) {
    const now = performance.now(),
      elapsed = now - this.updated;
    if (this.preparing) this.stats.prepare_wall_ms += elapsed;
    if (this.http) this.stats.http_wall_ms += elapsed;
    if (this.preparing && this.http) this.stats.overlap_ms += elapsed;
    this.updated = now;
    if (stage === "prepare") this.preparing += delta;
    else this.http += delta;
    this.stats.preparation_concurrency_max = Math.max(
      this.stats.preparation_concurrency_max,
      this.preparing,
    );
    this.stats.http_concurrency_max = Math.max(
      this.stats.http_concurrency_max,
      this.http,
    );
  }
  async available() {
    this.check();
    await this.wait("consumer_idle_ms");
  }
}
