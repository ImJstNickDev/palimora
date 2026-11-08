import { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, open, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackStore, canonical, scanPack, sha } from "../apps/api/src/pack";
test("pack v1 reconstructs locators, round-trips independent records and rejects corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-pack-"));
  try {
    const store = new PackStore(root);
    const input = [
      { kind: "chapter_html", bytes: Buffer.from("<p>à 🐈</p>") },
      { kind: "manifest", bytes: canonical({ z: 1, a: ["test"] }) },
    ];
    const records = await store.write(input);
    assert.deepEqual(await scanPack(root, records[0].pack), records);
    for (let i = 0; i < input.length; i++)
      assert.deepEqual(await store.read(records[i]), input[i].bytes);
    assert.equal(
      canonical({ z: 1, a: 2 }).toString(),
      canonical({ a: 2, z: 1 }).toString(),
    );
    process.env.ARCHIVE_RESERVE_BYTES = "999999999999999";
    await assert.rejects(store.write(input), { code: "ENOSPC" });
    delete process.env.ARCHIVE_RESERVE_BYTES;
    const f = await open(join(root, "packs", records[0].pack), "r+");
    await f.write(
      Buffer.from([0]),
      0,
      1,
      records[0].offset + records[0].length - 1,
    );
    await f.close();
    await assert.rejects(store.read(records[0]));
    assert.deepEqual(await store.read(records[1]), input[1].bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("pack rotation uses stored bytes, preserves XML assets and bounds random reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-packing-"));
  try {
    const store = new PackStore(root, 4096);
    await store.write([]);
    await assert.rejects(stat(join(root, "packs")), { code: "ENOENT" });
    const { randomBytes } = await import("node:crypto");
    const input = [
      ...Array.from({ length: 20 }, () => ({
        kind: "asset",
        bytes: randomBytes(700),
      })),
      {
        kind: "asset",
        bytes: Buffer.from(
          '<?xml version="1.0"?><ncx>' + "navigation ".repeat(500) + "</ncx>",
        ),
      },
      { kind: "notes_html", bytes: Buffer.from("x") },
      { kind: "asset", bytes: randomBytes(5000) },
    ];
    const writer = store.writer();
    const records = [];
    for (let i = 0; i < input.length; i += 3)
      records.push(...(await writer.append(input.slice(i, i + 3))));
    await writer.finish();
    await writer.finish();
    const files = await readdir(join(root, "packs"));
    for (const pack of files) {
      const locators = await scanPack(root, pack),
        size = (await stat(join(root, "packs", pack))).size;
      assert.ok(locators.length);
      assert.ok(size <= 4096 || locators.length === 1);
    }
    const reopened = new PackStore(root);
    const reversed = [...records].reverse();
    const actual = await reopened.readMany(reversed);
    actual.forEach((bytes, i) =>
      assert.deepEqual(bytes, input[input.length - i - 1].bytes),
    );
    assert.ok(
      records[20].length < 1000,
      "navigation XML must be compressed without changing kind",
    );
    assert.ok(
      records[21].length < 250,
      "tiny content uses raw when Zstd would expand it",
    );
    await assert.rejects(
      reopened.read({ ...records[0], offset: 0 }),
      /PACK_LOCATOR/,
    );
    await assert.rejects(
      reopened.read({ ...records[0], kind: "manifest" }),
      /PACK_CORRUPT/,
    );
    await assert.rejects(
      reopened.read({ ...records[0], size: records[0].size + 1 }),
      /PACK_CORRUPT/,
    );
    const pending = store.writer();
    await pending.append([
      { kind: "chapter_html", bytes: Buffer.from("not committed") },
    ]);
    assert.equal((await readdir(join(root, "packs"))).length, files.length);
    await pending.abort();
    assert.deepEqual(await readdir(join(root, "staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "archive commit is immutable, idempotent, globally deduplicated and survives absent source",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "palimora-archive-"));
    assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname, /test/);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema =
      "test_archive_" +
      (await import("node:crypto")).randomUUID().replaceAll("-", "");
    const setupPool = new Pool({ connectionString: url.toString() });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.ARCHIVE_ROOT = root;
    const { pool, migrate } = await import("../apps/api/src/db");
    const { ingestRecord, ingestRecords, readObject, compactObjects, store } =
      await import("../apps/api/src/archive");
    const { randomUUID } = await import("node:crypto");
    const { archiveOperation } = await import("../apps/api/src/archive-admin");
    const { transaction } = await import("../apps/api/src/db");

    try {
      await migrate();
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "absent.zip",
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
      const record = {
        external_id: "archive-test-" + randomUUID(),
        source_entry: "unique-" + randomUUID(),
        metadata: { title: ["Example"] },
        chapters: [{ name: "chapter" }],
        objects: [
          {
            name: "chapter",
            kind: "chapter_html",
            data: Buffer.from("<p>Archive</p>").toString("base64"),
          },
        ],
        state: "valid",
        observed_at: null,
      };
      const e = {
        record,
        locator: "example.epub",
        parser: "test-1",
        cursor: 1,
      };
      await ingestRecord(source, e);
      await ingestRecord(source, e);
      const w = (
        await pool.query("SELECT * FROM archive_works WHERE external_id=$1", [
          record.external_id,
        ])
      ).rows[0];
      assert.ok(w.current_snapshot_id);
      assert.equal(
        (
          await pool.query("SELECT * FROM archive_snapshots WHERE work_id=$1", [
            w.id,
          ])
        ).rowCount,
        1,
      );
      await ingestRecord(source, {
        ...e,
        locator: "partial",
        cursor: 2,
        record: { ...record, state: "partial", objects: [], chapters: [] },
      });
      assert.equal(
        (
          await pool.query(
            "SELECT current_snapshot_id FROM archive_works WHERE id=$1",
            [w.id],
          )
        ).rows[0].current_snapshot_id,
        w.current_snapshot_id,
      );
      await assert.rejects(
        pool.query("DELETE FROM archive_snapshots WHERE work_id=$1", [w.id]),
      );
      const { projectCatalog, catalogOperation } = await import(
        "../apps/api/src/catalog"
      );
      await projectCatalog();
      const search = await import("../apps/api/src/catalog-search");
      while (await search.projectText()) {}
      await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh");
      await transaction(async (db) => {
        const list = await catalogOperation(db, "catalogWorks", {
          q: "Example",
        });
        assert.equal(list.items[0].id, w.id);
        assert.equal(list.items[0].metadata.kudos, undefined);
        const detail = await catalogOperation(db, "readerWork", { id: w.id });
        assert.equal(detail.snapshot, w.current_snapshot_id);
        const { downloadWork } = await import(
          "../apps/api/src/reader-download"
        );
        const bytes = async (download: any) =>
          Buffer.concat(
            (await download.stream.toArray()).map((part: any) =>
              Buffer.isBuffer(part) ? part : Buffer.from(part),
            ),
          );
        const html = await downloadWork(db, { id: w.id, format: "html" });
        assert.match((await bytes(html)).toString(), /<p>Archive<\/p>/);
        const epub = await downloadWork(db, { id: w.id, format: "epub" });
        const epubBytes = await bytes(epub);
        assert.equal(epubBytes.subarray(0, 2).toString(), "PK");
        const { spawnSync } = await import("node:child_process");
        const zipCheck = spawnSync(
          "python3",
          [
            "-c",
            "import sys,io,zipfile,xml.etree.ElementTree as E;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.read('mimetype')==b'application/epub+zip';[E.fromstring(z.read(n)) for n in z.namelist() if n.endswith(('.xhtml','.opf','.xml'))]",
          ],
          { input: epubBytes },
        );
        assert.equal(zipCheck.status, 0, zipCheck.stderr.toString());
        const pdf = await downloadWork(db, { id: w.id, format: "pdf" });
        assert.equal((await bytes(pdf)).subarray(0, 4).toString(), "%PDF");
        const content = await catalogOperation(db, "readerContent", {
          id: w.id,
          skin: "off",
        });
        assert.match(content.document, /<p>Archive<\/p>/);
        const historical = await catalogOperation(db, "readerWork", {
          id: w.id,
          snapshot: detail.versions.find((v: any) => v.state === "partial").id,
        });
        assert.equal(historical.manifest.state, "partial");
        await assert.rejects(
          catalogOperation(db, "readerWork", {
            id: w.id,
            snapshot: randomUUID(),
          }),
        );
        await assert.rejects(
          catalogOperation(db, "readerMedia", {
            id: w.id,
            hash: "0".repeat(64),
          }),
        );
      });
      // Operational filters and cursor pages use catalog facts, never only the visible UI page.
      await transaction(async (db) => {
        const current = await archiveOperation(db, "archiveWorks", {
          q: "Example",
          filter: "current",
        });
        assert.equal(
          current.items.find((item: any) => item.id === w.id)?.snapshots,
          2,
        );
        const missing = await archiveOperation(db, "archiveWorks", {
          q: "Example",
          filter: "missing",
        });
        assert.ok(!missing.items.some((item: any) => item.id === w.id));
        const running = await archiveOperation(db, "ingestBatches", {
          filter: "active",
        });
        assert.equal(
          running.items.find((item: any) => item.id === batch)?.sources,
          1,
        );
        const newer = randomUUID();
        await db.query(
          "INSERT INTO ingest_batches(id,state,created_at) VALUES($1,'paused',now()+interval '1 second')",
          [newer],
        );
        const first = await archiveOperation(db, "ingestBatches", {});
        assert.equal(first.items[0].id, newer);
        const next = await archiveOperation(db, "ingestBatches", {
          cursor: newer,
        });
        assert.equal(next.items[0].id, batch);
        const attention = await archiveOperation(db, "ingestBatches", {
          filter: "attention",
        });
        assert.deepEqual(
          attention.items.map((item: any) => item.id),
          [newer],
        );
        const storage = await archiveOperation(db, "archiveStorage", {});
        assert.equal(
          storage.kinds
            .reduce((sum: bigint, kind: any) => sum + BigInt(kind.objects), 0n)
            .toString(),
          storage.objects,
        );
        assert.ok(storage.total_bytes >= storage.available_bytes);
        const report = await archiveOperation(db, "ingestReport", {
          id: batch,
          path: "another.zip",
        });
        assert.deepEqual(report.issues, []);
      });
      const hash = sha(Buffer.from("<p>Archive</p>"));
      let db = await pool.connect();
      assert.equal((await readObject(db, hash)).toString(), "<p>Archive</p>");
      db.release();
      const provisional = [];
      for (const path of ["identity-one.zip", "identity-two.zip"]) {
        const s = { id: randomUUID(), path, fingerprint: "identity-fixture" };
        await pool.query(
          "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
          [s.id, batch, s.path, s.fingerprint],
        );
        await ingestRecord(s, {
          ...e,
          record: {
            ...record,
            external_id: null,
            source_entry: "same-entry.epub",
          },
        });
        provisional.push(
          (
            await pool.query(
              "SELECT work_id FROM archive_records WHERE source_path=$1",
              [path],
            )
          ).rows[0].work_id,
        );
      }
      assert.notEqual(provisional[0], provisional[1]);
      await transaction((db) =>
        archiveOperation(db, "archiveResolve", {
          id: provisional[0],
          requestId: randomUUID(),
          kind: "identity",
          target: provisional[1],
          reason: "verified matching identities",
        }),
      );
      await assert.rejects(
        transaction((db) =>
          archiveOperation(db, "archiveResolve", {
            id: provisional[1],
            requestId: randomUUID(),
            kind: "identity",
            target: provisional[0],
            reason: "cycle must be rejected",
          }),
        ),
      );
      await transaction((db) =>
        archiveOperation(db, "archiveResolve", {
          id: provisional[0],
          requestId: randomUUID(),
          kind: "unlink",
          target: "",
          reason: "restore independent identities",
        }),
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM archive_identity_links"))
          .rows[0].count,
        "0",
      );
      const countBefore = (
        await pool.query("SELECT count(*) FROM archive_objects")
      ).rows[0].count;
      await assert.rejects(
        ingestRecord(source, {
          ...e,
          locator: "bad-structure",
          cursor: 3,
          record: { ...record, chapters: [{ name: "missing" }] },
        }),
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM archive_objects")).rows[0]
          .count,
        countBefore,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT checkpoint FROM ingest_sources WHERE id=$1",
            [source.id],
          )
        ).rows[0].checkpoint,
        "2",
      );
      const changed = {
        ...record,
        objects: [
          {
            ...record.objects[0],
            data: Buffer.from("<p>Changed</p>").toString("base64"),
          },
        ],
      };
      await ingestRecord(
        { ...source, fingerprint: "second" },
        { ...e, record: changed, cursor: 4 },
      );
      await ingestRecord(
        { ...source, fingerprint: "third" },
        { ...e, cursor: 5 },
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_chapter_revisions r JOIN archive_chapters c ON c.id=r.chapter_id WHERE c.work_id=$1",
            [w.id],
          )
        ).rows[0].count,
        "2",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_snapshots WHERE work_id=$1",
            [w.id],
          )
        ).rows[0].count,
        "4",
      );
      await assert.rejects(
        transaction((db) =>
          archiveOperation(db, "archiveResolve", {
            id: w.id,
            requestId: randomUUID(),
            kind: "head",
            target: (record as any).external_id,
            reason: "test invalid target",
          }),
        ),
      );
      await ingestRecord(
        { ...source, fingerprint: "metadata-observation" },
        {
          ...e,
          record: {
            ...record,
            state: "metadata_only",
            objects: [],
            chapters: [],
          },
          cursor: 6,
        },
      );
      await ingestRecord(
        { ...source, fingerprint: "repeat-after-index" },
        { ...e, cursor: 7 },
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_snapshots WHERE work_id=$1 AND state='valid'",
            [w.id],
          )
        ).rows[0].count,
        "3",
      );
      const last = (
        await pool.query(
          "SELECT id FROM archive_snapshots WHERE work_id=$1 AND state='valid' ORDER BY imported_at DESC LIMIT 1",
          [w.id],
        )
      ).rows[0];
      await transaction((db) =>
        archiveOperation(db, "archiveResolve", {
          id: w.id,
          requestId: randomUUID(),
          kind: "head",
          target: last.id,
          reason: "verified fixture chronology",
        }),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT current_snapshot_id FROM archive_works WHERE id=$1",
            [w.id],
          )
        ).rows[0].current_snapshot_id,
        last.id,
      );
      const evidence = (
        await pool.query(
          "SELECT id,field,source_path,locator FROM archive_evidence_observations WHERE work_id=$1 LIMIT 1",
          [w.id],
        )
      ).rows[0];
      await transaction((db) =>
        archiveOperation(db, "archiveResolve", {
          id: w.id,
          requestId: randomUUID(),
          kind: "metadata",
          target: String(evidence.id),
          field: evidence.field,
          source: evidence.source_path,
          locator: evidence.locator,
          reason: "verified source evidence",
        }),
      );
      const event = (
        await pool.query(
          "SELECT id FROM archive_outbox WHERE event='archive.admin.resolved' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
      const { deliverArchiveEvent } = await import(
        "../apps/api/src/archive-queue"
      );
      await Promise.all([
        deliverArchiveEvent(event.id),
        deliverArchiveEvent(event.id),
      ]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_dispatch WHERE event_id=$1",
            [event.id],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_objects WHERE kind='admin_decision'",
          )
        ).rows[0].count,
        "1",
      );
      await assert.rejects(
        transaction((db) =>
          db.query(
            "INSERT INTO archive_metadata_data(hash) VALUES(decode($1,'hex'))",
            ["f".repeat(64)],
          ),
        ),
        { code: "23503" },
      );
      // Group publication stays invisible until every pack is sealed; failed groups
      // roll back the complete checkpoint and replay without duplicate objects.
      const groupedSource = {
        id: randomUUID(),
        path: "grouped.zip",
        fingerprint: "group-fixture",
      };
      await pool.query(
        "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
        [
          groupedSource.id,
          batch,
          groupedSource.path,
          groupedSource.fingerprint,
        ],
      );
      const grouped = [1, 2].map((n) => ({
        ...e,
        cursor: n,
        locator: "group-" + n,
        record: {
          ...record,
          external_id: "group-" + n,
          chapters: [
            {
              name: "chapter",
              source_url: "https://archiveofourown.org/works/1/chapters/1",
            },
          ],
        },
      }));
      const makeWriter = store.writer.bind(store);
      store.writer = () => {
        const writer = makeWriter(),
          finish = writer.finish.bind(writer);
        writer.finish = async () => {
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM archive_works WHERE external_id LIKE 'group-%'",
              )
            ).rows[0].count,
            "0",
          );
          await finish();
          throw Error("SIMULATED_COMMIT_INTERRUPTION");
        };
        return writer;
      };
      try {
        await assert.rejects(
          ingestRecords(groupedSource, grouped),
          /SIMULATED_COMMIT_INTERRUPTION/,
        );
      } finally {
        store.writer = makeWriter;
      }
      assert.equal(
        (
          await pool.query(
            "SELECT checkpoint FROM ingest_sources WHERE id=$1",
            [groupedSource.id],
          )
        ).rows[0].checkpoint,
        "0",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_works WHERE external_id LIKE 'group-%'",
          )
        ).rows[0].count,
        "0",
      );
      await ingestRecords(groupedSource, grouped);
      const groupedCount = (
        await pool.query("SELECT count(*) AS objects FROM archive_objects")
      ).rows[0].objects;
      await ingestRecords(groupedSource, grouped);
      assert.equal(
        (await pool.query("SELECT count(*) AS objects FROM archive_objects"))
          .rows[0].objects,
        groupedCount,
      );
      const groupedCheckpoint = (
        await pool.query(
          "SELECT checkpoint,duplicates FROM ingest_sources WHERE id=$1",
          [groupedSource.id],
        )
      ).rows[0];
      assert.equal(groupedCheckpoint.checkpoint, "2");
      assert.equal(groupedCheckpoint.duplicates, "2");
      const oldPack = (
        await pool.query("SELECT pack FROM archive_objects WHERE hash=$1", [
          hash,
        ])
      ).rows[0].pack;
      const lease = randomUUID();
      await pool.query(
        "INSERT INTO archive_pack_leases(id,pack,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [lease, oldPack],
      );
      const createWriter = store.writer.bind(store);
      store.writer = () => {
        const writer = createWriter(),
          finish = writer.finish.bind(writer);
        writer.finish = async () => {
          // A genuine reader must progress while compaction copies/verifies.
          await transaction(async (reader) => {
            await reader.query("SET LOCAL lock_timeout='1s'");
            assert.equal(
              (await readObject(reader, hash)).toString(),
              "<p>Archive</p>",
            );
          });
          return finish();
        };
        return writer;
      };
      try {
        await compactObjects(
          (
            await pool.query("SELECT hash FROM archive_objects WHERE pack=$1", [
              oldPack,
            ])
          ).rows.map((r) => r.hash),
        );
      } finally {
        store.writer = createWriter;
      }
      db = await pool.connect();
      assert.equal((await readObject(db, hash)).toString(), "<p>Archive</p>");
      db.release();
      const { maintenanceTick } = await import(
        "../apps/api/src/archive-maintenance"
      );
      async function collect() {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO archive_jobs(id,kind) VALUES($1,'collect')",
          [id],
        );
        for (let attempt = 0; attempt < 100; attempt++) {
          await maintenanceTick();
          const job = (
            await pool.query(
              "SELECT state,result FROM archive_jobs WHERE id=$1",
              [id],
            )
          ).rows[0];
          if (job.state !== "pending") {
            assert.equal(job.state, "completed", JSON.stringify(job.result));
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.fail("Maintenance did not acquire the worker lock");
      }
      await collect();
      assert.ok(await stat(join(root, "packs", oldPack)));
      await pool.query(
        "UPDATE archive_pack_leases SET expires_at=now()-interval '1 second' WHERE id=$1",
        [lease],
      );
      await collect();
      await assert.rejects(stat(join(root, "packs", oldPack)), {
        code: "ENOENT",
      });
      db = await pool.connect();
      assert.equal((await readObject(db, hash)).toString(), "<p>Archive</p>");
      db.release();
      // More than one query page of small objects must still form a full pack,
      // with the locator/checkpoint commit replayable after a stopped tick.
      const { archiveTransaction, preserve } = await import(
        "../apps/api/src/archive"
      );
      await archiveTransaction(async (db) => {
        await preserve(
          db,
          Array.from({ length: 1100 }, (_, i) => ({
            kind: "notes_html",
            bytes: Buffer.from("small preserved object " + i),
          })),
        );
      });
      const compactJob = randomUUID();
      await pool.query(
        "INSERT INTO archive_jobs(id,kind) VALUES($1,'compact')",
        [compactJob],
      );
      await maintenanceTick(() => true);
      assert.equal(
        (
          await pool.query("SELECT state FROM archive_jobs WHERE id=$1", [
            compactJob,
          ])
        ).rows[0].state,
        "running",
      );
      await maintenanceTick();
      const compacted = (
        await pool.query("SELECT state,result FROM archive_jobs WHERE id=$1", [
          compactJob,
        ])
      ).rows[0];
      assert.equal(compacted.state, "completed");
      assert.equal(
        Number(compacted.result.objects),
        Number(
          (await pool.query("SELECT count(*) FROM archive_objects")).rows[0]
            .count,
        ),
      );
      assert.equal(
        (await pool.query("SELECT count(DISTINCT pack) FROM archive_objects"))
          .rows[0].count,
        "1",
      );
      db = await pool.connect();
      assert.equal((await readObject(db, hash)).toString(), "<p>Archive</p>");
      db.release();
      // A → B → A in one COPY group must retain three acquisitions, two revisions.
      const historyId = "ordered-" + randomUUID();
      const ordered = ["A", "B", "A"].map((body, index) => ({
        ...e,
        cursor: 10 + index,
        locator: "same-work",
        parser: "ordered",
        record: {
          ...record,
          external_id: historyId,
          source_entry: historyId,
          chapters: [
            {
              name: "chapter",
              source_url: "https://archiveofourown.org/chapters/123",
            },
          ],
          objects: [
            {
              name: "chapter",
              kind: "chapter_html",
              data: Buffer.from(body).toString("base64"),
            },
          ],
          source_hash: sha(String(index)),
        },
      }));
      await ingestRecords(source, ordered);
      const history = (
        await pool.query(
          "SELECT s.manifest_hash FROM archive_snapshots s JOIN archive_works w ON w.id=s.work_id WHERE w.external_id=$1 ORDER BY s.imported_at,s.id",
          [historyId],
        )
      ).rows;
      assert.equal(history.length, 3);
      assert.equal(history[0].manifest_hash, history[2].manifest_hash);
      assert.notEqual(history[0].manifest_hash, history[1].manifest_hash);
      const observations = (
        await pool.query(
          "SELECT count(*) FROM archive_observations o JOIN archive_works w ON w.id=o.work_id WHERE w.external_id=$1",
          [historyId],
        )
      ).rows[0].count;
      await ingestRecords(
        { ...source, fingerprint: "new-source-fingerprint" },
        ordered,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_observations o JOIN archive_works w ON w.id=o.work_id WHERE w.external_id=$1",
            [historyId],
          )
        ).rows[0].count,
        observations,
      );
      // A committed later group must not hide a hole; replay must retain its
      // original counters even when batch boundaries change after restart.
      const parallelSource = {
        id: randomUUID(),
        path: "parallel.zip",
        fingerprint: "parallel",
      };
      await pool.query(
        "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
        [
          parallelSource.id,
          batch,
          parallelSource.path,
          parallelSource.fingerprint,
        ],
      );
      const independent = (cursor: number, previous: string) => ({
        ...e,
        cursor,
        previous,
        locator: "parallel-" + cursor,
        record: {
          ...record,
          external_id: "parallel-" + cursor,
          source_entry: "parallel-" + cursor,
        },
      });
      const second = independent(2, "1:0"),
        first = independent(1, "0:0");
      await ingestRecords(parallelSource, [second]);
      let progress = (
        await pool.query(
          "SELECT checkpoint,imported FROM ingest_sources WHERE id=$1",
          [parallelSource.id],
        )
      ).rows[0];
      assert.deepEqual(progress, { checkpoint: "0", imported: "0" });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ingest_progress WHERE source_id=$1",
            [parallelSource.id],
          )
        ).rows[0].count,
        "1",
      );
      await ingestRecords(parallelSource, [first, second]);
      progress = (
        await pool.query(
          "SELECT checkpoint,imported,duplicates FROM ingest_sources WHERE id=$1",
          [parallelSource.id],
        )
      ).rows[0];
      assert.deepEqual(progress, {
        checkpoint: "2",
        imported: "2",
        duplicates: "0",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ingest_progress WHERE source_id=$1",
            [parallelSource.id],
          )
        ).rows[0].count,
        "0",
      );
      // Separate writers race for identical bytes and metadata. Their catalog
      // locator remains unique and all committed manifests stay readable.
      await Promise.all(
        [3, 4, 5, 6].map((cursor) =>
          ingestRecords(parallelSource, [
            independent(cursor, cursor - 1 + ":0"),
          ]),
        ),
      );
      progress = (
        await pool.query(
          "SELECT checkpoint,imported FROM ingest_sources WHERE id=$1",
          [parallelSource.id],
        )
      ).rows[0];
      assert.deepEqual(progress, { checkpoint: "6", imported: "6" });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_objects WHERE hash=$1",
            [sha(Buffer.from("<p>Archive</p>"))],
          )
        ).rows[0].count,
        "1",
      );
      const saved = (
        await pool.query(
          "SELECT s.manifest_hash FROM archive_snapshots s JOIN archive_works w ON w.id=s.work_id WHERE w.external_id LIKE 'parallel-%'",
        )
      ).rows;
      for (const snapshot of saved)
        await transaction((db) => readObject(db, snapshot.manifest_hash));
      const { resetDevArchive } = await import(
        "../apps/api/src/archive-dev-reset"
      );
      const resetId = randomUUID();
      const resetInput = { requestId: resetId, confirmation: "RESET" };
      await assert.rejects(
        transaction((db) =>
          archiveOperation(db, "archiveDevReset", resetInput),
        ),
      );
      await assert.rejects(
        resetDevArchive(async () => {}),
        /DEV_ONLY/,
      );
      const userId = randomUUID();
      await pool.query(
        "INSERT INTO users(id,username,password_hash,role,preferences) VALUES($1,'reset-owner','preserved','Owner',$2)",
        [userId, { language: "it", theme: "dark", skin: "forest" }],
      );
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf,device,ip) VALUES($1,$2,'preserved-token','preserved-csrf','fixture','127.0.0.1')",
        [randomUUID(), userId],
      );
      const protectedTables = [
        "users",
        "sessions",
        "instance",
        "schema_migrations",
        "audit",
        "invites",
        "passkeys",
        "recovery_codes",
      ];
      const identitySnapshot = async () =>
        Promise.all(
          protectedTables.map(
            async (name) =>
              (
                await pool.query(
                  `SELECT to_jsonb(t) AS data FROM ${name} t ORDER BY to_jsonb(t)::text`,
                )
              ).rows,
          ),
        );
      const beforeReset = await identitySnapshot();
      await pool.query(
        "INSERT INTO personal_event_receipts SELECT id FROM archive_outbox LIMIT 1 ON CONFLICT DO NOTHING",
      );
      process.env.PALIMORA_DEV = "1";
      try {
        await pool.query(
          "INSERT INTO library_bookmarks(user_id,work_id) SELECT $1,id FROM archive_work_heads LIMIT 1",
          [userId],
        );
        await assert.rejects(
          transaction((db) =>
            archiveOperation(db, "archiveDevReset", resetInput),
          ),
          (e: any) => {
            assert.deepEqual(e.getResponse(), {
              code: "RESET_REFERENCED_DATA",
            });
            return true;
          },
        );
        await pool.query("DELETE FROM library_bookmarks WHERE user_id=$1", [
          userId,
        ]);
        await transaction((db) =>
          archiveOperation(db, "archiveDevReset", resetInput),
        );
        // A reference created after enqueue must also stop the worker transaction.
        await pool.query(
          "INSERT INTO library_bookmarks(user_id,work_id) SELECT $1,id FROM archive_work_heads LIMIT 1",
          [userId],
        );
        await resetDevArchive(async () => {
          throw Error("Must not reach queues");
        });
        assert.equal(
          (
            await pool.query(
              "SELECT result->>'code' AS code FROM archive_jobs WHERE id=$1",
              [resetId],
            )
          ).rows[0].code,
          "RESET_REFERENCED_DATA",
        );
        assert.equal(
          (await pool.query("SELECT count(*) FROM library_bookmarks")).rows[0]
            .count,
          "1",
        );
        assert.notEqual(
          (await pool.query("SELECT count(*) FROM archive_objects")).rows[0]
            .count,
          "0",
        );
        await pool.query("DELETE FROM library_bookmarks WHERE user_id=$1", [
          userId,
        ]);
        await transaction((db) =>
          archiveOperation(db, "archiveDevReset", resetInput),
        );
        assert.equal(
          (
            await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
              batch,
            ])
          ).rows[0].state,
          "paused",
        );
        await assert.rejects(
          transaction((db) =>
            archiveOperation(db, "archiveMaintenance", {
              requestId: randomUUID(),
              kind: "collect",
            }),
          ),
        );
        await resetDevArchive(async () => {
          throw Error("QUEUE_INTERRUPTED");
        });
        assert.equal(
          (
            await pool.query("SELECT state FROM archive_jobs WHERE id=$1", [
              resetId,
            ])
          ).rows[0].state,
          "failed",
        );
        assert.equal(
          (await pool.query("SELECT count(*) FROM archive_objects")).rows[0]
            .count,
          "0",
        );
        assert.ok((await readdir(join(root, "packs"))).length);
        await transaction((db) =>
          archiveOperation(db, "archiveDevReset", resetInput),
        );
        await resetDevArchive(async () => {});
        assert.equal(
          (
            await pool.query("SELECT state FROM archive_jobs WHERE id=$1", [
              resetId,
            ])
          ).rows[0].state,
          "completed",
        );
        assert.equal(
          (await pool.query("SELECT count(*) FROM ingest_batches")).rows[0]
            .count,
          "0",
        );
        assert.deepEqual(await readdir(join(root, "packs")), []);
        assert.deepEqual(await readdir(join(root, "staging")), []);
        assert.deepEqual(await identitySnapshot(), beforeReset);
      } finally {
        delete process.env.PALIMORA_DEV;
      }
    } finally {
      await (await import("../apps/api/src/reader-pdf")).closePdf();
      await pool.end();
      await setupPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await setupPool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
