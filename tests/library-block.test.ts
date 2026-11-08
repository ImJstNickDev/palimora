import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test(
  "collections ACL, invitation consent, progress CAS and immutable annotation anchors across revisions",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const setup = new Pool({ connectionString: url.toString() }),
      schema = "library_block_" + randomUUID().replaceAll("-", "");
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const root = await mkdtemp(join(tmpdir(), "palimora-reading-"));
    process.env.ARCHIVE_ROOT = root;
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { collectionOperation } = await import("../apps/api/src/collections");
    const { readingOperation, alignAnchor, chapterTexts } = await import(
      "../apps/api/src/reading"
    );
    const { ingestRecord } = await import("../apps/api/src/archive");
    const { catalogOperation } = await import("../apps/api/src/catalog");
    try {
      await migrate();
      const owner = randomUUID(),
        editor = randomUUID(),
        viewer = randomUUID(),
        stranger = randomUUID();
      for (const [id, name] of [
        [owner, "owner"],
        [editor, "editor"],
        [viewer, "viewer"],
        [stranger, "stranger"],
      ])
        await pool.query(
          "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'test','User')",
          [id, name],
        );
      const co = (op: string, x: any, user = owner) =>
        transaction((db) => collectionOperation(db, op, x, user));
      const ro = (op: string, x: any, user = owner) =>
        transaction((db) => readingOperation(db, op, x, user));
      const collection = randomUUID();
      await co("collectionCreate", {
        id: collection,
        name: "Reading group",
        description: "",
      });
      await co("collectionMember", {
        id: collection,
        username: "viewer",
        role: "Viewer",
      });
      await co("collectionMember", {
        id: collection,
        username: "editor",
        role: "Editor",
      });
      assert.deepEqual(
        (await co("collectionCandidates", { id: collection })).items,
        [{ username: "stranger" }],
      );
      assert.deepEqual(
        (await co("collectionCandidates", { id: collection, q: "STR" })).items,
        [{ username: "stranger" }],
      );
      assert.deepEqual(
        (await co("collectionCandidates", { id: collection, q: "%" })).items,
        [],
      );
      assert.deepEqual(
        (
          await co("collectionCandidates", {
            id: collection,
            cursor: "stranger",
          })
        ).items,
        [],
      );
      await pool.query("UPDATE users SET disabled=true WHERE id=$1", [
        stranger,
      ]);
      assert.deepEqual(
        (await co("collectionCandidates", { id: collection })).items,
        [],
      );
      await pool.query("UPDATE users SET disabled=false WHERE id=$1", [
        stranger,
      ]);
      await assert.rejects(
        co("collectionCandidates", { id: collection }, stranger),
      );
      await assert.rejects(co("collectionDetail", { id: collection }, viewer));
      await co("collectionRespond", { id: collection, accept: true }, viewer);
      await co("collectionRespond", { id: collection, accept: true }, editor);
      await assert.rejects(
        co("collectionCandidates", { id: collection }, editor),
      );
      await assert.rejects(
        co("collectionCandidates", { id: collection }, viewer),
      );
      await assert.rejects(
        co(
          "collectionUpdate",
          {
            id: collection,
            name: "changed",
            description: "",
            revision: 1,
            deleted: false,
          },
          viewer,
        ),
      );
      await assert.rejects(
        co(
          "collectionMember",
          { id: collection, username: "stranger", role: "Editor" },
          editor,
        ),
      );
      await assert.rejects(
        transaction(async (db) => {
          await db.query("SELECT set_config('palimora.user',$1,true)", [
            viewer,
          ]);
          await db.query(
            "UPDATE library_collections SET name='bypass' WHERE id=$1",
            [collection],
          );
        }),
      );
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "fixture.zip",
          fingerprint: "fixture",
        };
      await pool.query(
        "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
        [batch],
      );
      await pool.query(
        "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
        [source.id, batch, source.path, source.fingerprint],
      );
      const ingest = async (text: string, cursor: number) =>
        ingestRecord(source, {
          parser: "test-1",
          locator: "work",
          cursor,
          record: {
            external_id: "123456",
            source_entry: "work",
            metadata: { title: ["Test work"] },
            chapters: [{ name: "chapter" }],
            objects: [
              {
                name: "chapter",
                kind: "chapter_html",
                data: Buffer.from("<p>" + text + "</p>").toString("base64"),
              },
            ],
            state: "valid",
            observed_at: null,
          },
        });
      const original =
        "A quiet opening. " +
        "Reading together preserves every original passage. " +
        "A long ending with enough context to make this unique.";
      await ingest(original, 1);
      const work = (await pool.query("SELECT * FROM archive_work_heads"))
          .rows[0],
        id = work.id,
        snapshot = work.current_snapshot_id;
      await co(
        "collectionWork",
        { id: collection, work: id, remove: false },
        editor,
      );
      const savedEntry = (
        await pool.query(
          "SELECT * FROM library_bookmarks WHERE user_id=$1 AND work_id=$2",
          [editor, id],
        )
      ).rows[0];
      assert.equal(savedEntry.deleted, false);
      assert.equal(savedEntry.revision, 1);
      assert.equal(
        (await co("collectionList", { work: id }, editor)).items[0]
          .contains_work,
        true,
      );
      await co(
        "collectionWork",
        { id: collection, work: id, remove: false },
        editor,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT revision FROM library_bookmarks WHERE user_id=$1 AND work_id=$2",
            [editor, id],
          )
        ).rows[0].revision,
        1,
      );
      await assert.rejects(
        co(
          "collectionWork",
          { id: collection, work: id, remove: false },
          viewer,
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM library_bookmarks WHERE user_id=$1",
            [viewer],
          )
        ).rows[0].n,
        0,
      );
      await co(
        "collectionWork",
        { id: collection, work: id, remove: true },
        editor,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT deleted FROM library_bookmarks WHERE user_id=$1 AND work_id=$2",
            [editor, id],
          )
        ).rows[0].deleted,
        false,
      );
      await co(
        "collectionWork",
        { id: collection, work: id, remove: false },
        editor,
      );
      await assert.rejects(
        co(
          "collectionWork",
          { id: collection, work: id, remove: true },
          viewer,
        ),
      );
      const rendered = await transaction((db) =>
        catalogOperation(db, "readerContent", { id, snapshot, skin: "off" }),
      );
      const texts = chapterTexts(rendered.document),
        chapter = [...texts.keys()][0],
        text = texts.get(chapter)!;
      const quote = "Reading together preserves every original passage.",
        offset = text.indexOf(quote);
      assert.ok(offset >= 0);
      const anchor = {
        snapshot,
        chapter,
        offset,
        quote,
        prefix: text.slice(Math.max(0, offset - 32), offset),
        suffix: text.slice(offset + quote.length, offset + quote.length + 32),
      };
      const requestId = randomUUID();
      const p = await ro("readingSave", {
        requestId,
        id,
        revision: 0,
        anchor,
        state: "reading",
      });
      assert.equal(p.revision, 1);
      const retry = { requestId, id, revision: 0, anchor, state: "reading" };
      const retries = await Promise.all([
        ro("readingSave", retry),
        ro("readingSave", retry),
      ]);
      assert.equal(retries[0].revision, 1);
      assert.equal(retries[1].revision, 1);
      await assert.rejects(ro("readingSave", { ...retry, state: "paused" }));

      const concurrent = await Promise.allSettled([
        ro("readingSave", { id, revision: 1, anchor, state: "paused" }),
        ro("readingSave", { id, revision: 1, anchor, state: "completed" }),
      ]);
      assert.equal(
        concurrent.filter((r) => r.status === "fulfilled").length,
        1,
      );
      assert.equal((await ro("readingProgress", { id }, viewer)).revision, 0);
      const note = randomUUID();
      await ro("annotationSave", {
        id,
        annotation_id: note,
        revision: 0,
        anchor,
        body: "Shared note",
        collection_id: collection,
        deleted: false,
      });
      assert.equal(
        (await ro("annotationList", { id }, viewer)).items.length,
        1,
      );
      assert.equal(
        (await ro("annotationList", { id }, stranger)).items.length,
        0,
      );
      await assert.rejects(
        ro(
          "annotationSave",
          {
            id,
            annotation_id: note,
            revision: 1,
            anchor,
            body: "overwrite",
            collection_id: collection,
            deleted: false,
          },
          viewer,
        ),
      );
      await ingest("An inserted introduction. " + original, 2);
      const next = (
        await pool.query(
          "SELECT id FROM archive_snapshot_data WHERE id<>$1 ORDER BY imported_at DESC LIMIT 1",
          [snapshot],
        )
      ).rows[0].id;
      await pool.query(
        "UPDATE archive_work_heads SET current_snapshot_id=$2 WHERE id=$1",
        [id, next],
      );
      const moved = (await ro("annotationList", { id })).items[0];
      assert.equal(moved.anchor.snapshot, snapshot);
      assert.equal(moved.aligned.status, "moved");
      assert.equal(moved.aligned.anchor.snapshot, next);
      assert.ok(moved.aligned.anchor.offset > offset);
      assert.equal(
        (
          await pool.query(
            "SELECT anchor FROM library_annotation_versions WHERE id=$1",
            [note],
          )
        ).rows[0].anchor.snapshot,
        snapshot,
      );
      assert.equal(
        alignAnchor(anchor, new Map([[chapter, text + text]]), next).status,
        "unresolved",
      );
      assert.equal(alignAnchor(anchor, new Map(), next).status, "unresolved");
      await ingest("Completely rewritten chapter.", 3);
      const changed = (
        await pool.query(
          "SELECT id FROM archive_snapshot_data WHERE id<>$1 AND id<>$2 ORDER BY imported_at DESC LIMIT 1",
          [snapshot, next],
        )
      ).rows[0].id;
      await pool.query(
        "UPDATE archive_work_heads SET current_snapshot_id=$2 WHERE id=$1",
        [id, changed],
      );
      const fallback = await ro("readingProgress", { id });
      assert.equal(fallback.anchor.snapshot, snapshot);
      assert.equal(fallback.aligned.status, "unresolved");
      assert.equal(fallback.aligned.anchor.offset, 0);
      assert.equal(
        (await ro("annotationList", { id })).items[0].aligned.anchor,
        null,
      );
      await pool.query("UPDATE users SET disabled=true WHERE id=$1", [viewer]);
      await co("collectionMember", {
        id: collection,
        username: "viewer",
        role: null,
      });
      assert.equal(
        (await ro("annotationList", { id }, viewer)).items.length,
        0,
      );
      await assert.rejects(co("collectionDetail", { id: collection }, viewer));
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reading percentage uses the same ordered UTF-16 chapter offsets", async () => {
  const { readingPercent } = await import("../packages/contracts/src/index");
  const lengths = [
    { chapter: "first", length: "A😀".length },
    { chapter: "second", length: 7 },
  ];
  assert.equal(readingPercent(lengths, { chapter: "second", offset: 2 }), 50);
  assert.equal(readingPercent(lengths, { chapter: "first", offset: 0 }), 0);
  assert.equal(
    readingPercent(lengths, { chapter: "second", offset: 100 }),
    100,
  );
  assert.equal(
    readingPercent(lengths, { chapter: "missing", offset: 1 }),
    null,
  );
});
