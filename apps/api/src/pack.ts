import { pressureConfig } from "./ingest-pressure";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
const nativeCodec: {
  batch: (
    buffers: Buffer[],
    options: number | number[],
    decode: boolean,
  ) => Promise<Buffer[]>;
} = require("../native/build/codec.node");
const compressionLevel = Number(process.env.ARCHIVE_ZSTD_LEVEL ?? 3);
if (
  !Number.isInteger(compressionLevel) ||
  compressionLevel < 1 ||
  compressionLevel > 19
)
  throw Error("ARCHIVE_ZSTD_LEVEL must be 1–19");
export const packTargetBytes =
  Number(process.env.ARCHIVE_PACK_MIB ?? 64) * 1024 * 1024;
if (![32, 64, 128].includes(packTargetBytes / 1024 / 1024))
  throw Error("ARCHIVE_PACK_MIB must be 32, 64 or 128");
const contentHashes = new WeakMap<Buffer, string>();
const compressedContent = new WeakMap<Buffer, Buffer>();
/** The native compiler returns SHA-256 of these immutable buffers. Disk reads
 * and sealing still compute their own digest independently. */
export function rememberPrepared(document: { bytes: Buffer; hash: string }) {
  contentHashes.set(document.bytes, document.hash);
}
function compressible(o: { kind: string; bytes: Buffer }) {
  // EPUB navigation XML is an asset in existing manifests. Compress its bytes
  // without reclassifying it or changing canonical identities; skip binary media.
  return (
    o.kind !== "asset" ||
    /^\s*(?:<\?xml\b|<svg\b|<!DOCTYPE\b|<html\b|<ncx\b)/i.test(
      o.bytes
        .subarray(0, 256)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    )
  );
}
/** Bounded preparation before catalog locks; buffers remain immutable. */
export async function prepareCompression(
  objects: { kind: string; bytes: Buffer }[],
) {
  // Equal verified bytes within this preparation share one encoded frame.
  // The map lives only for the bounded staging group, never across commits.
  const byHash = new Map<string, Buffer[]>();
  for (const o of objects) {
    if (!compressible(o) || compressedContent.has(o.bytes)) continue;
    const hash = contentHash(o.bytes);
    const group = byHash.get(hash);
    if (group) {
      if (group[0].length !== o.bytes.length) throw Error("HASH_COLLISION");
      group.push(o.bytes);
    } else byHash.set(hash, [o.bytes]);
  }
  const input = [...byHash.values()].map((buffers) => ({
    bytes: buffers[0],
    buffers,
  }));
  for (let start = 0; start < input.length; start += 256) {
    const batch = input.slice(start, start + 256);
    const encoded = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        compressBatch(batch.slice(i * 64, (i + 1) * 64).map((o) => o.bytes)),
      ),
    );
    encoded.flat().forEach((bytes, i) => {
      for (const source of batch[i].buffers)
        compressedContent.set(source, bytes);
    });
  }
}
export function contentHash(bytes: Buffer) {
  let hash = contentHashes.get(bytes);
  if (!hash) {
    hash = sha(bytes);
    contentHashes.set(bytes, hash);
  }
  return hash;
}
export const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
export function canonical(value: any): Buffer {
  const sort = (v: any): any => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw Error("CANONICAL_NUMBER");
    return Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  };
  return Buffer.from(JSON.stringify(sort(value)));
}
export async function compressBatch(input: Buffer[], level = compressionLevel) {
  if (!input.length) return [];
  return nativeCodec.batch(input, level, false);
}
export interface Locator {
  hash: string;
  pack: string;
  offset: number;
  length: number;
  size: number;
  kind: string;
}
async function writeAll(f: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const r = await f.write(bytes, offset, bytes.length - offset);
    if (!r.bytesWritten) throw Error("PACK_SHORT_WRITE");
    offset += r.bytesWritten;
  }
}
/** Scatter/gather without copying payloads; account for partial writes. */
async function writeBuffers(
  file: Awaited<ReturnType<typeof open>>,
  buffers: Buffer[],
) {
  let pending = buffers.filter((b) => b.length);
  while (pending.length) {
    const { bytesWritten } = await file.writev(pending);
    if (!bytesWritten) throw Error("PACK_SHORT_WRITE");
    let consumed = bytesWritten,
      index = 0;
    while (index < pending.length && consumed >= pending[index].length)
      consumed -= pending[index++].length;
    pending = pending.slice(index);
    if (consumed) pending[0] = pending[0].subarray(consumed);
  }
}
async function readAll(
  f: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const r = await f.read(bytes, offset, length - offset, position + offset);
    if (!r.bytesRead) throw Error("PACK_TRUNCATED");
    offset += r.bytesRead;
  }
  return bytes;
}
export class PackStore {
  constructor(
    readonly root = process.env.ARCHIVE_ROOT ?? "/storage",
    readonly targetBytes = packTargetBytes,
  ) {
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 1024)
      throw Error("PACK_TARGET");
  }
  writer() {
    return new PackWriter(this);
  }
  async write(objects: { kind: string; bytes: Buffer }[]): Promise<Locator[]> {
    const writer = this.writer();
    try {
      const records = await writer.append(objects);
      await writer.finish();
      return records;
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }
  /** Bounded streaming verifier for oversized records; ordinary reads retain the native batch codec. */
  async *stream(
    r: Locator,
    directory = join(this.root, "packs"),
  ): AsyncGenerator<Buffer> {
    validateLocator(r);
    const f = await open(
      join(directory, r.pack),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let decoder: ReturnType<typeof spawn> | undefined;
    try {
      if ((await readAll(f, 8, 0)).toString() !== "PMPACK01")
        throw Error("PACK_VERSION");
      const n = (await readAll(f, 4, r.offset)).readUInt32LE();
      if (n < 2 || n > 65536 || 4 + n > r.length) throw Error("PACK_HEADER");
      const h = JSON.parse((await readAll(f, n, r.offset + 4)).toString());
      checkHeader(h, r, r.length - 4 - n);
      const encoded = createHash("sha256"),
        decoded = createHash("sha256");
      let size = 0;
      const input =
        r.length === 4 + n
          ? Readable.from([])
          : f.createReadStream({
              start: r.offset + 4 + n,
              end: r.offset + r.length - 1,
              autoClose: false,
            });
      const checksum = new Transform({
        transform(chunk, _enc, cb) {
          encoded.update(chunk);
          cb(null, chunk);
        },
      });
      let output: any = input;
      let feed: Promise<unknown> | undefined, exit: Promise<void> | undefined;
      if (h.codec === "zstd") {
        decoder = spawn("zstd", ["-d", "-q", "-c"], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        exit = new Promise<void>((resolve, reject) => {
          decoder!.once("error", reject);
          decoder!.once("exit", (code) =>
            code === 0 ? resolve() : reject(Error("PACK_CORRUPT")),
          );
        });
        void exit.catch(() => {});
        feed = pipeline(input, checksum, decoder.stdin!);
        void feed.catch(() => {});
        output = decoder.stdout!;
      }
      try {
        for await (const chunk of output) {
          const b = Buffer.from(chunk);
          if (h.codec === "raw") encoded.update(b);
          decoded.update(b);
          size += b.length;
          if (size > r.size) throw Error("OBJECT_CORRUPT");
          yield b;
        }
        if (feed) await feed;
        if (exit) await exit;
        if (
          size !== r.size ||
          decoded.digest("hex") !== r.hash ||
          encoded.digest("hex") !== h.checksum
        )
          throw Error("OBJECT_CORRUPT");
      } finally {
        input.destroy();
        decoder?.kill();
        await feed?.catch(() => {});
        await exit?.catch(() => {});
      }
    } finally {
      decoder?.kill();
      await f.close();
    }
  }
  /** Copy-on-write repair: publish only independently verified, sealed raw records. */
  async restoreStream(
    r: Pick<Locator, "kind" | "hash" | "size">,
    input: AsyncIterable<Buffer>,
    check: () => Promise<void>,
  ): Promise<Locator> {
    if (
      !/^[a-f0-9]{64}$/.test(r.hash) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0
    )
      throw Error("PACK_LOCATOR");
    await mkdir(join(this.root, "staging"), { recursive: true });
    await mkdir(join(this.root, "packs"), { recursive: true });
    const pack = randomUUID() + ".pmpack",
      path = join(this.root, "staging", pack),
      f = await open(path, "wx", 0o600);
    const h = canonical({
        schema: 1,
        kind: r.kind,
        hash: r.hash,
        size: r.size,
        codec: "raw",
        length: r.size,
        checksum: r.hash,
      }),
      n = Buffer.alloc(4);
    n.writeUInt32LE(h.length);
    const locator = { ...r, pack, offset: 8, length: 4 + h.length + r.size };
    let size = 0;
    const hash = createHash("sha256");
    let closed = false;
    try {
      await writeAll(f, Buffer.concat([Buffer.from("PMPACK01"), n, h]));
      for await (const b of input) {
        await check();
        const disk = await statfs(this.root);
        if (disk.bavail * disk.bsize < archiveReserve() + b.length)
          throw Object.assign(Error("STORAGE_SPACE_INSUFFICIENT"), {
            code: "ENOSPC",
          });
        size += b.length;
        if (size > r.size) throw Error("OBJECT_CORRUPT");
        hash.update(b);
        await writeAll(f, b);
      }
      if (size !== r.size || hash.digest("hex") !== r.hash)
        throw Error("OBJECT_CORRUPT");
      await f.sync();
      await f.close();
      closed = true;
      for await (const _ of this.stream(locator, join(this.root, "staging")))
        await check();
      await rename(path, join(this.root, "packs", pack));
      for (const name of ["packs", "staging"]) {
        const d = await open(join(this.root, name), "r");
        try {
          await d.sync();
        } finally {
          await d.close();
        }
      }
      return locator;
    } catch (e) {
      if (!closed) await f.close();
      await unlink(path).catch(() => {});
      throw e;
    }
  }
  async read(r: Locator, directory?: string): Promise<Buffer> {
    return (await this.readMany([r], directory))[0];
  }
  /** Bounded caller batches; reuse handles and adjacent ranges during scrub and
   * compaction. Results retain the requested order and verify each object. */
  async readMany(
    records: Locator[],
    directory = join(this.root, "packs"),
  ): Promise<Buffer[]> {
    const groups = new Map<string, { r: Locator; index: number }[]>();
    records.forEach((r, index) => {
      validateLocator(r);
      const group = groups.get(r.pack) ?? [];
      group.push({ r, index });
      groups.set(r.pack, group);
    });
    const result: Buffer[] = new Array(records.length);
    for (const [pack, all] of groups) {
      const f = await open(join(directory, pack), "r");
      try {
        if ((await readAll(f, 8, 0)).toString() !== "PMPACK01")
          throw Error("PACK_VERSION");
        all.sort((a, b) => a.r.offset - b.r.offset);
        for (let start = 0; start < all.length; ) {
          let end = start + 1,
            finish = all[start].r.offset + all[start].r.length;
          while (
            end < all.length &&
            all[end].r.offset <= finish + 65536 &&
            all[end].r.offset + all[end].r.length - all[start].r.offset <=
              8 * 1024 * 1024
          ) {
            finish = Math.max(finish, all[end].r.offset + all[end].r.length);
            end++;
          }
          const offset = all[start].r.offset,
            bytes = await readAll(f, finish - offset, offset);
          const part = all.slice(start, end);
          const decoded = await decodeFrames(
            part.map(({ r }) =>
              recordFrame(
                bytes.subarray(r.offset - offset, r.offset - offset + r.length),
                r,
              ),
            ),
          );
          part.forEach((v, i) => (result[v.index] = decoded[i]));
          start = end;
        }
      } finally {
        await f.close();
      }
    }
    return result;
  }
}
function validateLocator(r: Locator) {
  if (!/^[a-f0-9-]+\.pmpack$/.test(r.pack)) throw Error("PACK_PATH");
  if (
    !Number.isSafeInteger(r.offset) ||
    r.offset < 8 ||
    !Number.isSafeInteger(r.length) ||
    r.length < 6 ||
    !Number.isSafeInteger(r.size) ||
    r.size < 0 ||
    !Number.isSafeInteger(r.offset + r.length)
  )
    throw Error("PACK_LOCATOR");
}
function recordFrame(b: Buffer, r: Locator) {
  if (b.length < 6) throw Error("PACK_HEADER");
  const n = b.readUInt32LE();
  if (n > 65536 || n < 2 || n + 4 > b.length) throw Error("PACK_HEADER");
  const h = JSON.parse(b.subarray(4, 4 + n).toString()),
    payload = b.subarray(4 + n);
  checkHeader(h, r, payload.length);
  if (sha(payload) !== h.checksum) throw Error("PACK_CORRUPT");
  return { h, payload };
}
function checkHeader(h: any, r: Locator, length: number) {
  if (
    h.schema !== 1 ||
    !["zstd", "raw"].includes(h.codec) ||
    h.hash !== r.hash ||
    h.kind !== r.kind ||
    h.size !== r.size ||
    !Number.isSafeInteger(h.size) ||
    h.size < 0 ||
    h.length !== length ||
    !/^[a-f0-9]{64}$/.test(h.checksum)
  )
    throw Error("PACK_CORRUPT");
}
async function decodeFrames(frames: { h: any; payload: Buffer }[]) {
  const result: Buffer[] = [];
  for (let start = 0; start < frames.length; ) {
    let end = start,
      raw = 0;
    while (
      end < frames.length &&
      end - start < 256 &&
      (end === start || raw + frames[end].h.size <= 16 * 1024 * 1024)
    )
      raw += frames[end++].h.size;
    const part = frames.slice(start, end),
      compressed = part.filter((f) => f.h.codec === "zstd");
    const decoded = (
      await Promise.all(
        Array.from({ length: 4 }, (_, i) => {
          const batch = compressed.slice(i * 64, (i + 1) * 64);
          return batch.length
            ? nativeCodec.batch(
                batch.map((f) => f.payload),
                batch.map((f) => f.h.size),
                true,
              )
            : [];
        }),
      )
    ).flat();
    let index = 0;
    for (const f of part) {
      const bytes = f.h.codec === "raw" ? f.payload : decoded[index++];
      if (bytes.length !== f.h.size || sha(bytes) !== f.h.hash)
        throw Error("OBJECT_CORRUPT");
      result.push(bytes);
    }
    start = end;
  }
  return result;
}

/** One bounded pack writer per database transaction. Its locators are not visible
 * until finish() seals and verifies every pack and the caller commits PostgreSQL. */
export class PackWriter {
  private current?: {
    file: Awaited<ReturnType<typeof open>>;
    pack: string;
    offset: number;
    records: Locator[];
  };
  private prepared = false;
  constructor(private readonly store: PackStore) {}
  async append(objects: { kind: string; bytes: Buffer }[]): Promise<Locator[]> {
    if (!objects.length) return [];
    const root = this.store.root;
    if (!this.prepared) {
      await mkdir(join(root, "staging"), { recursive: true });
      await mkdir(join(root, "packs"), { recursive: true });
      this.prepared = true;
    }
    const disk = await statfs(root);
    if (
      disk.bavail * disk.bsize <
      archiveReserve() + objects.reduce((n, o) => n + o.bytes.length, 0) * 2
    )
      throw Object.assign(Error("Insufficient archive space"), {
        code: "ENOSPC",
      });
    const result: Locator[] = [];
    // Four reusable codec contexts, amortized over batches of independent frames.
    for (let i = 0; i < objects.length; ) {
      let end = i,
        raw = 0;
      while (
        end < objects.length &&
        end - i < 256 &&
        (end === i || raw + objects[end].bytes.length <= 16 * 1024 * 1024)
      )
        raw += objects[end++].bytes.length;
      const batch = objects.slice(i, end);
      i = end;
      const toCompress = batch.filter(
        (o) => compressible(o) && !compressedContent.has(o.bytes),
      );
      const compressed = (
        await Promise.all(
          Array.from({ length: 4 }, (_, n) =>
            compressBatch(
              toCompress.slice(n * 64, n * 64 + 64).map((o) => o.bytes),
            ),
          ),
        )
      ).flat();
      let compressedIndex = 0;
      const encoded = batch.map((o) => {
        const encoded = !compressible(o)
          ? o.bytes
          : (compressedContent.get(o.bytes) ?? compressed[compressedIndex++]);
        const compression = encoded.length < o.bytes.length ? "zstd" : "raw";
        const payload = compression === "raw" ? o.bytes : encoded;
        const hash = contentHash(o.bytes);
        const header = canonical({
          schema: 1,
          hash,
          kind: o.kind,
          size: o.bytes.length,
          length: payload.length,
          codec: compression,
          checksum: sha(payload),
        });
        const n = Buffer.alloc(4);
        n.writeUInt32LE(header.length);
        return {
          hash,
          kind: o.kind,
          size: o.bytes.length,
          buffers: [n, header, payload],
          length: 4 + header.length + payload.length,
        };
      });
      let buffered: Buffer[] = [];
      for (const o of encoded) {
        if (
          this.current &&
          this.current.records.length &&
          this.current.offset + o.length > this.store.targetBytes
        ) {
          if (buffered.length) await writeBuffers(this.current.file, buffered);
          buffered = [];
          await this.finish();
        }
        if (!this.current) {
          const pack = randomUUID() + ".pmpack";
          const file = await open(join(root, "staging", pack), "wx+", 0o600);
          this.current = { file, pack, offset: 8, records: [] };
          await writeAll(file, Buffer.from("PMPACK01"));
        }
        const c = this.current;
        const r = {
          hash: o.hash,
          kind: o.kind,
          size: o.size,
          pack: c.pack,
          offset: c.offset,
          length: o.length,
        };
        buffered.push(...o.buffers);
        c.offset += o.length;
        c.records.push(r);
        result.push(r);
        if (c.offset >= this.store.targetBytes) {
          await writeBuffers(c.file, buffered);
          buffered = [];
          await this.finish();
        }
      }
      if (buffered.length) await writeBuffers(this.current!.file, buffered);
    }
    return result;
  }
  async finish() {
    const c = this.current;
    if (!c) return;
    await c.file.sync();
    if ((await readAll(c.file, 8, 0)).toString() !== "PMPACK01")
      throw Error("PACK_VERSION");
    // Verify bounded windows, independent of target size or object count.
    for (let start = 0; start < c.records.length; ) {
      let end = start,
        raw = 0;
      while (
        end < c.records.length &&
        end - start < 256 &&
        (end === start || raw + c.records[end].size <= 16 * 1024 * 1024)
      )
        raw += c.records[end++].size;
      const records = c.records.slice(start, end),
        offset = records[0].offset;
      const last = records[records.length - 1];
      const packed = await readAll(
        c.file,
        last.offset + last.length - offset,
        offset,
      );
      const frames = records.map((r) =>
        recordFrame(
          packed.subarray(r.offset - offset, r.offset - offset + r.length),
          r,
        ),
      );
      start = end;
      await decodeFrames(frames);
    }
    await c.file.close();
    await rename(
      join(this.store.root, "staging", c.pack),
      join(this.store.root, "packs", c.pack),
    );
    for (const name of ["packs", "staging"]) {
      const dir = await open(join(this.store.root, name), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    this.current = undefined;
  }
  async abort() {
    const c = this.current;
    if (!c) return;
    this.current = undefined;
    await c.file.close().catch(() => {});
    await unlink(join(this.store.root, "staging", c.pack)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
// Rebuild locators without PostgreSQL. A sealed file ends exactly at a record boundary.
export async function scanPack(root: string, pack: string): Promise<Locator[]> {
  const records: Locator[] = [];
  for await (const r of scanPackRecords(root, pack)) records.push(r);
  return records;
}
export async function* scanPackRecords(
  root: string,
  pack: string,
  from = 8,
): AsyncGenerator<Locator> {
  if (!/^[a-f0-9-]+\.pmpack$/.test(pack)) throw Error("PACK_PATH");
  const f = await open(join(root, "packs", pack), "r");
  try {
    const size = (await f.stat()).size,
      magic = await readAll(f, 8, 0);
    if (magic.toString() !== "PMPACK01") throw Error("PACK_VERSION");
    if (!Number.isSafeInteger(from) || from < 8 || from > size)
      throw Error("PACK_LOCATOR");
    let offset = from;
    while (offset < size) {
      const b = Buffer.alloc(4);
      if ((await f.read(b, 0, 4, offset)).bytesRead !== 4)
        throw Error("PACK_TRUNCATED");
      const n = b.readUInt32LE();
      if (n > 65536 || n < 2 || offset + 4 + n > size)
        throw Error("PACK_HEADER");
      const data = await readAll(f, n, offset + 4);
      const h = JSON.parse(data.toString());
      if (
        h.schema !== 1 ||
        !["raw", "zstd"].includes(h.codec) ||
        typeof h.kind !== "string" ||
        !/^[a-f0-9]{64}$/.test(h.hash) ||
        !/^[a-f0-9]{64}$/.test(h.checksum) ||
        !Number.isSafeInteger(h.size) ||
        h.size < 0 ||
        !Number.isSafeInteger(h.length) ||
        h.length < 0 ||
        offset + 4 + n + h.length > size
      )
        throw Error("PACK_TRUNCATED");
      yield {
        hash: h.hash,
        kind: h.kind,
        size: h.size,
        pack,
        offset,
        length: 4 + n + h.length,
      };
      offset += 4 + n + h.length;
    }
  } finally {
    await f.close();
  }
}

function archiveReserve() {
  const base = Number(process.env.ARCHIVE_RESERVE_BYTES ?? 268435456);
  return process.env.INGEST_PRESSURE_MODE === "throughput-first"
    ? Math.max(base, pressureConfig().reserve)
    : base;
}
