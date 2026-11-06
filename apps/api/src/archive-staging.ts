import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { contentHash, prepareCompression } from "./pack";

const prepared = new WeakMap<object, Buffer>();
export function preparedBytes(object: object) {
  return prepared.get(object);
}

/** Read each contiguous segment once, with eight asynchronous reads in flight.
 * Oversized records retain the streaming path rather than expanding the budget. */
export async function prepareStaging(root: string, envelopes: any[]) {
  const paths = new Map<string, any[]>();
  let budget = 32 * 1024 * 1024;
  const objects: { kind: string; bytes: Buffer }[] = [];
  for (const envelope of envelopes)
    for (const o of envelope.record.objects) {
      prepared.delete(o);
      if (o.cached) continue;
      if (!o.path) {
        const bytes = Buffer.from(o.data, "base64");
        if (bytes.length <= budget) {
          budget -= bytes.length;
          prepared.set(o, bytes);
          contentHash(bytes);
          objects.push({ kind: o.kind, bytes });
        }
        continue;
      }
      if (o.offset === undefined) continue;
      if (
        !Number.isSafeInteger(o.offset) ||
        o.offset < 0 ||
        !Number.isSafeInteger(o.size) ||
        o.size < 0 ||
        !Number.isSafeInteger(o.offset + o.size)
      )
        throw Error("ADAPTER_RANGE");
      const list = paths.get(o.path) ?? [];
      list.push(o);
      paths.set(o.path, list);
    }
  const jobs: [string, any[], number, number][] = [];
  for (const [path, list] of paths) {
    const start = list.reduce((n, o) => Math.min(n, o.offset), Infinity);
    const end = list.reduce((n, o) => Math.max(n, o.offset + o.size), 0);
    if (end - start > budget) continue;
    budget -= end - start;
    jobs.push([path, list, start, end]);
  }
  if (jobs.length) {
    const staging = await realpath(join(root, "staging"));
    let next = 0;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(8, jobs.length) }, async () => {
        while (next < jobs.length) {
          const [path, list, start, end] = jobs[next++];
          const resolved = await realpath(path);
          if (!resolved.startsWith(staging + sep)) throw Error("ADAPTER_PATH");
          const file = await open(resolved, "r");
          try {
            const bytes = Buffer.allocUnsafe(end - start);
            let n = 0;
            while (n < bytes.length) {
              const result = await file.read(
                bytes,
                n,
                bytes.length - n,
                start + n,
              );
              if (!result.bytesRead) throw Error("ADAPTER_RANGE");
              n += result.bytesRead;
            }
            for (const o of list) {
              const b = bytes.subarray(
                o.offset - start,
                o.offset - start + o.size,
              );
              if (contentHash(b) !== o.hash) throw Error("ADAPTER_HASH");
              prepared.set(o, b);
              objects.push({ kind: o.kind, bytes: b });
            }
          } finally {
            await file.close();
          }
        }
      }),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  await prepareCompression(objects);
}
