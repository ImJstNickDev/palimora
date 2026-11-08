import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PackStore, sha } from "../apps/api/src/pack";

test("streaming repair verifies compressed and empty records; faults never publish partial packs", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-integrity-stream-")),
    store = new PackStore(root),
    reserve = process.env.ARCHIVE_RESERVE_BYTES;
  async function digest(input: AsyncIterable<Buffer>) {
    const h = createHash("sha256");
    for await (const b of input) h.update(b);
    return h.digest("hex");
  }
  try {
    const bytes = Buffer.alloc(17 * 1024 * 1024, "verified streaming payload");
    const [original] = await store.write([{ kind: "asset", bytes }]);
    assert.equal(await digest(store.stream(original)), sha(bytes));
    const restored = await store.restoreStream(
      original,
      store.stream(original),
      async () => {},
    );
    assert.notEqual(restored.pack, original.pack);
    assert.equal(await digest(store.stream(restored)), original.hash);
    const before = (await readdir(join(root, "packs"))).sort();
    let seen = 0;
    await assert.rejects(
      store.restoreStream(original, store.stream(original), async () => {
        if (++seen > 2) throw Error("INTEGRITY_INTERRUPTED");
      }),
      /INTEGRITY_INTERRUPTED/,
    );
    assert.deepEqual((await readdir(join(root, "packs"))).sort(), before);
    assert.deepEqual(await readdir(join(root, "staging")), []);
    process.env.ARCHIVE_RESERVE_BYTES = String(Number.MAX_SAFE_INTEGER);
    await assert.rejects(
      store.restoreStream(original, store.stream(original), async () => {}),
      /STORAGE_SPACE_INSUFFICIENT/,
    );
    if (reserve === undefined) delete process.env.ARCHIVE_RESERVE_BYTES;
    else process.env.ARCHIVE_RESERVE_BYTES = reserve;
    assert.deepEqual((await readdir(join(root, "packs"))).sort(), before);
    assert.deepEqual(await readdir(join(root, "staging")), []);
    const f = await open(join(root, "packs", restored.pack), "r+");
    await f.write(
      Buffer.from("!"),
      0,
      1,
      restored.offset + restored.length - 1,
    );
    await f.close();
    await assert.rejects(digest(store.stream(restored)), /OBJECT_CORRUPT/);
    await assert.rejects(
      store.restoreStream(original, store.stream(restored), async () => {}),
      /OBJECT_CORRUPT/,
    );
    assert.deepEqual((await readdir(join(root, "packs"))).sort(), before);
    const empty = await store.restoreStream(
      { kind: "asset", hash: sha(Buffer.alloc(0)), size: 0 },
      (async function* () {})(),
      async () => {},
    );
    assert.equal(await digest(store.stream(empty)), empty.hash);
    assert.equal(await digest(store.stream(original)), original.hash);
  } finally {
    if (reserve === undefined) delete process.env.ARCHIVE_RESERVE_BYTES;
    else process.env.ARCHIVE_RESERVE_BYTES = reserve;
    await rm(root, { recursive: true, force: true });
  }
});
