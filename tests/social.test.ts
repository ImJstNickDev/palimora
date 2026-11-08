import test from "node:test";
import assert from "node:assert/strict";
import {
  randomUUID,
  createECDH,
  randomBytes,
  createPublicKey,
  verify,
} from "node:crypto";
import { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as webpush from "web-push";
test("Web Push uses authenticated encrypted payloads", () => {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  const subscription = {
    endpoint: "https://push.example.test/send/123",
    keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth },
  };
  const keys = webpush.generateVAPIDKeys();
  const req = webpush.generateRequestDetails(
    subscription,
    '{"url":"/notifications"}',
    { vapidDetails: { ...keys, subject: "https://palimora.example.test" } },
  );
  assert.match(String(req.headers.Authorization), /^vapid /);
  const jwt = String(req.headers.Authorization).match(/t=([^,]+)/)![1];
  const [header, claims, signature] = jwt.split(".");
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(header + "." + claims),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );

  assert.equal(req.headers["Content-Encoding"], "aes128gcm");
  const ece = require("http_ece");
  assert.equal(
    ece
      .decrypt(req.body, {
        version: "aes128gcm",
        privateKey: receiver,
        authSecret: auth,
      })
      .toString(),
    '{"url":"/notifications"}',
  );
});
test(
  "personal privacy, statistics, subscriptions, event aggregation and durable push delivery",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const setup = new Pool({ connectionString: url.toString() }),
      schema = "social_" + randomUUID().replaceAll("-", "");
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_KEY = "ab".repeat(32);
    process.env.APP_ORIGIN = "https://palimora.example.test";
    const root = await mkdtemp(join(tmpdir(), "palimora-social-"));
    process.env.ARCHIVE_ROOT = root;
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { socialOperation } = await import("../apps/api/src/social");
    const { processPersonalEvents, contentChange, createNotification } =
      await import("../apps/api/src/personal-notifications");
    const { deliverPush, validatePushEndpoint } = await import(
      "../apps/api/src/web-push"
    );
    const { seal } = await import("../apps/api/src/security");
    const { ingestRecord } = await import("../apps/api/src/archive");
    const { projectCatalog } = await import("../apps/api/src/catalog");
    try {
      await migrate();
      const chapter = { chapter_id: "one", hash: "same" };
      assert.deepEqual(
        contentChange(
          { chapters: [chapter], metadata: { kudos: 1 } },
          { chapters: [chapter], metadata: { kudos: 2 } },
        ),
        { chapters: false, changes: false },
      );
      assert.deepEqual(
        contentChange(
          { chapters: [chapter] },
          { chapters: [{ ...chapter, hash: "changed" }] },
        ),
        { chapters: false, changes: true },
      );
      assert.equal(
        contentChange(
          { chapters: [chapter] },
          { chapters: [chapter, { chapter_id: "two", hash: "new" }] },
        ).chapters,
        true,
      );

      const alice = randomUUID(),
        bob = randomUUID(),
        carol = randomUUID(),
        session = randomUUID();
      for (const [id, name] of [
        [alice, "alice"],
        [bob, "bob"],
        [carol, "carol"],
      ])
        await pool.query(
          "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'test','User')",
          [id, name],
        );
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf,device,ip) VALUES($1,$2,'test','test','test','127.0.0.1')",
        [session, alice],
      );
      const op = (name: string, input: any, user = alice) =>
        transaction((db) => socialOperation(db, name, input, user, session));
      await transaction(async (db) => {
        await db.query("SAVEPOINT recipient_directory");
        await db.query("UPDATE users SET disabled=true WHERE id=$1", [bob]);
        await db.query("UPDATE users SET soft_deleted_at=now() WHERE id=$1", [
          carol,
        ]);
        await db.query(`INSERT INTO users(id,username,password_hash,role)
          SELECT gen_random_uuid(),'reader'||lpad(n::text,3,'0'),'test','User' FROM generate_series(0,51) n`);
        const directory = (input = {}) =>
          socialOperation(
            db,
            "recommendationRecipients",
            input,
            alice,
            session,
          );
        const first = await directory();
        assert.equal(first.items.length, 50);
        assert.equal(first.items[0].username, "reader000");
        assert.equal(first.next, "reader049");
        assert.deepEqual(Object.keys(first.items[0]), ["username"]);
        const second = await directory({ cursor: first.next });
        assert.deepEqual(
          second.items.map((u: any) => u.username),
          ["reader050", "reader051"],
        );
        assert.equal(second.next, null);
        assert.equal((await directory({ q: "READER00" })).items.length, 10);
        assert.equal((await directory({ q: "%" })).items.length, 0);
        await db.query(
          "INSERT INTO personal_settings(user_id,recommendations) SELECT id,false FROM users WHERE username='reader000'",
        );
        assert.equal((await directory({ q: "reader000" })).items.length, 0);
        await db.query("ROLLBACK TO SAVEPOINT recipient_directory");
      });
      const p = await op("socialPreferences", {});
      await assert.rejects(
        op("personalStatistics", { username: "alice" }, bob),
      );
      await op("socialPreferencesSave", {
        ...p,
        statistics: "selected",
        statistics_users: ["bob"],
        push: true,
        grouping: 0,
      });
      await assert.rejects(
        op("personalStatistics", { username: "alice" }, bob),
      );
      assert.equal((await op("personalStatistics", {}, bob)).completed, 0);
      const privateSettings = await op("socialPreferences", {});
      assert.equal("statistics" in privateSettings, false);
      assert.equal("statistics_users" in privateSettings, false);
      await assert.rejects(op("personalActivity", { username: "alice" }, bob));
      await assert.rejects(
        op("personalStatistics", { username: "alice" }, carol),
      );
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "social.zip",
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
      const ingest = async (body: string, cursor: number) => {
        await ingestRecord(source, {
          parser: "social-test",
          locator: "work",
          cursor,
          record: {
            external_id: "52345",
            source_entry: "work",
            metadata: {
              title: ["Real work"],
              words: 42,
              ao3: {
                schema: "palimora-ao3-v1",
                authors: [{ id: "writer", name: "Writer" }],
                series: [{ id: "12", name: "Series" }],
              },
            },
            chapters: [{ name: "chapter" }],
            objects: [
              {
                name: "chapter",
                kind: "chapter_html",
                data: Buffer.from("<p>" + body + "</p>").toString("base64"),
              },
            ],
            state: "valid",
            observed_at: null,
          },
        });
        await projectCatalog();
        await projectCatalog();
      };
      await ingest("Original text.", 1);
      const work = (
          await pool.query(
            "SELECT id,current_snapshot_id FROM archive_work_heads",
          )
        ).rows[0],
        id = work.id,
        snapshot = work.current_snapshot_id;
      await processPersonalEvents();
      await pool.query(
        "INSERT INTO library_progress VALUES($1,$2,1,'completed',$3,100)",
        [alice, id, { snapshot }],
      );
      for (const revision of [1, 2])
        await pool.query(
          "INSERT INTO library_progress_versions(user_id,work_id,revision,state,anchor,percent) VALUES($1,$2,$3,'completed',$4,100)",
          [alice, id, revision, { snapshot }],
        );
      await pool.query(
        "INSERT INTO reading_intervals VALUES($1,$2,$3,tstzrange(now()-interval '20 seconds',now(),'[)')),($4,$2,$3,tstzrange(now()-interval '10 seconds',now(),'[)'))",
        [randomUUID(), alice, id, randomUUID()],
      );
      const stats = await op("personalStatistics", {});
      assert.equal(stats.completed, 1);
      assert.equal(stats.words, 42);
      await pool.query(
        "UPDATE catalog_snapshot_views SET metadata=metadata-'words' WHERE snapshot_id=$1",
        [snapshot],
      );
      assert.equal((await op("personalStatistics", {})).words, null);
      assert.equal((await op("personalStatistics", {})).unknown_words, 1);
      await pool.query(
        "UPDATE catalog_snapshot_views SET metadata=metadata||'{\"words\":42}'::jsonb WHERE snapshot_id=$1",
        [snapshot],
      );

      assert.ok(stats.seconds >= 20 && stats.seconds < 21);
      const beat = randomUUID();
      await op("readingHeartbeat", { id, requestId: beat });
      await op("readingHeartbeat", { id, requestId: beat });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM reading_intervals WHERE id=$1",
            [beat],
          )
        ).rows[0].count,
        "1",
      );
      await op("readingHeartbeat", {
        id,
        requestId: randomUUID(),
        active: false,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM reading_heartbeat WHERE session_id=$1",
            [session],
          )
        ).rows[0].count,
        "0",
      );
      await op("subscriptionSave", {
        kind: "work",
        target: id,
        mode: "changes",
      });
      const entities = (
        await pool.query(
          "SELECT id,kind FROM catalog_entities WHERE kind IN ('author','series')",
        )
      ).rows;
      for (const e of entities)
        await op("subscriptionSave", {
          kind: e.kind,
          target: e.id,
          mode: "changes",
        });
      const device = randomUUID();
      await pool.query(
        "INSERT INTO push_devices(id,user_id,session_id,endpoint_hash,subscription,name) VALUES($1,$2,$3,$4,$5,$6)",
        [
          device,
          alice,
          session,
          "hash",
          seal(
            JSON.stringify({
              endpoint: "https://push.example.test/test",
              keys: {},
            }),
          ),
          "test",
        ],
      );
      await ingest("Changed text.", 2);
      const next = (
        await pool.query("SELECT id FROM archive_snapshot_data WHERE id<>$1", [
          snapshot,
        ])
      ).rows[0].id;
      // The fixture deliberately publishes a validated revision, using the production event contract.
      await pool.query(
        "INSERT INTO archive_outbox(event,payload) VALUES('work.snapshot.published',$1)",
        [{ work_id: id, snapshot_id: next }],
      );
      await processPersonalEvents();
      await processPersonalEvents();
      assert.equal(
        (await op("notifications", { unread: "false" })).items.length,
        1,
      );
      let sent = 0;
      await deliverPush(async () => {
        sent++;
        return { status: 503, retry: "120" };
      });
      assert.equal(sent, 1);
      assert.equal(
        (await pool.query("SELECT attempts FROM push_deliveries")).rows[0]
          .attempts,
        1,
      );
      await pool.query("UPDATE push_deliveries SET next_at=now()");
      await deliverPush(async () => {
        sent++;
        return { status: 201 };
      });
      await deliverPush(async () => {
        sent++;
        return { status: 201 };
      });
      assert.equal(sent, 2);
      const notice = (await op("notifications", { unread: "false" })).items[0];
      await assert.rejects(
        op("notificationRead", { id: notice.id, read: true }, bob),
      );
      await op("notificationRead", { id: notice.id, read: true });
      assert.equal((await op("notifications", { unread: "true" })).unread, 0);
      const recommendation = {
        requestId: randomUUID(),
        work: id,
        username: "alice",
        note: "Private recommendation",
      };
      const carolPreferences = await op("socialPreferences", {}, carol);
      await op(
        "socialPreferencesSave",
        { ...carolPreferences, recommendations: false },
        carol,
      );
      await assert.rejects(
        op("recommendWork", { ...recommendation, username: "carol" }, bob),
      );
      await op("recommendWork", recommendation, bob);
      await op("recommendWork", recommendation, bob);
      assert.equal(
        (await op("notifications", { unread: "false" })).items.length,
        2,
      );
      assert.equal(
        (await op("notifications", { unread: "false" }, carol)).items.length,
        0,
      );
      await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
        session,
      ]);
      await deliverPush(async () => {
        throw Error("Revoked session must not send");
      });
      assert.equal(
        (await pool.query("SELECT count(*) FROM push_devices")).rows[0].count,
        "0",
      );
      await assert.rejects(validatePushEndpoint("http://localhost/push"));
      await assert.rejects(validatePushEndpoint("https://127.0.0.1/push"));
      const latest = await op("socialPreferences", {});
      await op("socialPreferencesSave", { ...latest, statistics: "private" });
      await assert.rejects(
        op("personalStatistics", { username: "alice" }, bob),
      );
      await transaction(async (db) => {
        await db.query("SAVEPOINT grouping");
        await createNotification(db, alice, "update", id, null, 3600);
        await createNotification(db, alice, "update", id, null, 3600);
        const grouped = (
          await db.query(
            "SELECT versions FROM personal_notifications WHERE user_id=$1 AND kind='update' AND bucket>0",
            [alice],
          )
        ).rows;
        assert.equal(grouped[0].versions, 2);
        await db.query("ROLLBACK TO SAVEPOINT grouping");
      });
      const producer = await pool.connect();
      try {
        await producer.query("BEGIN");
        await producer.query(
          "INSERT INTO archive_outbox(event,payload,created_at) VALUES('work.snapshot.published',$1,now()-interval '1 day')",
          [{ work_id: id, snapshot_id: snapshot }],
        );
        await op(
          "subscriptionSave",
          { kind: "work", target: id, mode: "changes" },
          bob,
        );
        await producer.query("COMMIT");
      } finally {
        producer.release();
      }
      await processPersonalEvents();
      assert.equal(
        (await op("notifications", { unread: "false" }, bob)).items.length,
        1,
        "An in-flight publication is delivered after commit even if its transaction timestamp predates the subscription",
      );
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
