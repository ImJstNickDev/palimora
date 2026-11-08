import { tmpdir } from "node:os";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
const password = "Backup browser fixture password 82";
test("Backup Manager: real queue, portable exports, restore, permissions and missing mount", async ({
  page,
  playwright,
}) => {
  if (
    !process.env.TEST_DATABASE_URL?.includes("test") ||
    !process.env.BACKUP_MANAGER_ROOT?.startsWith(tmpdir() + "/")
  )
    throw Error("Isolated environment required");
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const startWorker = () =>
    spawn(process.execPath, ["apps/api/dist/backup-service.js"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        AUTH_KEY: "ab".repeat(32),
        APP_ORIGIN: "http://localhost:5173",
      },
      stdio: "ignore",
    });
  let worker = startWorker();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("backupowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { ingestRecord } = require("../../apps/api/dist/archive");
    const archiveDb = require("../../apps/api/dist/db");
    const batch = randomUUID(),
      source = {
        id: randomUUID(),
        path: "backup-browser.zip",
        fingerprint: "fixture",
      };
    await db.query(
      "INSERT INTO ingest_batches(id,state) VALUES($1,'completed')",
      [batch],
    );
    await db.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
    for (let version = 1; version <= 2; version++)
      await ingestRecord(source, {
        parser: "backup-browser-v1",
        cursor: version,
        locator: "story-" + version,
        record: {
          external_id: "999123",
          state: "valid",
          metadata: { title: ["A preserved work"] },
          chapters: [{ name: "chapter" }],
          objects: [
            {
              name: "chapter",
              kind: "chapter_html",
              data: Buffer.from("<p>Version " + version + "</p>").toString(
                "base64",
              ),
            },
          ],
          observed_at: null,
        },
      });
    await archiveDb.pool.end();
    await db.query(
      "INSERT INTO library_bookmarks(user_id,work_id,notes) SELECT u.id,w.id,'private fixture' FROM users u CROSS JOIN archive_work_heads w WHERE u.username='backupowner'",
    );
    await page.goto("/admin/backups");
    await expect(
      page.getByRole("heading", { name: "Backup ed export" }),
    ).toBeVisible();
    const detail = page.getByRole("region", { name: "Dettaglio operazione" });
    async function create(kind: string) {
      const previous = page.url();
      await page
        .getByRole("button", { name: "Nuova copia", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Modalità").selectOption(kind);
      await expect(
        dialog.getByLabel("Destinazione").locator('option[value="disk"]'),
      ).toBeEnabled({ timeout: 30000 });
      await dialog.getByLabel("Destinazione").selectOption("disk");
      await dialog
        .getByRole("button", { name: "Crea copia", exact: true })
        .click();
      await page.waitForURL((url) => url.href !== previous);
      await expect(dialog).not.toBeVisible();
      await expect(detail).toHaveAttribute(
        "data-operation-id",
        new URL(page.url()).searchParams.get("id")!,
      );
      await expect(detail.getByText("Completato", { exact: true })).toBeVisible(
        { timeout: 90000 },
      );
      return new URL(page.url()).searchParams.get("id")!;
    }
    const full = await create("full");
    await detail.getByText("File da scaricare", { exact: false }).click();
    await expect(
      detail.getByRole("link", { name: "manifest.json", exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Verifica integrità" }).click();
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT count(*) FROM backup_runs WHERE source_id=$1 AND kind='verify' AND state='completed'",
                [full],
              )
            ).rows[0].count,
          ),
        { timeout: 60000 },
      )
      .toBe(1);
    await detail
      .getByRole("button", { name: "Ripristina", exact: true })
      .click();
    const restore = page.getByRole("dialog");
    await restore
      .getByLabel("Istanza di destinazione")
      .selectOption("isolated");
    await restore
      .getByLabel("Scrivi RIPRISTINA per confermare")
      .fill("RIPRISTINA");
    await restore.getByRole("button", { name: "Avvia ripristino" }).click();
    await page.waitForURL((url) => url.searchParams.get("id") !== full);
    await expect(restore).not.toBeVisible();
    await expect(detail).toHaveAttribute(
      "data-operation-id",
      new URL(page.url()).searchParams.get("id")!,
    );
    await expect(detail.getByText("Completato", { exact: true })).toBeVisible({
      timeout: 90000,
    });
    const restored = new Pool({
      connectionString: process.env.BACKUP_TEST_RESTORE_URL,
    });
    try {
      expect(
        (await restored.query("SELECT count(*) FROM archive_snapshots")).rows[0]
          .count,
      ).toBe("2");
      expect(
        (await restored.query("SELECT notes FROM library_bookmarks")).rows[0]
          .notes,
      ).toBe("private fixture");
    } finally {
      await restored.end();
    }
    const exported = await create("export");
    const root = process.env.BACKUP_MANAGER_ROOT!,
      basePath = join(root, "disk", exported, "archive");
    const m = JSON.parse(
      await readFile(join(basePath, "manifest.json"), "utf8"),
    );
    expect(m.volumes.length).toBeGreaterThan(1);
    expect(m.catalog.tables.users).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("private fixture");
    await detail.getByRole("button", { name: "Nuovo incrementale" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Crea copia", exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.get("id") !== exported);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(detail).toHaveAttribute(
      "data-operation-id",
      new URL(page.url()).searchParams.get("id")!,
    );
    await expect(detail.getByText("Completato", { exact: true })).toBeVisible({
      timeout: 90000,
    });
    const incremental = new URL(page.url()).searchParams.get("id")!,
      deltaPath = join(root, "disk", incremental, "archive");
    const delta = JSON.parse(
      await readFile(join(deltaPath, "manifest.json"), "utf8"),
    );
    expect(delta.dependencies).toHaveLength(1);
    expect(delta.objects.length).toBe(0);
    const cli = join(process.cwd(), "packages/archive-cli/cli.cjs");
    expect(
      JSON.parse(
        execFileSync(process.execPath, [cli, "verify", basePath, deltaPath], {
          encoding: "utf8",
        }),
      ).archives,
    ).toBe(2);
    expect(
      execFileSync(process.execPath, [cli, "list", basePath, deltaPath], {
        encoding: "utf8",
      }),
    ).toContain("A preserved work");
    execFileSync(process.execPath, [
      cli,
      "import",
      join(root, "extracted"),
      basePath,
      deltaPath,
    ]);
    execFileSync(
      process.execPath,
      ["apps/api/dist/archive-import-command.js", basePath, deltaPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.BACKUP_TEST_CORPUS_URL!,
          ARCHIVE_ROOT: join(root, "imported"),
        },
        stdio: "pipe",
      },
    );
    execFileSync(
      process.execPath,
      ["apps/api/dist/archive-import-command.js", basePath, deltaPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.BACKUP_TEST_CORPUS_URL!,
          ARCHIVE_ROOT: join(root, "imported"),
        },
        stdio: "pipe",
      },
    );
    const imported = new Pool({
      connectionString: process.env.BACKUP_TEST_CORPUS_URL,
    });
    try {
      expect(
        (await imported.query("SELECT count(*) FROM archive_snapshots")).rows[0]
          .count,
      ).toBe("2");
      expect(
        (await imported.query("SELECT count(*) FROM users")).rows[0].count,
      ).toBe("0");
    } finally {
      await imported.end();
    }
    const platform = await create("platform");
    await detail
      .getByRole("button", { name: "Ripristina", exact: true })
      .click();
    await restore
      .getByLabel("Istanza di destinazione")
      .selectOption("platform");
    await restore
      .getByLabel("Scrivi RIPRISTINA per confermare")
      .fill("RIPRISTINA");
    await restore.getByRole("button", { name: "Avvia ripristino" }).click();
    await page.waitForURL((url) => url.searchParams.get("id") !== platform);
    await expect(restore).not.toBeVisible();
    await expect(detail).toHaveAttribute(
      "data-operation-id",
      new URL(page.url()).searchParams.get("id")!,
    );
    await expect(detail.getByText("Completato", { exact: true })).toBeVisible({
      timeout: 90000,
    });
    const personal = new Pool({
      connectionString: process.env.BACKUP_TEST_CORPUS_URL,
    });
    try {
      expect(
        (await personal.query("SELECT notes FROM library_bookmarks")).rows[0]
          .notes,
      ).toBe("private fixture");
      expect(
        (await personal.query("SELECT count(*) FROM archive_snapshots")).rows[0]
          .count,
      ).toBe("2");
    } finally {
      await personal.end();
    }
    await page
      .getByRole("button", { name: "Pianificazioni", exact: true })
      .click();
    await page.getByRole("button", { name: "Nuova pianificazione" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Abilita copie automatiche" }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "Salva pianificazione" }).click();
    await expect
      .poll(
        async () =>
          (await db.query("SELECT enabled FROM backup_schedules")).rows[0]
            ?.enabled,
      )
      .toBe(false);
    await page
      .getByRole("button", { name: "Destinazioni", exact: true })
      .click();
    await expect(
      page.getByText("NAS non montato", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Disco non montato. Ricollega la destinazione e riprova.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/backup-manager-destinations.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/backups?id=" + exported);
    await expect(detail.getByText("Completato", { exact: true })).toBeVisible();
    await page.screenshot({
      path: ".local/backup-manager-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: ".local/backup-manager-desktop.png",
      fullPage: true,
    });
    // Persistent queue controls and recovery across an actual worker restart.
    const gate = await db.connect();
    await gate.query("SELECT pg_advisory_lock(70210462)");
    try {
      await page
        .getByRole("button", { name: "Nuova copia", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByLabel("Modalità")
        .selectOption("export");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Crea copia", exact: true })
        .click();
      await page.waitForURL((url) => url.searchParams.get("id") !== exported);
      await expect(page.getByRole("dialog")).not.toBeVisible();
      const queued = new URL(page.url()).searchParams.get("id")!;
      await expect(detail).toHaveAttribute("data-operation-id", queued);
      await detail.getByRole("button", { name: "Pausa", exact: true }).click();
      await expect(detail.getByText("In pausa", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "Annulla operazione" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Conferma annullamento" })
        .click();
      await expect(
        detail.getByText("Annullato", { exact: true }),
      ).toBeVisible();
      await detail.getByRole("button", { name: "Riprendi" }).click();
      await expect(detail.locator(".backup-state")).toHaveText("In coda");
      worker.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
      worker = startWorker();
    } finally {
      await gate.query("SELECT pg_advisory_unlock(70210462)");
      gate.release();
    }
    await expect(detail.getByText("Completato", { exact: true })).toBeVisible({
      timeout: 60000,
    });
    await page
      .getByRole("button", { name: "Pianificazioni", exact: true })
      .click();
    await page.getByRole("button", { name: "Modifica", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "Abilita copie automatiche" })
      .check();
    await page.getByLabel("Copie da conservare").fill("1");
    await page.getByRole("button", { name: "Salva pianificazione" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const sid = (await db.query("SELECT id FROM backup_schedules")).rows[0].id;
    for (let n = 1; n <= 2; n++) {
      await db.query(
        "UPDATE backup_schedules SET next_at=now()-interval '1 minute' WHERE id=$1",
        [sid],
      );
      await expect
        .poll(
          async () =>
            Number(
              (
                await db.query(
                  "SELECT count(*) FROM backup_runs WHERE schedule_id=$1 AND kind='full' AND state IN ('completed','deleted')",
                  [sid],
                )
              ).rows[0].count,
            ),
          { timeout: 60000 },
        )
        .toBe(n);
    }
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT count(*) FROM backup_runs WHERE schedule_id=$1 AND kind='full' AND state='deleted'",
                [sid],
              )
            ).rows[0].count,
          ),
        { timeout: 60000 },
      )
      .toBe(1);
    for (const role of ["Admin", "User"]) {
      const name = "backup" + role.toLowerCase();
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) SELECT $1,$2,password_hash,$3 FROM users WHERE username='backupowner'",
        [randomUUID(), name, role],
      );
      const context = await playwright.request.newContext({
        baseURL: "http://localhost:5173",
        extraHTTPHeaders: { Origin: "http://localhost:5173" },
      });
      const login = await context.post("/api/v1/auth/login", {
        data: { username: name, password },
      });
      expect(login.status()).toBe(200);
      const csrf = (await login.json()).csrf;
      expect(
        (
          await context.post("/api/v1/admin/backups", {
            data: {
              requestId: randomUUID(),
              kind: "full",
              destination: "disk",
            },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.post("/api/v1/admin/backups/" + full + "/restore", {
            headers: { "X-CSRF-Token": csrf },
            data: {
              requestId: randomUUID(),
              target: "isolated",
              confirmation: "RESTORE " + m.hash,
            },
          })
        ).status(),
      ).toBe(403);
      expect((await context.get("/api/v1/admin/backups")).status()).toBe(
        role === "Admin" ? 200 : 403,
      );
      expect(
        (
          await context.get("/api/v1/admin/backups/" + full + "/restore")
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.get(
            "/api/v1/admin/backups/" + full + "/files/manifest.json",
          )
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.get(
            "/api/v1/admin/backups/" + exported + "/files/manifest.json",
          )
        ).status(),
      ).toBe(role === "Admin" ? 200 : 403);
      if (role === "Admin") {
        const partial = await context.get(
          "/api/v1/admin/backups/" + exported + "/files/" + m.volumes[0].name,
          { headers: { Range: "bytes=0-31" } },
        );
        expect(partial.status()).toBe(206);
        expect((await partial.body()).length).toBe(32);
        expect(
          (
            await context.post(
              "/api/v1/admin/backups/" + exported + "/control",
              {
                headers: { "X-CSRF-Token": csrf },
                data: {
                  requestId: randomUUID(),
                  action: "delete",
                  confirmation: "DELETE " + exported,
                },
              },
            )
          ).status(),
        ).toBe(409);
        const id = randomUUID();
        expect(
          (
            await context.post("/api/v1/admin/backups", {
              headers: { "X-CSRF-Token": csrf },
              data: { requestId: id, kind: "platform", destination: "missing" },
            })
          ).status(),
        ).toBe(200);
        await expect
          .poll(
            async () =>
              (
                await db.query("SELECT state FROM backup_runs WHERE id=$1", [
                  id,
                ])
              ).rows[0]?.state,
            { timeout: 60000 },
          )
          .toBe("failed");
        expect(
          (await db.query("SELECT error FROM backup_runs WHERE id=$1", [id]))
            .rows[0].error,
        ).toBe("BACKUP_MOUNT_UNAVAILABLE");
        await expect(access(join(root, "disk", id))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          (
            await context.post("/api/v1/admin/backups", {
              headers: { "X-CSRF-Token": csrf },
              data: { requestId: id, kind: "platform", destination: "missing" },
            })
          ).status(),
        ).toBe(200);
        expect(
          (await db.query("SELECT count(*) FROM backup_runs WHERE id=$1", [id]))
            .rows[0].count,
        ).toBe("1");
      } else {
        expect(
          (
            await context.post("/api/v1/admin/backups", {
              headers: { "X-CSRF-Token": csrf },
              data: {
                requestId: randomUUID(),
                kind: "full",
                destination: "disk",
              },
            })
          ).status(),
        ).toBe(403);
      }
      await context.dispose();
    }
    expect(errors).toEqual([]);
  } finally {
    worker.kill("SIGTERM");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    await db.end();
  }
});
