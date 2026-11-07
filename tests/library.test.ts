import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { api } from "../packages/contracts/src";

test("library contracts bound notes and tags, require a revision and validate cursors", () => {
  const id = randomUUID();
  assert.equal(
    api.bookmarkSave.input.safeParse({ id, bookmark: null }).success,
    false,
  );
  assert.equal(
    api.libraryList.input.safeParse({ cursor: "invalid" }).success,
    false,
  );
  assert.equal(
    api.bookmarkSave.input.safeParse({
      id,
      revision: 0,
      bookmark: { notes: "", tags: [" "], private: true, recommended: false },
    }).success,
    false,
  );
});
test(
  "library persists private bookmarks, rejects stale revisions, preserves later when history is cleared",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const setup = new Pool({ connectionString: url.toString() }),
      schema = "library_" + randomUUID().replaceAll("-", "");
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { libraryOperation, recordReading } = await import(
      "../apps/api/src/library"
    );
    try {
      await migrate();
      await migrate();
      const alice = randomUUID(),
        bob = randomUUID(),
        work = randomUUID();
      await pool.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,'alice','test','User'),($2,'bob','test','User')",
        [alice, bob],
      );
      await pool.query(
        "INSERT INTO archive_work_heads(id,external_id,title) VALUES($1,$2,$3)",
        [work, "123", "Example"],
      );
      const op = (name: string, input: unknown, user = alice) =>
        transaction((db) => libraryOperation(db, name, input, user));
      const bookmark = {
        notes: "private notes",
        tags: ["reading", "reading"],
        recommended: true,
        private: true,
      };
      let entry = await op("bookmarkSave", { id: work, revision: 0, bookmark });
      assert.deepEqual(entry.bookmark.tags, ["reading"]);
      assert.equal(entry.bookmark.notes, "private notes");
      assert.equal((await op("libraryWork", { id: work }, bob)).bookmark, null);
      assert.equal(
        (await op("libraryList", { kind: "bookmarks" }, bob)).items.length,
        0,
      );
      await assert.rejects(
        op("bookmarkSave", { id: work, revision: 0, bookmark }),
        /Http Exception/,
      );
      const revision = entry.revision;
      const writes = await Promise.allSettled([
        op("bookmarkSave", {
          id: work,
          revision,
          bookmark: { ...bookmark, notes: "first" },
        }),
        op("bookmarkSave", {
          id: work,
          revision,
          bookmark: { ...bookmark, notes: "second" },
        }),
      ]);
      assert.equal(writes.filter((x) => x.status === "fulfilled").length, 1);
      entry = await op("libraryWork", { id: work });
      const deleted = await op("bookmarkSave", {
        id: work,
        revision: entry.revision,
        bookmark: null,
      });
      assert.equal(deleted.bookmark, null);
      await assert.rejects(
        op("bookmarkSave", { id: work, revision: entry.revision, bookmark }),
        /Http Exception/,
      );
      await assert.rejects(
        op("bookmarkSave", { id: work, revision: 0, bookmark }),
        /Http Exception/,
      );
      assert.equal(
        (await op("libraryList", { kind: "bookmarks" })).items.length,
        0,
      );
      await op("libraryLater", { id: work, later: true });
      await transaction((db) => recordReading(db, alice, work));
      assert.equal(
        (await op("libraryList", { kind: "history" })).items.length,
        1,
      );
      await op("libraryForget", { id: work });
      assert.equal(
        (await op("libraryList", { kind: "history" })).items.length,
        0,
      );
      assert.equal(
        (await op("libraryList", { kind: "later" })).items.length,
        1,
      );
      await op("libraryLater", { id: work, later: false });
      assert.equal(
        (await op("libraryList", { kind: "later" })).items.length,
        0,
      );
      await assert.rejects(
        op("libraryWork", { id: randomUUID() }),
        /Http Exception/,
      );
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  },
);
