import { test } from "node:test";
import assert from "node:assert/strict";
import { IngestPipeline } from "../apps/api/src/ingest-pipeline";

test("parallel completions preserve work order and acknowledge only the completed prefix", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed: string[] = [];
  let ack = 0;
  const pipeline = new IngestPipeline(3, () => ack++);
  await pipeline.add(["work:a"], async () => {
    await gate;
    completed.push("a1");
  });
  await pipeline.add(["work:b"], async () => {
    completed.push("b");
  });
  await pipeline.add(["work:a"], async () => {
    completed.push("a2");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, ["b"]);
  assert.equal(ack, 0);
  release();
  await pipeline.drain();
  assert.deepEqual(completed, ["b", "a1", "a2"]);
  assert.equal(ack, 3);
});

test("an asynchronous failure interrupts a waiting producer and drains without acknowledging the hole", async () => {
  let failed = 0,
    ack = 0;
  const pipeline = new IngestPipeline(
    2,
    () => ack++,
    () => failed++,
  );
  await pipeline.add(["a"], async () => {
    throw Error("broken segment");
  });
  await assert.rejects(pipeline.drain(), /broken segment/);
  assert.equal(failed, 1);
  assert.equal(ack, 0);
  await assert.rejects(
    pipeline.add(["b"], async () => {}),
    /broken segment/,
  );
});
