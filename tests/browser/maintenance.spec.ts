import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  open,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

test("Maintenance: real scrub checkpoints, immutable recovery, access and impersonation audit", async ({
  page,
  browser,
  playwright,
}, info) => {
  test.setTimeout(360000);
  if (!process.env.TEST_DATABASE_URL?.includes("palimora_ops_test"))
    throw Error("Isolated database required");
  const root = process.env.OPERATIONS_TEST_ROOT!,
    db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const password = "Maintenance fixture password 83",
    configFile = join(root, "backup-config.json");
  const targetPath = join(root, "backups");
  await mkdir(targetPath);
  await writeFile(
    join(targetPath, ".palimora-backup-target"),
    "maintenance-fixture",
  );
  const mount = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .map((l) => l.split(" "))
    .filter((p) => p[4] === "/" || targetPath.startsWith(p[4] + "/"))
    .sort((a, b) => b[4].length - a[4].length)[0];
  const target = {
    name: "test",
    label: "Disco di test",
    path: targetPath,
    marker: "maintenance-fixture",
    device: mount[2],
    reserveBytes: 0,
  };
  await writeFile(
    configFile,
    JSON.stringify({ destinations: [target], restores: [] }),
  );
  const env = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    AUTH_KEY: "ab".repeat(32),
    APP_ORIGIN: "http://localhost:5173",
    PORT: "3000",
    BACKUP_CONFIG_FILE: configFile,
  };
  Object.assign(process.env, env);
  const log = createWriteStream(join(root, "api.log"));
  const launch = (args: string[]) => {
    const p = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout!.pipe(log, { end: false });
    p.stderr!.pipe(log, { end: false });
    return p;
  };
  const stop = async (p?: ChildProcess) => {
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    await new Promise<void>((r) => p.once("exit", () => r()));
  };
  const runWorker = () =>
    launch([
      "-e",
      `const {maintenanceTick}=require('./apps/api/dist/archive-maintenance');const {pool}=require('./apps/api/dist/db');let stopped=false;process.on('SIGTERM',()=>stopped=true);(async()=>{while(!stopped){await maintenanceTick(()=>stopped);await new Promise(r=>setTimeout(r,80))}await pool.end()})().catch(e=>{console.error(e);process.exit(1)})`,
    ]);
  let api = launch(["apps/api/dist/main.js"]),
    worker: ChildProcess | undefined,
    scheduler: ChildProcess | undefined;
  const queue = new Queue("palimora-ao3-v1", {
    connection: {
      host: process.env.REDIS_HOST,
      port: 6379,
      maxRetriesPerRequest: 1,
    },
  });
  queue.on("error", () => {});
  let archiveDb: any;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ready = () =>
    expect
      .poll(
        () =>
          fetch("http://localhost:3000/api/v1/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 60000 },
      )
      .toBe(200);
  try {
    await ready();
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("maintowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    const owner = await playwright.request.newContext({
      baseURL: "http://localhost:5173",
      extraHTTPHeaders: { Origin: "http://localhost:5173" },
    });
    const ownerAuth = await (
      await owner.post("/api/v1/auth/login", {
        data: { username: "maintowner", password },
      })
    ).json();
    const post = async (path: string, data: any) =>
      owner.post("/api/v1" + path, {
        data,
        headers: { "x-csrf-token": ownerAuth.csrf },
      });
    const ownerId = ownerAuth.user.id;
    const user = randomUUID(),
      admin = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,password_hash,role) SELECT $1,'maintuser',password_hash,'User' FROM users WHERE id=$2",
      [user, ownerId],
    );
    await db.query(
      "INSERT INTO users(id,username,password_hash,role) SELECT $1,'maintadmin',password_hash,'Admin' FROM users WHERE id=$2",
      [admin, ownerId],
    );
    await db.query("UPDATE ao3_control SET mode='force_offline',paused=true");
    const userApi = await playwright.request.newContext({
        baseURL: "http://localhost:5173",
        extraHTTPHeaders: { Origin: "http://localhost:5173" },
      }),
      adminApi = await playwright.request.newContext({
        baseURL: "http://localhost:5173",
        extraHTTPHeaders: { Origin: "http://localhost:5173" },
      });
    const userAuth = await (
      await userApi.post("/api/v1/auth/login", {
        data: { username: "maintuser", password },
      })
    ).json();
    const adminAuth = await (
      await adminApi.post("/api/v1/auth/login", {
        data: { username: "maintadmin", password },
      })
    ).json();
    expect((await userApi.get("/api/v1/admin/integrity")).status()).toBe(403);
    expect((await adminApi.get("/api/v1/admin/integrity")).status()).toBe(200);
    expect(
      (await db.query("SELECT enabled FROM integrity_schedule")).rows[0]
        .enabled,
    ).toBe(false);
    const archive = require("../../apps/api/dist/archive");
    archiveDb = require("../../apps/api/dist/db");
    const batch = randomUUID(),
      source = {
        id: randomUUID(),
        path: "maintenance-fixture.zip",
        fingerprint: "maintenance-fixture",
      };
    await db.query(
      "INSERT INTO ingest_batches(id,state) VALUES($1,'completed')",
      [batch],
    );
    await db.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
    for (let n = 1; n <= 2; n++)
      await archive.ingestRecord(source, {
        parser: "maintenance-fixture-v1",
        cursor: n,
        locator: "version-" + n,
        record: {
          external_id: "991290",
          state: "valid",
          metadata: { title: ["Maintenance preserved work"] },
          chapters: [{ name: "chapter" }],
          objects: [
            {
              name: "chapter",
              kind: "chapter_html",
              data: Buffer.from("<p>Historical version " + n + "</p>").toString(
                "base64",
              ),
            },
          ],
          observed_at: null,
        },
      });
    await archive.archiveTransaction((tx: any) =>
      archive.preserve(
        tx,
        Array.from({ length: 160 }, (_, n) => ({
          kind: "asset",
          bytes: Buffer.from("Scrub checkpoint fixture " + n),
        })),
      ),
    );
    const mediaCodec = require("../../apps/api/dist/pack"),
      chunks = [
        Buffer.from("first media segment"),
        Buffer.from("second media segment"),
      ];
    await archive.archiveTransaction((tx: any) =>
      archive.preserve(tx, [
        ...chunks.map((bytes) => ({ kind: "media_chunk", bytes })),
        {
          kind: "chunk_manifest",
          bytes: mediaCodec.canonical({
            schema: "palimora-chunks-v1",
            size: Buffer.concat(chunks).length,
            sha256: mediaCodec.sha(Buffer.concat(chunks)),
            chunks: chunks.map((bytes) => ({
              hash: mediaCodec.sha(bytes),
              size: bytes.length,
            })),
          }),
        },
      ]),
    );
    const versions = (
      await db.query(
        "SELECT id,work_id,manifest_hash FROM archive_snapshots ORDER BY id",
      )
    ).rows;
    expect(versions).toHaveLength(2);
    const original = (
      await db.query(
        "SELECT * FROM archive_objects WHERE kind='chapter_html' ORDER BY hash LIMIT 1",
      )
    ).rows[0];
    const pack = require("../../apps/api/dist/pack"),
      store = new pack.PackStore(env.ARCHIVE_ROOT);
    const loc = (r: any) => ({
      ...r,
      offset: Number(r.byte_offset),
      length: Number(r.length),
      size: Number(r.size),
    });
    const expected = await store.read(loc(original));
    // A genuine complete backup, including sessions and personal data, is the recovery source.
    await db.query(
      "INSERT INTO library_bookmarks(user_id,work_id,notes) VALUES($1,$2,'Personal fixture')",
      [user, versions[0].work_id],
    );
    const privateCollection = randomUUID();
    expect(
      (
        await post("/collections", {
          id: privateCollection,
          name: "Owner private collection",
          description: "",
        })
      ).status(),
    ).toBe(200);
    const backupId = randomUUID();
    await require("../../apps/api/dist/backup-engine").createBackup({
      database: archiveDb.pool,
      storage: env.ARCHIVE_ROOT,
      target,
      id: backupId,
      kind: "full",
      config: { authKey: env.AUTH_KEY, origin: env.APP_ORIGIN, settings: {} },
      volumeBytes: 16384,
    });
    await db.query(
      "INSERT INTO backup_destinations(name,label) VALUES('test','Disco di test') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,state,actor_id) VALUES($1,'full','test','completed',$2)",
      [backupId, ownerId],
    );
    process.env.BACKUP_VOLUME_BYTES = "16384";
    const exportId = randomUUID(),
      incrementalId = randomUUID();
    const { exportCorpus } = require("../../apps/api/dist/archive-export");
    await exportCorpus({
      id: exportId,
      destination: "test",
      basePaths: [],
      stopped: () => false,
      progress: async () => {},
    });
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,state,actor_id) VALUES($1,'export','test','completed',$2)",
      [exportId, ownerId],
    );
    await exportCorpus({
      id: incrementalId,
      destination: "test",
      basePaths: [join(targetPath, exportId, "archive")],
      stopped: () => false,
      progress: async () => {},
    });
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,state,actor_id,base_id) VALUES($1,'export','test','completed',$2,$3)",
      [incrementalId, ownerId, exportId],
    );
    const f = await open(join(env.ARCHIVE_ROOT!, "packs", original.pack), "r+");
    const byte = Buffer.alloc(1),
      offset = Number(original.byte_offset) + Number(original.length) - 1;
    await f.read(byte, 0, 1, offset);
    byte[0] ^= 255;
    await f.write(byte, 0, 1, offset);
    await f.sync();
    await f.close();
    await expect(store.read(loc(original))).rejects.toThrow();
    await page.goto("/admin/integrity");
    await page.getByRole("button", { name: "Avvia scrub" }).click();
    await expect(page).toHaveURL(/job=/);
    const scrub = new URL(page.url()).searchParams.get("job")!;
    worker = runWorker();
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT checkpoint FROM archive_jobs WHERE id=$1",
                [scrub],
              )
            ).rows[0].checkpoint.offset ?? 0,
          ),
        { timeout: 30000 },
      )
      .toBeGreaterThan(8);
    await page.getByRole("button", { name: "Pausa", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              scrub,
            ])
          ).rows[0].state,
      )
      .toBe("paused");
    const checkpoint = (
      await db.query("SELECT checkpoint FROM archive_jobs WHERE id=$1", [scrub])
    ).rows[0].checkpoint;
    await stop(worker);
    worker = undefined;
    await stop(api);
    api = launch(["apps/api/dist/main.js"]);
    await ready();
    expect(
      (
        await db.query("SELECT checkpoint FROM archive_jobs WHERE id=$1", [
          scrub,
        ])
      ).rows[0].checkpoint,
    ).toEqual(checkpoint);
    await page.reload();
    await page.getByRole("button", { name: "Riprendi", exact: true }).click();
    worker = runWorker();
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              scrub,
            ])
          ).rows[0].state,
        { timeout: 90000 },
      )
      .toBe("completed");
    const issues = (
      await db.query("SELECT * FROM integrity_issues WHERE job_id=$1", [scrub])
    ).rows;
    expect(issues.filter((r) => r.object_hash === original.hash)).toHaveLength(
      1,
    );
    expect(
      issues.filter((r) => r.object_hash === original.hash)[0].code,
    ).toMatch(/CORRUPT/);
    expect(issues).toHaveLength(1);
    const issue = issues.find((r) => r.object_hash === original.hash);
    expect(
      (
        await adminApi.post("/api/v1/admin/integrity/repair", {
          data: {
            requestId: randomUUID(),
            issue: issue.id,
            backup: backupId,
            confirmation: true,
          },
          headers: { "x-csrf-token": adminAuth.csrf },
        })
      ).status(),
    ).toBe(403);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Recupera", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("integrity-desktop.png"),
      fullPage: true,
    });
    await rename(
      join(targetPath, ".palimora-backup-target"),
      join(targetPath, ".missing-marker"),
    );
    await page.getByRole("button", { name: "Recupera", exact: true }).click();
    await page.getByLabel("Backup o export").selectOption(backupId);
    await page.getByRole("button", { name: "Verifica e recupera" }).click();
    await expect(page).not.toHaveURL(new RegExp(scrub));
    const repair = new URL(page.url()).searchParams.get("job")!;
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              repair,
            ])
          ).rows[0].state,
        { timeout: 30000 },
      )
      .toBe("failed");
    expect(
      (
        await db.query("SELECT pack FROM archive_objects WHERE hash=$1", [
          original.hash,
        ])
      ).rows[0].pack,
    ).toBe(original.pack);
    await rename(
      join(targetPath, ".missing-marker"),
      join(targetPath, ".palimora-backup-target"),
    );
    await page.getByRole("button", { name: "Riprendi", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              repair,
            ])
          ).rows[0].state,
        { timeout: 60000 },
      )
      .toBe("completed");
    const restored = (
      await db.query("SELECT * FROM archive_objects WHERE hash=$1", [
        original.hash,
      ])
    ).rows[0];
    expect(restored.pack).not.toBe(original.pack);
    expect(await store.read(loc(restored))).toEqual(expected);
    expect(
      (await stat(join(env.ARCHIVE_ROOT!, "packs", original.pack))).isFile(),
    ).toBe(true);
    expect(
      (
        await db.query(
          "SELECT id,work_id,manifest_hash FROM archive_snapshots ORDER BY id",
        )
      ).rows,
    ).toEqual(versions);
    expect(
      (
        await db.query("SELECT state FROM integrity_issues WHERE id=$1", [
          issue.id,
        ])
      ).rows[0].state,
    ).toBe("repaired");
    expect(
      (
        await db.query("SELECT notes FROM library_bookmarks WHERE user_id=$1", [
          user,
        ])
      ).rows[0].notes,
    ).toBe("Personal fixture");
    const recoveryAudit = (
      await db.query(
        "SELECT session_id,ip,details FROM audit WHERE action='integrity.repaired' AND target=$1",
        [original.hash],
      )
    ).rows[0];
    expect(recoveryAudit.session_id).toBeTruthy();
    expect(recoveryAudit.ip).toBeTruthy();
    expect(recoveryAudit.details.before.pack).toBe(original.pack);
    // A wrong SQL offset is detected and repaired from an incremental export's base volume.
    const second = (
        await db.query(
          "SELECT * FROM archive_objects WHERE kind='chapter_html' AND hash<>$1 LIMIT 1",
          [original.hash],
        )
      ).rows[0],
      secondBytes = await store.read(loc(second));
    await db.query(
      "UPDATE archive_object_data SET byte_offset=byte_offset+1 WHERE hash=decode($1,'hex')",
      [second.hash],
    );
    const scrub2 = randomUUID();
    expect(
      (await post("/admin/integrity/scrub", { requestId: scrub2 })).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              scrub2,
            ])
          ).rows[0].state,
        { timeout: 60000 },
      )
      .toBe("completed");
    const secondIssue = (
      await db.query(
        "SELECT id FROM integrity_issues WHERE job_id=$1 AND object_hash=$2 AND code='LOCATOR_MISMATCH'",
        [scrub2, second.hash],
      )
    ).rows[0];
    expect(secondIssue).toBeTruthy();
    const recovery2 = randomUUID();
    expect(
      (
        await post("/admin/integrity/repair", {
          requestId: recovery2,
          issue: secondIssue.id,
          backup: incrementalId,
          confirmation: true,
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM archive_jobs WHERE id=$1", [
              recovery2,
            ])
          ).rows[0].state,
        { timeout: 60000 },
      )
      .toBe("completed");
    expect(
      await store.read(
        loc(
          (
            await db.query("SELECT * FROM archive_objects WHERE hash=$1", [
              second.hash,
            ])
          ).rows[0],
        ),
      ),
    ).toEqual(secondBytes);
    expect(
      (
        await db.query(
          "SELECT id,work_id,manifest_hash FROM archive_snapshots ORDER BY id",
        )
      ).rows,
    ).toEqual(versions);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM integrity_issues WHERE job_id=$1 AND code='UNREFERENCED_CORRUPT'",
            [scrub2],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    // Empty streaming records use the same verified copy-on-write path.
    const empty = await store.restoreStream(
      { hash: pack.sha(Buffer.alloc(0)), kind: "asset", size: 0 },
      (async function* () {})(),
      async () => {},
    );
    expect(await store.read(empty)).toEqual(Buffer.alloc(0));
    await page.goto("/admin/maintenance");
    const activate = async (label: string) => {
      await page
        .locator(".maintenance-modes > div")
        .filter({
          has: page.getByRole("heading", { name: label, exact: true }),
        })
        .getByRole("button")
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Conferma", exact: true })
        .click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
    };
    await activate("Manutenzione leggera");
    const policy =
      await require("../../apps/api/dist/maintenance").processingPolicy();
    expect(policy).toMatchObject({
      accelerated: true,
      priority: 1,
      dispatchMs: 100,
      projectionPasses: 4,
    });
    expect((await userApi.get("/api/v1/works")).status()).toBe(200);
    await queue.pause();
    await db.query(
      "UPDATE ao3_control SET mode='force_online',paused=false,next_request_at=now()+interval '1 day'",
    );
    scheduler = launch([
      "-e",
      "const {runSyncQueue}=require('./apps/api/dist/ao3-scheduler');const {executeSync}=require('./apps/api/dist/ao3-worker');const {pool}=require('./apps/api/dist/db');let stopped=false;process.on('SIGTERM',()=>stopped=true);runSyncQueue(id=>executeSync(id,()=>stopped),()=>stopped).finally(()=>pool.end());",
    ]);
    await expect
      .poll(
        async () =>
          (await queue.getJobs(["prioritized", "waiting", "paused"])).filter(
            (j) => j.opts.priority === 1,
          ).length,
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    await stop(scheduler);
    scheduler = undefined;
    await db.query("UPDATE ao3_control SET mode='force_offline',paused=true");
    await activate("Manutenzione totale");
    expect((await userApi.get("/api/v1/works")).status()).toBe(503);
    expect((await adminApi.get("/api/v1/admin/integrity")).status()).toBe(200);
    const guest = await browser.newContext({ locale: "it-IT" }),
      guestPage = await guest.newPage();
    await guestPage.goto("http://localhost:5173/works");
    await expect(
      guestPage.getByRole("heading", {
        name: "La biblioteca è in manutenzione",
      }),
    ).toBeVisible();
    await guestPage.setViewportSize({ width: 390, height: 844 });
    await guestPage.screenshot({
      path: info.outputPath("maintenance-mobile.png"),
      fullPage: true,
    });
    expect(
      await guestPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const ordinary = await browser.newContext({
        storageState: await userApi.storageState(),
        locale: "it-IT",
      }),
      ordinaryPage = await ordinary.newPage();
    await ordinaryPage.goto("http://localhost:5173/library");
    await expect(
      ordinaryPage.getByRole("heading", {
        name: "La biblioteca è in manutenzione",
      }),
    ).toBeVisible();
    await stop(api);
    api = launch(["apps/api/dist/main.js"]);
    await ready();
    expect(
      (await db.query("SELECT maintenance_mode FROM instance")).rows[0]
        .maintenance_mode,
    ).toBe("maintenance_full");
    expect(
      (
        await guest.request.post("http://localhost:5173/api/v1/auth/login", {
          data: { username: "maintuser", password },
          headers: { Origin: env.APP_ORIGIN },
        })
      ).status(),
    ).toBe(503);
    await page.reload();
    await activate("Normale");
    await guest.close();
    await ordinary.close();
    // The original session survives unchanged, child session has only target permissions.
    await page.goto("/admin/users/" + user);
    await page.getByRole("button", { name: "Accedi come utente" }).click();
    await page.getByRole("button", { name: "Avvia sessione" }).click();
    await expect(
      page.getByRole("complementary", { name: "Sessione impersonata" }),
    ).toBeVisible();
    const auth = await page.evaluate(
      async () => await (await fetch("/api/v1/me")).json(),
    );
    expect(auth.user.id).toBe(user);
    expect(auth.impersonation.actor_id).toBe(ownerId);
    const browserPost = (path: string, data: any) =>
      page.evaluate(
        async ({ path, data, csrf }) => {
          const r = await fetch("/api/v1" + path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf,
            },
            body: JSON.stringify(data),
          });
          return { status: r.status, body: await r.json() };
        },
        { path, data, csrf: auth.csrf },
      );
    expect(
      (
        await browserPost("/admin/maintenance", {
          mode: "maintenance_full",
          confirmation: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await browserPost("/admin/impersonation", {
          id: ownerId,
          confirmation: true,
        })
      ).status,
    ).toBe(403);
    expect(
      await page.evaluate(
        async () => (await fetch("/api/v1/me/sessions")).status,
      ),
    ).toBe(403);
    expect(
      (
        await browserPost("/library/works/" + versions[0].work_id + "/later", {
          later: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await page.evaluate(
        async (id) => (await fetch("/api/v1/collections/" + id)).status,
        privateCollection,
      ),
    ).toBe(404);
    const attributed = (
      await db.query(
        "SELECT * FROM audit WHERE actor_id=$1 AND effective_user_id=$2 AND action='libraryLater' ORDER BY id DESC LIMIT 1",
        [ownerId, user],
      )
    ).rows[0];
    expect(attributed.session_id).toBe(auth.session.id);
    expect(attributed.details.original_session_id).toBeTruthy();
    expect(attributed.ip).toBeTruthy();
    const childCookie = (await page.context().cookies()).find(
      (c) => c.name === "palimora_impersonation",
    )!;
    const forged = await playwright.request.newContext({
      baseURL: env.APP_ORIGIN,
      extraHTTPHeaders: { Cookie: "palimora_session=" + childCookie.value },
    });
    expect((await forged.get("/api/v1/me")).status()).toBe(401);
    await forged.dispose();
    await page.getByRole("button", { name: "Torna al tuo account" }).click();
    await expect(
      page.getByRole("button", { name: "Accedi come utente" }),
    ).toBeVisible();
    const parent = await page.evaluate(
      async () => await (await fetch("/api/v1/me")).json(),
    );
    expect(parent.session.id).toBe(attributed.details.original_session_id);
    expect(parent.user.id).toBe(ownerId);
    expect(
      (
        await post("/admin/impersonation", { id: admin, confirmation: true })
      ).status(),
    ).toBe(403);
    const changed = (
      await db.query(
        "SELECT details FROM audit WHERE action='maintenanceSet' AND outcome='success' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0].details;
    expect(changed.before.maintenance_mode).toBe("maintenance_full");
    expect(changed.after.maintenance_mode).toBe("normal");
    await page.goto("/admin/audit");
    await expect(
      page.getByRole("heading", { name: "Audit", exact: true }),
    ).toBeVisible();
    expect(await page.locator("main").innerText()).not.toContain(password);
    await page.goto("/admin/integrity?job=" + scrub);
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.getByRole("heading", { name: "Problemi rilevati" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("integrity-tablet.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator(".integrity-schedule summary").click();
    await page.getByLabel("Abilita scrub periodico").check();
    await page.getByRole("button", { name: "Salva pianificazione" }).click();
    await expect
      .poll(
        async () =>
          (await db.query("SELECT enabled FROM integrity_schedule")).rows[0]
            .enabled,
      )
      .toBe(true);
    await db.query(
      "UPDATE integrity_schedule SET next_at=now()-interval '1 day'",
    );
    await expect
      .poll(async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) FROM archive_jobs WHERE kind='scrub'",
            )
          ).rows[0].count,
        ),
      )
      .toBe(3);
    await page.getByLabel("Abilita scrub periodico").uncheck();
    await page.getByRole("button", { name: "Salva pianificazione" }).click();
    // Parent revocation immediately invalidates child access; it is never a standalone login.
    const child = await (
      await post("/admin/impersonation", { id: user, confirmation: true })
    ).json();
    expect(child.user.id).toBe(user);
    await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      ownerAuth.session.id,
    ]);
    expect((await owner.get("/api/v1/works")).status()).toBe(401);
    expect(
      (await owner.storageState()).cookies.some(
        (c) => c.name === "palimora_impersonation",
      ),
    ).toBe(false);
    expect(
      (
        await owner.post("/api/v1/auth/login", {
          data: { username: "maintowner", password },
        })
      ).status(),
    ).toBe(200);
    expect(errors).toEqual([]);
    await owner.dispose();
    await userApi.dispose();
    await adminApi.dispose();
  } finally {
    await stop(scheduler);
    await queue.close();
    await stop(worker);
    await stop(api);
    await archiveDb?.pool.end();
    await db.end();
    log.end();
  }
});
