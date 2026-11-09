import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TextCapacity,
  TextPipelineStopped,
  textPipelineSettings,
  textNdjson,
} from "../apps/api/src/catalog-text-pipeline";

test("bounded NDJSON preserves JSON bytes, Unicode escapes, dates and rejects oversize before publication", () => {
  const values = {
    text: '\u0000\b\t\n\f\r"\\😀\ud800\udfff',
    array: [undefined, NaN, null, true],
    date: new Date("2020-01-01"),
    empty: {},
    omitted: undefined,
  };
  assert.deepEqual(
    textNdjson("{}\n", values),
    Buffer.from("{}\n" + JSON.stringify(values) + "\n"),
  );
  assert.throws(
    () => textNdjson("{}\n", { text: "\u0000".repeat(12 * 1024 * 1024) }),
    /DOCUMENT_EXCEEDS_64_MIB/,
  );
});

test("capacity applies document backpressure and wakes blocked producers on stop", async () => {
  const c = new TextCapacity(
    textPipelineSettings({ documents: 2 }),
    () => false,
  );
  await c.reserveDocuments(2);
  let entered = false;
  const blocked = c.reserveDocuments(1).then(() => {
    entered = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, false);
  c.releaseDocuments(1);
  await blocked;
  const cancelled = c.reserveDocuments(1);
  c.halt();
  await assert.rejects(cancelled, TextPipelineStopped);
  assert.equal(c.stats.claimed_documents_max, 2);
});

test("exceptional preparation waits for all payloads and excludes new ordinary preparation", async () => {
  const c = new TextCapacity(
    textPipelineSettings({ prepareLanes: 2, memoryBytes: 384 * 1024 * 1024 }),
    () => false,
  );
  const first = await c.prepare();
  const encoding = await c.reserveEncoding();
  encoding.retain(100);
  first.release();
  let entered = false;
  const large = c.prepare(true).then((p) => {
    entered = true;
    return p;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, false);
  c.releasePayload(100, 1);
  const exclusive = await large;
  let normal = false;
  const waiting = c.prepare().then((p) => {
    normal = true;
    return p;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(normal, false);
  exclusive.release();
  (await waiting).release();
});
