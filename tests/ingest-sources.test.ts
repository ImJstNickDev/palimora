import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceBudgets, scheduleSources } from "../apps/api/src/ingest-sources";
const immediate = () => new Promise<void>((r) => setImmediate(r));
test("fixed lanes conserve global parser and commit budgets", () => {
  for (let sources = 1; sources <= 4; sources++)
    for (let parsers = 1; parsers <= 16; parsers++)
      for (let commits = 1; commits <= 4; commits++) {
        const b = sourceBudgets(sources, parsers, commits);
        assert.equal(
          b.reduce((n, v) => n + v.parsers, 0),
          parsers,
        );
        assert.equal(
          b.reduce((n, v) => n + v.commits, 0),
          commits,
        );
        assert.ok(
          b.length <= sources &&
            b.every((v) => v.parsers >= 1 && v.commits >= 1),
        );
      }
});
test("fast lane advances past a slow ZIP; SQLite waits for every ZIP", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const done: string[] = [];
  const task = scheduleSources(
    ["slow.zip", "fast.zip", "small.zip", "index.sqlite3"].map((path) => ({
      path,
    })),
    sourceBudgets(2, 2, 2),
    async (s) => {
      if (s.path === "slow.zip") await gate;
      if (s.path.endsWith("sqlite3")) assert.equal(done.length, 3);
      done.push(s.path);
    },
  );
  await immediate();
  assert.deepEqual(done, ["fast.zip", "small.zip"]);
  release();
  await task;
  assert.equal(done.at(-1), "index.sqlite3");
});
test("fatal lane failure waits for already admitted work and prevents more admission", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let drained = false;
  const task = scheduleSources(
    ["fail.zip", "slow.zip", "never.zip"].map((path) => ({ path })),
    sourceBudgets(2, 2, 2),
    async (s) => {
      if (s.path === "fail.zip") throw Error("fatal");
      assert.equal(s.path, "slow.zip");
      await gate;
      drained = true;
    },
  );
  await immediate();
  assert.equal(drained, false);
  release();
  await assert.rejects(task, /fatal/);
  assert.equal(drained, true);
});
