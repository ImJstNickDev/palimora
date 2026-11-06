import { findObjects } from "./archive-catalog";
import { createHash } from "node:crypto";
import { transaction } from "./db";
import { readObject } from "./archive";
export async function* downloadObject(hash: string): AsyncGenerator<Buffer> {
  const { kind, bytes } = await transaction(async (db) => ({
    kind: (await findObjects(db, [hash]))[0]?.kind,
    bytes: await readObject(db, hash),
  }));
  if (kind !== "chunk_manifest") {
    yield bytes;
    return;
  }
  const m = JSON.parse(bytes.toString());
  if (m.schema !== "palimora-chunks-v1") throw Error("CHUNK_SCHEMA");
  const sum = createHash("sha256");
  let size = 0;
  for (const chunk of m.chunks) {
    const b = await transaction((db) => readObject(db, chunk.hash));
    if (b.length !== chunk.size) throw Error("CHUNK_SIZE");
    sum.update(b);
    size += b.length;
    yield b;
  }
  if (size !== m.size || sum.digest("hex") !== m.sha256)
    throw Error("CHUNK_INTEGRITY");
}
