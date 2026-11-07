import {
  parseWork,
  workAvailability,
  listing,
  parseComments,
} from "../apps/api/src/ao3-parser";
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function page(body = "Original text", title = "An observed work") {
  return `<html><head><title>${title} - Archive of Our Own</title></head><body>
<dl class="work meta group"><dd class="fandom tags"><a class="tag" href="/tags/Space/works">Space</a></dd><dd class="language">English</dd>
<dd class="chapters">1/1</dd><dd class="words">2</dd><dd class="kudos">0</dd><dd class="published">2026-11-01</dd></dl>
<div id="workskin"><div class="preface group"><h2 class="title heading">${title}</h2><h3 class="byline heading"><a href="/users/Ada/pseuds/Ada">Ada</a></h3></div>
<div id="chapters"><div class="userstuff"><p>${body}</p></div></div></div></body></html>`;
}
test("remote parser refuses incomplete works and distinguishes absence from deletion", async () => {
  process.env.DATABASE_URL ??=
    process.env.TEST_DATABASE_URL ?? "postgresql://localhost/palimora_test";
  const { permittedByRobots } = await import("../apps/api/src/ao3-client");
  const { publicAddress } = await import("../apps/api/src/ao3-media");
  const { cssMediaURLs } = await import("../apps/api/src/ao3-media-urls");
  assert.deepEqual(
    cssMediaURLs(
      '@import "nested.css"; p {background: url(../image.png)}',
      "https://media.example.test/css/main.css",
    ),
    [
      "https://media.example.test/css/nested.css",
      "https://media.example.test/image.png",
    ],
  );
  const responsive = parseWork(
    "123",
    page(
      '<img srcset="https://media.example.test/a.png 1x, https://media.example.test/b.png 2x">',
    ),
  );
  assert.deepEqual(responsive.media_urls, [
    "https://media.example.test/a.png",
    "https://media.example.test/b.png",
  ]);
  const comments = parseComments(
    '<ol class="thread"><li id="comment_1"><h4 class="byline">Guest<span class="datetime">2026-11-07</span></h4><blockquote class="userstuff">A comment</blockquote></li><li><ol class="thread"><li id="comment_2"><h4 class="byline"><a href="/users/Ada">Ada</a></h4><blockquote class="userstuff">Reply</blockquote><a href="/comments/1">Parent</a></li></ol></li><li><a href="/comments/2">3 more comments in this thread</a></li></ol>',
  );
  assert.equal(comments.comments[1].parent_id, "1");
  assert.equal(comments.comments[0].author, "Guest");
  assert.deepEqual(comments.threads, ["/comments/2"]);
  const record = parseWork("123", page());
  assert.equal(record.chapters.length, 1);
  assert.equal(record.metadata.ao3.complete, true);
  assert.equal(record.metadata.ao3.statistics.kudos, 0);
  assert.throws(
    () => parseWork("123", page().replace("1/1", "2/3")),
    /AO3_INCOMPLETE_CHAPTERS/,
  );
  assert.equal(workAvailability(404, "Not found"), "temporarily_unavailable");
  assert.equal(workAvailability(200, "This work has been deleted"), "deleted");
  assert.equal(
    workAvailability(200, "This work is only available to registered users"),
    "hidden_or_restricted",
  );
  assert.deepEqual(
    listing('<ol class="work index group"><li id="work_123"></li></ol>'),
    { ids: ["123"], nextPage: null },
  );
  assert.throws(() => listing("<h1>Maintenance</h1>"));
  assert.equal(
    permittedByRobots(
      "User-agent: *\nDisallow: /works\nAllow: /works/123",
      "/works/12",
    ),
    false,
  );
  assert.equal(
    permittedByRobots(
      "User-agent: *\nDisallow: /works\nAllow: /works/123",
      "/works/123",
    ),
    true,
  );
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "100.64.0.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(
    permittedByRobots("User-agent: *\nDisallow: /works?", "/works?page=2"),
    false,
  );
  assert.equal(
    permittedByRobots(
      "User-agent: *\nDisallow: /works?",
      "/works/123?view_full_work=true",
    ),
    true,
  );
});
test(
  "discovery, durable work execution, atomic revisions, watch and outage recovery",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!),
      schema = "sync_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = url.toString();
    const root = await mkdtemp(join(tmpdir(), "palimora-sync-"));
    process.env.ARCHIVE_ROOT = root;
    // Imports above load db eagerly; configure the shared pool explicitly for this isolated test.
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    (pool as any).options.connectionString = url.toString();
    const { store, readObject } = await import("../apps/api/src/archive");
    (store as any).root = root;
    const { executeSync } = await import("../apps/api/src/ao3-worker");
    const { recordAO3Open } = await import("../apps/api/src/ao3-monitor");
    const { scheduleSync } = await import("../apps/api/src/ao3-scheduler");
    const fetchOriginal = globalThis.fetch;
    let html = page(),
      requests = 0,
      status = 200;
    try {
      await migrate();
      await pool.query("UPDATE ao3_control SET mode='force_online'");
      globalThis.fetch = async (input: any) => {
        requests++;
        await pool.query("UPDATE ao3_control SET next_request_at=now()");
        const path = new URL(String(input)).pathname;
        return path === "/robots.txt"
          ? new Response("User-agent: *\nAllow: /")
          : path === "/works"
            ? new Response(
                '<ol class="work index group"><li id="work_123"></li></ol>',
              )
            : new Response(html, { status });
      };
      const discovery = (
        await pool.query("SELECT id FROM ao3_jobs WHERE kind='discovery'")
      ).rows[0];
      await executeSync(discovery.id);
      assert.ok(
        (
          await pool.query("SELECT checkpoint FROM ao3_jobs WHERE id=$1", [
            discovery.id,
          ])
        ).rows[0].checkpoint.watermark,
      );
      const job = (
        await pool.query(
          "SELECT * FROM ao3_jobs WHERE kind='work' AND target='123'",
        )
      ).rows[0];
      assert.ok(job);
      await executeSync(job.id);
      let head = (
        await pool.query(
          "SELECT * FROM archive_work_heads WHERE external_id='123'",
        )
      ).rows[0];
      assert.ok(head.current_snapshot_id);
      const original = head.current_snapshot_id;
      const snapshots = async () =>
        Number(
          (await pool.query("SELECT count(*) FROM archive_snapshot_data"))
            .rows[0].count,
        );
      assert.equal(await snapshots(), 1);
      const due = async () =>
        pool.query(
          "UPDATE ao3_jobs SET due_at=now(),started_at=now()-interval '2 hours' WHERE id=$1",
          [job.id],
        );
      await due();
      await executeSync(job.id);
      assert.equal(
        await snapshots(),
        1,
        "unchanged observation does not create a version",
      );
      html = page("Changed silently", "Revised title");
      await due();
      await executeSync(job.id);
      head = (
        await pool.query(
          "SELECT * FROM archive_work_heads WHERE external_id='123'",
        )
      ).rows[0];
      assert.notEqual(head.current_snapshot_id, original);
      assert.equal(await snapshots(), 2);
      const revised = head.current_snapshot_id;
      html = page().replace("1/1", "2/3");
      await due();
      await executeSync(job.id);
      assert.equal(
        (await pool.query("SELECT current_snapshot_id FROM archive_work_heads"))
          .rows[0].current_snapshot_id,
        revised,
      );
      assert.equal(
        (await pool.query("SELECT error FROM ao3_jobs WHERE id=$1", [job.id]))
          .rows[0].error,
        "AO3_INCOMPLETE_CHAPTERS",
      );
      html = page();
      await due();
      await executeSync(job.id);
      assert.equal(
        await snapshots(),
        3,
        "A→B→A preserves a new observation/version",
      );
      const historical = (
        await pool.query(
          "SELECT encode(manifest_hash,'hex') AS hash FROM archive_snapshot_data WHERE id=$1",
          [original],
        )
      ).rows[0];
      const manifest = await transaction(async (db) =>
        JSON.parse((await readObject(db, historical.hash)).toString()),
      );
      assert.deepEqual(manifest.metadata.title, ["An observed work"]);
      await transaction((db) => recordAO3Open(db, head.id));
      await scheduleSync();
      const before = requests;
      await executeSync(job.id);
      assert.equal(
        requests,
        before,
        "watch does not bypass one-hour start floor",
      );
      await pool.query("UPDATE ao3_control SET mode='force_offline'");
      await due();
      await executeSync(job.id);
      assert.equal(requests, before);
      await pool.query(
        "UPDATE ao3_control SET mode='auto',observed_state='online'",
      );
      status = 429;
      await executeSync(job.id);
      assert.equal(
        (await pool.query("SELECT observed_state FROM ao3_control")).rows[0]
          .observed_state,
        "rate_limited",
      );
      const limited = requests;
      await pool.query("UPDATE ao3_control SET mode='force_online'");
      await due();
      await executeSync(job.id);
      assert.equal(requests, limited);

      // Service authentication is encrypted, origin-bound, and invalidated on removal.
      process.env.AUTH_KEY = "1".repeat(64);
      const { syncAdmin } = await import("../apps/api/src/ao3-admin");
      const { AO3Client } = await import("../apps/api/src/ao3-client");
      await pool.query(
        "UPDATE ao3_control SET cooldown_until=NULL,next_request_at=now(),observed_state='online'",
      );
      await transaction((db) =>
        syncAdmin(db, "ao3Account", {
          remove: false,
          username: "service",
          password: "fixture-password",
        }),
      );
      globalThis.fetch = async (input: any, options: any) => {
        await pool.query("UPDATE ao3_control SET next_request_at=now()");
        const path = new URL(String(input)).pathname;
        if (path === "/users/login" && options.method === "GET")
          return new Response(
            '<input name="authenticity_token" value="fixture-token">',
            {
              headers: { "set-cookie": "session=challenge; Secure; HttpOnly" },
            },
          );
        if (path === "/users/login") {
          assert.match(options.headers.Cookie, /session=challenge/);
          assert.match(options.body, /fixture-password/);
          return new Response("", {
            status: 302,
            headers: {
              location: "/",
              "set-cookie": "session=authenticated; Secure; HttpOnly",
            },
          });
        }
        if (path === "/")
          return new Response('<a href="/users/logout">Log out</a>');
        assert.match(options.headers.Cookie, /session=authenticated/);
        return new Response(page());
      };
      const client = new AO3Client();
      await client.get("/works/123");
      const account = (
        await pool.query("SELECT credentials,auth_state FROM ao3_control")
      ).rows[0];
      assert.equal(account.auth_state, "authenticated");
      assert.ok(!account.credentials.includes("fixture-password"));
      await transaction((db) => syncAdmin(db, "ao3Account", { remove: true }));
      await assert.rejects(client.get("/works/123"), /AO3_ACCOUNT_CHANGED/);
      // Media localization changes only bindings, preserving canonical chapter objects offline.
      const { archiveTransaction, preserve } = await import(
        "../apps/api/src/archive"
      );
      const { sha } = await import("../apps/api/src/pack");
      const { localizeMedia } = await import("../apps/api/src/ao3-localize");
      const bytes = Buffer.from("media-fixture"),
        mediaHash = sha(bytes),
        mediaURL = "https://media.example.test/asset.png";
      await archiveTransaction(
        async (db) => {
          await preserve(db, [{ kind: "asset", bytes }]);
          await db.query(
            "INSERT INTO ao3_media(url,object_hash,object_kind) VALUES($1,$2,'asset')",
            [mediaURL, mediaHash],
          );
          await db.query(
            "INSERT INTO archive_media_references(work_id,url) VALUES($1,$2)",
            [head.id, mediaURL],
          );
        },
        ["media-test"],
      );
      await pool.query("UPDATE ao3_control SET mode='force_offline'");
      const beforeMedia = await snapshots();
      await localizeMedia(mediaURL);
      assert.equal(await snapshots(), beforeMedia + 1);
      await localizeMedia(mediaURL);
      assert.equal(
        await snapshots(),
        beforeMedia + 1,
        "same media binding is idempotent",
      );

      const uploadID = randomUUID(),
        uploadBytes = Buffer.alloc(9 * 1024 * 1024, 7);
      await transaction((db) =>
        syncAdmin(db, "ao3UploadStart", {
          id: uploadID,
          url: mediaURL,
          size: uploadBytes.length,
          mime: "application/octet-stream",
        }),
      );
      for (let offset = 0; offset < uploadBytes.length; offset += 512 * 1024)
        await transaction((db) =>
          syncAdmin(db, "ao3UploadChunk", {
            id: uploadID,
            offset,
            data: uploadBytes
              .subarray(offset, offset + 512 * 1024)
              .toString("base64"),
          }),
        );
      await transaction((db) =>
        syncAdmin(db, "ao3UploadFinish", { id: uploadID }),
      );
      const mediaJob = (
        await pool.query(
          "SELECT id FROM ao3_jobs WHERE kind='media' AND target=$1",
          [mediaURL],
        )
      ).rows[0];
      if (process.env.TEST_REDIS_HOST) {
        process.env.REDIS_HOST = process.env.TEST_REDIS_HOST;
        const { runSyncQueue } = await import("../apps/api/src/ao3-scheduler");
        let stopped = false;
        const deadline = setTimeout(() => {
          stopped = true;
        }, 20000);
        try {
          await runSyncQueue(
            async (id) => {
              await executeSync(id);
              if (id === mediaJob.id) stopped = true;
            },
            () => stopped,
          );
        } finally {
          clearTimeout(deadline);
        }
      } else await executeSync(mediaJob.id);
      const media = (
        await pool.query("SELECT * FROM ao3_media WHERE url=$1", [mediaURL])
      ).rows[0];
      assert.equal(media.object_kind, "chunk_manifest");
      assert.equal(
        (
          await pool.query("SELECT state FROM ao3_uploads WHERE id=$1", [
            uploadID,
          ])
        ).rows[0].state,
        "completed",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ao3_upload_chunks WHERE upload_id=$1",
            [uploadID],
          )
        ).rows[0].count,
        "0",
      );
      const { acquireMedia } = await import("../apps/api/src/ao3-media");
      await assert.rejects(
        acquireMedia("http://127.0.0.1/media", () => false),
        /MEDIA_ADDRESS_BLOCKED/,
      );
      const { preserveMediaStream } = await import("../apps/api/src/ao3-media");
      const { Readable } = await import("node:stream");
      const cssURL = "https://media.example.test/css/main.css";
      await pool.query(
        "INSERT INTO archive_media_references(work_id,url) VALUES($1,$2)",
        [head.id, cssURL],
      );
      const cssResult = await preserveMediaStream(
        cssURL,
        Readable.from(["p {color: blue; background-image: url(../image.png)}"]),
        "text/css",
        () => false,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ao3_jobs WHERE kind='media' AND target=$1",
            ["https://media.example.test/image.png"],
          )
        ).rows[0].count,
        "1",
      );
      const inlineCSS = Buffer.from(
        '@import "https://media.example.test/css/main.css";',
      );
      await archiveTransaction(
        (db) => preserve(db, [{ kind: "css", bytes: inlineCSS }]),
        ["css-test"],
      );
      const { workStyles } = await import("../apps/api/src/reader-media");
      const styles = await transaction((db) =>
        workStyles(
          db,
          {
            objects: [
              { name: "inline.css", kind: "css", hash: sha(inlineCSS) },
              { name: cssURL, kind: "asset", hash: cssResult.hash },
            ],
            metadata: { ao3: { media: [{ url: cssURL, object: cssURL }] } },
          },
          () => "",
        ),
      );
      assert.match(styles, /color:blue/);
      const broken = Readable.from(
        (async function* () {
          yield Buffer.alloc(8 * 1024 * 1024, 9);
          throw Error("interrupted fixture");
        })(),
      );
      await assert.rejects(
        preserveMediaStream(
          mediaURL,
          broken,
          "application/octet-stream",
          () => false,
        ),
      );
      assert.equal(
        (
          await pool.query("SELECT object_hash FROM ao3_media WHERE url=$1", [
            mediaURL,
          ])
        ).rows[0].object_hash,
        media.object_hash,
      );
      // A deep thread survives a remote interruption without publishing a partial head.
      let threadUnavailable = true,
        workFetches = 0;
      await pool.query(
        "UPDATE ao3_control SET credentials=NULL,cookies=NULL,mode='force_online',cooldown_until=NULL,next_request_at=now()",
      );
      globalThis.fetch = async (input: any) => {
        await pool.query("UPDATE ao3_control SET next_request_at=now()");
        if (new URL(String(input)).pathname === "/comments/1")
          return threadUnavailable
            ? new Response("Maintenance", { status: 503 })
            : new Response(
                '<li id="comment_2"><h4 class="byline">Guest</h4><blockquote class="userstuff">Reply</blockquote><a href="/comments/1">Parent</a></li>',
              );
        workFetches++;
        return new Response(
          page()
            .replace("</dl>", '<dd class="comments">2</dd></dl>')
            .replace(
              "</body>",
              '<li id="comment_1"><h4 class="byline">Guest</h4><blockquote class="userstuff">Root</blockquote></li><a href="/comments/1">1 more comments in this thread</a></body>',
            ),
        );
      };
      const deepJob = (
        await pool.query(
          "INSERT INTO ao3_jobs(kind,target) VALUES('work','124') RETURNING id",
        )
      ).rows[0].id;
      await executeSync(deepJob);
      assert.equal(
        (
          await pool.query(
            "SELECT id FROM archive_work_heads WHERE external_id='124'",
          )
        ).rowCount,
        0,
      );
      assert.ok(
        (
          await pool.query("SELECT checkpoint FROM ao3_jobs WHERE id=$1", [
            deepJob,
          ])
        ).rows[0].checkpoint.record,
      );
      const attemptsBefore = Number(
        (await pool.query("SELECT count(*) FROM ao3_runs")).rows[0].count,
      );
      await pool.query(
        "UPDATE ao3_control SET mode='force_online',cooldown_until=NULL",
      );
      await pool.query(
        "UPDATE ao3_jobs SET due_at=now(),started_at=now()-interval '2 hours' WHERE id=$1",
        [deepJob],
      );
      await executeSync(deepJob);
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) FROM ao3_runs")).rows[0].count,
        ),
        attemptsBefore,
        "maintenance blocks even Online with an expired cooldown",
      );
      const suspended = await transaction((db) => syncAdmin(db, "ao3Jobs", {}));
      assert.equal(
        suspended.jobs.find((j: any) => j.id === deepJob).execution,
        "waiting_service",
      );
      assert.equal(
        suspended.jobs.find((j: any) => j.id === deepJob).eligible_at,
        null,
      );
      await pool.query(
        "UPDATE ao3_jobs SET error='MEDIA_UNRECOVERABLE',attempts=1 WHERE id=$1",
        [mediaJob.id],
      );
      await pool.query(
        "INSERT INTO ao3_jobs(kind,target,error) VALUES('media','https://media.example.test/temporary.png','MEDIA_NETWORK')",
      );
      const missing = await transaction((db) => syncAdmin(db, "ao3Media", {}));
      assert.equal(missing.items.length, 1);
      assert.equal(missing.items[0].url, mediaURL);
      assert.equal(missing.items[0].has_local_copy, true);
      assert.equal(missing.items[0].work_count, 1);
      assert.equal(missing.items[0].works[0].id, head.id);
      assert.equal(
        (await transaction((db) => syncAdmin(db, "ao3Media", { q: "absent" })))
          .items.length,
        0,
      );
      threadUnavailable = false;
      await pool.query(
        "UPDATE ao3_control SET observed_state='online',cooldown_until=NULL,next_request_at=now()",
      );
      await pool.query(
        "UPDATE ao3_jobs SET due_at=now(),started_at=now()-interval '2 hours' WHERE id=$1",
        [deepJob],
      );
      await executeSync(deepJob);
      assert.equal(workFetches, 1);
      const deep = (
        await pool.query(
          "SELECT encode(s.manifest_hash,'hex') AS hash FROM archive_work_heads h JOIN archive_snapshot_data s ON s.id=h.current_snapshot_id WHERE h.external_id='124'",
        )
      ).rows[0];
      const deepManifest = await transaction(async (db) =>
        JSON.parse((await readObject(db, deep.hash)).toString()),
      );
      assert.equal(deepManifest.metadata.ao3.comments.length, 2);
      assert.equal(deepManifest.metadata.ao3.comments_coverage, "complete");
    } finally {
      globalThis.fetch = fetchOriginal;
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
