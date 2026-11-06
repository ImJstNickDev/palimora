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
  const input = objects.filter(
    (o) => compressible(o) && !compressedContent.has(o.bytes),
  );
  for (let start = 0; start < input.length; start += 256) {
    const batch = input.slice(start, start + 256);
    const encoded = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        compressBatch(batch.slice(i * 64, (i + 1) * 64).map((o) => o.bytes)),
      ),
    );
    encoded
      .flat()
      .forEach((bytes, i) => compressedContent.set(batch[i].bytes, bytes));
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
  async read(r: Locator): Promise<Buffer> {
    return (await this.readMany([r]))[0];
  }
  /** Bounded caller batches; reuse handles and adjacent ranges during scrub and
   * compaction. Results retain the requested order and verify each object. */
  async readMany(records: Locator[]): Promise<Buffer[]> {
    const groups = new Map<string, { r: Locator; index: number }[]>();
    records.forEach((r, index) => {
      validateLocator(r);
      const group = groups.get(r.pack) ?? [];
      group.push({ r, index });
      groups.set(r.pack, group);
    });
    const result: Buffer[] = new Array(records.length);
    for (const [pack, all] of groups) {
      const f = await open(join(this.root, "packs", pack), "r");
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
  if (
    h.schema !== 1 ||
    !["zstd", "raw"].includes(h.codec) ||
    h.hash !== r.hash ||
    h.kind !== r.kind ||
    h.size !== r.size ||
    !Number.isSafeInteger(h.size) ||
    h.size < 0 ||
    h.length !== payload.length ||
    sha(payload) !== h.checksum
  )
    throw Error("PACK_CORRUPT");
  return { h, payload };
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
      Number(process.env.ARCHIVE_RESERVE_BYTES ?? 268435456) +
        objects.reduce((n, o) => n + o.bytes.length, 0) * 2
    )
      throw Object.assign(Error("Insufficient archive space"), {
        code: "ENOSPC",
      });
    const result: Locator[] = [];
    // Four reusable codec contexts, amortized over batches of independent frames.
    for (let i = 0; i < objects.length; i += 64) {
      const batch = objects.slice(i, i + 64);
      const toCompress = batch.filter(
        (o) => compressible(o) && !compressedContent.has(o.bytes),
      );
      const compressed = (
        await Promise.all(
          Array.from({ length: 4 }, (_, n) =>
            compressBatch(
              toCompress.slice(n * 16, n * 16 + 16).map((o) => o.bytes),
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
          bytes: Buffer.concat([n, header, payload]),
        };
      });
      let buffered: Buffer[] = [];
      for (const o of encoded) {
        if (
          this.current &&
          this.current.records.length &&
          this.current.offset + o.bytes.length > this.store.targetBytes
        ) {
          if (buffered.length)
            await writeAll(this.current.file, Buffer.concat(buffered));
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
          length: o.bytes.length,
        };
        buffered.push(o.bytes);
        c.offset += o.bytes.length;
        c.records.push(r);
        result.push(r);
        if (c.offset >= this.store.targetBytes) {
          await writeAll(c.file, Buffer.concat(buffered));
          buffered = [];
          await this.finish();
        }
      }
      if (buffered.length)
        await writeAll(this.current!.file, Buffer.concat(buffered));
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
  if (!/^[a-f0-9-]+\.pmpack$/.test(pack)) throw Error("PACK_PATH");
  const f = await open(join(root, "packs", pack), "r");
  try {
    const size = (await f.stat()).size,
      magic = await readAll(f, 8, 0);
    if (magic.toString() !== "PMPACK01") throw Error("PACK_VERSION");
    const records: Locator[] = [];
    let offset = 8;
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
      records.push({
        hash: h.hash,
        kind: h.kind,
        size: h.size,
        pack,
        offset,
        length: 4 + n + h.length,
      });
      offset += 4 + n + h.length;
    }
    return records;
  } finally {
    await f.close();
  }
}
