import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test(
  "full and platform backups restore real PostgreSQL, immutable histories and user references; retries and faults are safe",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "palimora-backup-engine-"));
    const base = process.env.TEST_DATABASE_URL!;
    assert.match(new URL(base).pathname, /test/);
    process.env.DATABASE_URL = base;
    process.env.ARCHIVE_ROOT = join(root, "source");
    const { pool, migrate } = await import("../apps/api/src/db");
    const { ingestRecord } = await import("../apps/api/src/archive");
    const { createBackup, restoreBackup, inspectBackup } = await import(
      "../apps/api/src/backup-engine"
    );
    const peers: Pool[] = [];
    const schemas: string[] = [];
    async function destination() {
      const schema = "backup_test_" + randomUUID().replaceAll("-", "");
      schemas.push(schema);
      await pool.query(`CREATE DATABASE ${schema}`);
      const url = new URL(base);
      url.pathname = "/" + schema;
      const db = new Pool({ connectionString: url.toString() });
      peers.push(db);
      return db;
    }
    try {
      await migrate();
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "synthetic.zip",
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
      async function ingest(text: string, id = "123") {
        await ingestRecord(source, {
          locator: text,
          parser: "backup-fixture-v1",
          cursor: 1,
          record: {
            external_id: id,
            source_entry: id,
            metadata: { title: ["Backup fixture"] },
            state: "valid",
            observed_at: null,
            chapters: [{ name: "chapter" }],
            objects: [
              {
                name: "chapter",
                kind: "chapter_html",
                data: Buffer.from("<p>" + text + "</p>").toString("base64"),
              },
              {
                name: "image",
                kind: "asset",
                data: Buffer.from("test image bytes").toString("base64"),
              },
            ],
          },
        });
      }
      await ingest("old");
      await ingest("new");
      const work = (
        await pool.query("SELECT * FROM archive_works WHERE external_id='123'")
      ).rows[0];
      assert.equal(
        (await pool.query("SELECT count(*) FROM archive_snapshots")).rows[0]
          .count,
        "2",
      );
      const backupRoot = join(root, "backups");
      await import("node:fs/promises").then((fs) => fs.mkdir(backupRoot));
      await writeFile(
        join(backupRoot, ".palimora-backup-target"),
        "test-target",
      );
      const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .map((l) => l.split(" "));
      const mount = mounts
        .filter((p) => backupRoot.startsWith(p[4] + "/") || p[4] === "/")
        .sort((a, b) => b[4].length - a[4].length)[0];
      const target = {
        name: "test",
        path: backupRoot,
        marker: "test-target",
        device: mount[2],
        reserveBytes: 0,
      };
      const config = {
        authKey: "a".repeat(64),
        origin: "https://fixture.invalid",
        settings: { ARCHIVE_ZSTD_LEVEL: "3" },
      };
      const common = {
        database: pool,
        storage: process.env.ARCHIVE_ROOT!,
        target,
        config,
        volumeBytes: 4096,
      };
      const corpus = await createBackup({
        ...common,
        id: randomUUID(),
        kind: "full",
      });
      const user = randomUUID(),
        collection = randomUUID(),
        annotation = randomUUID();
      process.env.AUTH_KEY = config.authKey;
      const { hashPassword, seal, unseal } = await import(
        "../apps/api/src/security"
      );
      await pool.query(
        "INSERT INTO users(id,username,password_hash,role,totp_secret) VALUES($1,'owner',$2,'Owner',$3)",
        [
          user,
          await hashPassword("fixture-password-for-restore"),
          seal("test-totp-secret"),
        ],
      );
      await pool.query("SELECT setval('audit_id_seq',9007199254740993,true)");
      await pool.query(
        "INSERT INTO audit(actor_id,ip,action,request_id) VALUES($1,'127.0.0.1','backup.fixture',$2)",
        [user, randomUUID()],
      );
      await pool.query(
        "UPDATE instance SET state='active',initialized_at=now(),name='test'",
      );
      await pool.query(
        "INSERT INTO library_bookmarks(user_id,work_id,notes) VALUES($1,$2,'private note')",
        [user, work.id],
      );
      await pool.query("SELECT set_config('palimora.user',$1,false)", [user]);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('palimora.user',$1,true)", [user]);
        await c.query(
          "INSERT INTO library_collections(id,owner_id,name) VALUES($1,$2,'Collection')",
          [collection, user],
        );
        await c.query("INSERT INTO library_collection_works VALUES($1,$2)", [
          collection,
          work.id,
        ]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const chapter = (
        await pool.query("SELECT id FROM archive_chapters WHERE work_id=$1", [
          work.id,
        ])
      ).rows[0].id;
      const anchor = {
        snapshot: work.current_snapshot_id,
        chapter,
        offset: 0,
        quote: "new",
        prefix: "",
        suffix: "",
      };
      await pool.query(
        "INSERT INTO library_progress(user_id,work_id,state,anchor,percent) VALUES($1,$2,'reading',$3,40)",
        [user, work.id, anchor],
      );
      await pool.query(
        "INSERT INTO library_annotations(id,user_id,work_id,anchor,body) VALUES($1,$2,$3,$4,$5)",
        [annotation, user, work.id, anchor, "preserved annotation"],
      );
      await pool.query(
        "INSERT INTO library_annotation_versions(id,revision,anchor,body,deleted) VALUES($1,1,$2,$3,false)",
        [annotation, anchor, "old annotation"],
      );
      await pool.query(
        "INSERT INTO personal_notifications(user_id,kind,work_id,bucket) VALUES($1,'update',$2,1)",
        [user, work.id],
      );
      await pool.query(
        "INSERT INTO personal_subscriptions(user_id,kind,target,mode) VALUES($1,'work',$2,'changes')",
        [user, work.id],
      );
      await ingest("post-subscription");
      const pendingSnapshot = (
        await pool.query(
          "SELECT id FROM archive_snapshots WHERE work_id=$1 ORDER BY imported_at DESC LIMIT 1",
          [work.id],
        )
      ).rows[0].id;
      const pendingEvent = (
        await pool.query(
          "INSERT INTO archive_outbox(event,payload) VALUES('work.snapshot.published',$1) RETURNING id",
          [{ work_id: work.id, snapshot_id: pendingSnapshot }],
        )
      ).rows[0].id;
      await ingest("absent from compatible corpus", "456");
      const absent = (
        await pool.query("SELECT id FROM archive_works WHERE external_id='456'")
      ).rows[0].id;
      await pool.query(
        "INSERT INTO library_bookmarks(user_id,work_id,notes) VALUES($1,$2,'unresolved')",
        [user, absent],
      );
      await assert.rejects(
        createBackup({
          ...common,
          config: { ...config, authKey: "b".repeat(64) },
          id: randomUUID(),
          kind: "full",
        }),
        /BACKUP_AUTH_KEY_MISMATCH/,
      );
      const full = await createBackup({
        ...common,
        id: randomUUID(),
        kind: "full",
      });
      assert.deepEqual(
        await createBackup({ ...common, id: full.id, kind: "full" }),
        full,
      );
      const platform = await createBackup({
        ...common,
        id: randomUUID(),
        kind: "platform",
      });
      const meta = await inspectBackup(target, full.id);
      assert.ok(meta.files > 20);
      const restored = await destination(),
        restoredRoot = join(root, "restored");
      await assert.rejects(
        restoreBackup({
          database: restored,
          target,
          id: full.id,
          storage: restoredRoot,
          confirmation: "wrong",
        }),
        /RESTORE_CONFIRMATION_REQUIRED/,
      );
      const { rename } = await import("node:fs/promises");
      await rename(common.storage, common.storage + "-unavailable");
      let restoreChecks = 0;
      await assert.rejects(
        restoreBackup({
          database: restored,
          target,
          id: full.id,
          storage: restoredRoot,
          confirmation: meta.confirmation,
          stopped: () => ++restoreChecks > 10,
        }),
        /RESTORE_INTERRUPTED/,
      );
      assert.equal(
        (
          await restored.query(
            "SELECT count(*) FROM pg_tables WHERE schemaname=current_schema()",
          )
        ).rows[0].count,
        "0",
      );
      const report = await restoreBackup({
        database: restored,
        target,
        id: full.id,
        storage: restoredRoot,
        confirmation: meta.confirmation,
      });
      assert.equal(report.unresolved.length, 0);
      await rename(common.storage + "-unavailable", common.storage);
      assert.equal(
        unseal(
          (await restored.query("SELECT totp_secret FROM users")).rows[0]
            .totp_secret,
          Buffer.from(config.authKey, "hex"),
        ),
        "test-totp-secret",
      );
      for (const table of [
        "users",
        "audit",
        "archive_snapshots",
        "archive_chapter_revisions",
        "archive_works",
        "archive_objects",
        "library_bookmarks",
        "library_annotations",
        "library_annotation_versions",
        "library_progress",
        "library_collections",
        "personal_notifications",
      ]) {
        const sql = `SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`;
        assert.deepEqual(
          (await restored.query(sql)).rows,
          (await pool.query(sql)).rows,
          table,
        );
      }
      assert.deepEqual(
        await restoreBackup({
          database: restored,
          target,
          id: full.id,
          storage: restoredRoot,
          confirmation: meta.confirmation,
        }),
        report,
      );
      assert.ok(
        (
          await restored.query(
            "SELECT 1 FROM backup_notification_eligibility WHERE event_id=$1 AND user_id=$2",
            [pendingEvent, user],
          )
        ).rowCount,
      );
      const { execFileSync } = await import("node:child_process");
      execFileSync(
        join(process.cwd(), "node_modules/.bin/tsx"),
        [
          "-e",
          `(async()=>{const {projectCatalog}=require('./apps/api/src/catalog');const {processPersonalEvents}=require('./apps/api/src/personal-notifications');const {pool}=require('./apps/api/src/db');try{while((await pool.query('SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending) AS n')).rows[0].n!=='0') await projectCatalog();await processPersonalEvents();await processPersonalEvents();}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;})`,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: (restored as any).options.connectionString,
            ARCHIVE_ROOT: restoredRoot,
          },
          stdio: "pipe",
        },
      );
      assert.equal(
        (
          await restored.query(
            "SELECT count(*) FROM personal_event_receipts WHERE event_id=$1",
            [pendingEvent],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await restored.query(
            "SELECT count(*) FROM personal_notification_versions WHERE snapshot_id=$1 AND user_id=$2",
            [pendingSnapshot, user],
          )
        ).rows[0].count,
        "1",
      );
      const platformDb = await destination(),
        platformRoot = join(root, "platform");
      await restoreBackup({
        database: platformDb,
        target,
        id: corpus.id,
        storage: platformRoot,
        confirmation: "RESTORE " + corpus.hash,
      });
      const mappedWork = randomUUID();
      const remap = await platformDb.connect();
      try {
        await remap.query("BEGIN");
        const fks = (
          await remap.query(
            "SELECT conname,conrelid::regclass::text AS rel,condeferrable,condeferred FROM pg_constraint WHERE contype='f' AND confrelid='archive_work_heads'::regclass",
          )
        ).rows;
        const rels = [...new Set(fks.map((f) => f.rel))];
        for (const rel of rels)
          await remap.query(`ALTER TABLE ${rel} DISABLE TRIGGER USER`);
        for (const fk of fks)
          await remap.query(
            `ALTER TABLE ${fk.rel} ALTER CONSTRAINT "${fk.conname}" DEFERRABLE INITIALLY DEFERRED`,
          );
        for (const fk of fks) {
          const col = (
            await remap.query(
              "SELECT a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE c.conname=$1 AND c.conrelid=$2::regclass",
              [fk.conname, fk.rel],
            )
          ).rows[0].attname;
          await remap.query(
            `UPDATE ${fk.rel} SET "${col}"=$1 WHERE "${col}"=$2`,
            [mappedWork, work.id],
          );
        }
        await remap.query("UPDATE archive_work_heads SET id=$1 WHERE id=$2", [
          mappedWork,
          work.id,
        ]);
        await remap.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const fk of fks)
          await remap.query(
            `ALTER TABLE ${fk.rel} ALTER CONSTRAINT "${fk.conname}" ${fk.condeferrable ? "DEFERRABLE" : "NOT DEFERRABLE"} INITIALLY ${fk.condeferred ? "DEFERRED" : "IMMEDIATE"}`,
          );
        for (const rel of rels)
          await remap.query(`ALTER TABLE ${rel} ENABLE TRIGGER USER`);
        await remap.query("COMMIT");
      } catch (e) {
        await remap.query("ROLLBACK");
        throw e;
      } finally {
        remap.release();
      }
      const personal = await restoreBackup({
        database: platformDb,
        target,
        id: platform.id,
        storage: platformRoot,
        confirmation: "RESTORE " + platform.hash,
      });
      assert.equal(personal.unresolved.length, 1);
      assert.equal(
        (await platformDb.query("SELECT work_id FROM library_bookmarks"))
          .rows[0].work_id,
        mappedWork,
      );
      assert.deepEqual(
        (await platformDb.query("SELECT id::text FROM audit")).rows,
        (await pool.query("SELECT id::text FROM audit")).rows,
      );
      assert.equal(personal.unresolved[0].table, "library_bookmarks");
      assert.equal(
        (await platformDb.query("SELECT count(*) FROM archive_snapshots"))
          .rows[0].count,
        "2",
      );
      assert.equal(
        (await platformDb.query("SELECT count(*) FROM library_bookmarks"))
          .rows[0].count,
        "1",
      );
      assert.deepEqual(
        (await platformDb.query("SELECT anchor FROM library_annotations"))
          .rows[0].anchor,
        anchor,
      );
      const another = await createBackup({
        ...common,
        id: randomUUID(),
        kind: "platform",
      });
      await assert.rejects(
        restoreBackup({
          database: platformDb,
          target,
          id: another.id,
          storage: platformRoot,
          confirmation: "RESTORE " + another.hash,
        }),
        /RESTORE_USERS_EXIST/,
      );
      await assert.rejects(
        createBackup({
          ...common,
          target: { ...target, device: "9999:9999" },
          id: randomUUID(),
          kind: "full",
        }),
        /BACKUP_MOUNT_UNAVAILABLE/,
      );
      const interrupted = randomUUID();
      let checks = 0;
      await assert.rejects(
        createBackup({
          ...common,
          id: interrupted,
          kind: "full",
          stopped: () => ++checks > 5,
        }),
        /BACKUP_INTERRUPTED/,
      );
      await createBackup({ ...common, id: interrupted, kind: "full" });
      const packedRetry = randomUUID();
      const { existsSync } = await import("node:fs");
      await assert.rejects(
        createBackup({
          ...common,
          id: packedRetry,
          kind: "full",
          stopped: () =>
            existsSync(join(backupRoot, packedRetry, "capture.json")),
        }),
        /BACKUP_INTERRUPTED/,
      );
      const captured = JSON.parse(
        await readFile(join(backupRoot, packedRetry, "capture.json"), "utf8"),
      ).captured_at;
      await rename(
        join(common.storage, "packs"),
        join(common.storage, "packs-unavailable"),
      );
      try {
        await createBackup({ ...common, id: packedRetry, kind: "full" });
      } finally {
        await rename(
          join(common.storage, "packs-unavailable"),
          join(common.storage, "packs"),
        );
      }
      assert.equal(
        JSON.parse(
          await readFile(join(backupRoot, packedRetry, "capture.json"), "utf8"),
        ).captured_at,
        captured,
      );
      const noSpace = randomUUID();
      await assert.rejects(
        createBackup({
          ...common,
          target: { ...target, reserveBytes: Number.MAX_SAFE_INTEGER },
          id: noSpace,
          kind: "full",
        }),
        { code: "ENOSPC" },
      );
      assert.ok(!(await readdir(backupRoot)).includes(noSpace));
      console.log(
        JSON.stringify({
          full: { files: meta.files, bytes: meta.bytes },
          restored: report.restored,
          platform: personal.restored,
          unresolved: personal.unresolved.length,
        }),
      );
    } finally {
      for (const p of peers) await p.end();
      for (const s of schemas) await pool.query(`DROP DATABASE ${s}`);
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
