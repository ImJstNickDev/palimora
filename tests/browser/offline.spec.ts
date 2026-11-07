import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { test, expect, chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("offline reader survives restart, reconciles conflicts and isolates accounts", async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), "palimora-pwa-profile-"));
  let context = await chromium.launchPersistentContext(profile, {
    baseURL: "http://localhost:5173",
  });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const database = process.env.TEST_DATABASE_URL!;
  if (!new URL(database).pathname.includes("test"))
    throw Error("Dedicated database required");
  process.env.DATABASE_URL = database;
  const { ingestRecord } = await import("../../apps/api/dist/archive.js");
  const { pool } = await import("../../apps/api/dist/db.js");
  const batch = randomUUID(),
    source = {
      id: randomUUID(),
      path: "offline-fixture.zip",
      fingerprint: "fixture",
    };
  const password = "A secure offline browser password 82";
  const workerPath = "apps/web/dist/push-worker.js",
    workerOriginal = await readFile(workerPath, "utf8");
  try {
    await pool.query(
      "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
      [batch],
    );
    await pool.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
    const ingest = async (cursor: number) =>
      ingestRecord(source, {
        parser: "offline-browser",
        cursor,
        locator: "work-" + cursor,
        record: {
          external_id: "555123",
          source_entry: "work",
          metadata: { title: ["Offline reading fixture"] },
          chapters: [
            { name: "one.html", title: "First chapter" },
            { name: "two.html", title: "Second chapter" },
          ],
          objects: [
            {
              name: "one.html",
              kind: "chapter_html",
              data: Buffer.from(
                `<link rel="stylesheet" href="style.css"><p class="saved-skin">${cursor > 1 ? "A new introduction. " : ""}First saved passage for precise offline annotations.</p><img src="image.png" alt="Saved illustration">` +
                  Array.from(
                    { length: 15 },
                    (_, n) =>
                      `<p>First chapter paragraph ${n}. Read this passage offline.</p>`,
                  ).join(""),
              ).toString("base64"),
            },
            {
              name: "two.html",
              kind: "chapter_html",
              data: Buffer.from(
                "<p>Second saved chapter with its original words.</p>",
              ).toString("base64"),
            },
            {
              name: "style.css",
              kind: "css",
              data: Buffer.from(".saved-skin{font-style:italic}").toString(
                "base64",
              ),
            },
            {
              name: "image.png",
              kind: "asset",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==",
            },
          ],
          state: "valid",
          observed_at: null,
        },
      });
    await ingest(1);
    const work = (
      await pool.query(
        "SELECT id,current_snapshot_id FROM archive_work_heads WHERE external_id='555123'",
      )
    ).rows[0];
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("offlineowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const me = await (await page.request.get("/api/v1/me")).json();
    const invite = await (
      await page.request.post("/api/v1/invites", {
        headers: { origin: "http://localhost:5173", "x-csrf-token": me.csrf },
        data: { days: 7, maxUses: 1, requestId: randomUUID() },
      })
    ).json();
    const mutationHeaders = {
      origin: "http://localhost:5173",
      "x-csrf-token": me.csrf,
    };
    expect(
      (
        await page.request.post("/api/v1/bookmarks/" + work.id, {
          headers: mutationHeaders,
          data: {
            revision: 0,
            bookmark: {
              notes: "A passage to revisit",
              tags: ["reading group"],
              recommended: false,
              private: true,
            },
          },
        })
      ).ok(),
    ).toBe(true);
    const collection = randomUUID();
    expect(
      (
        await page.request.post("/api/v1/collections", {
          headers: mutationHeaders,
          data: { id: collection, name: "Reading together", description: "" },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.post(
          "/api/v1/collections/" + collection + "/works",
          { headers: mutationHeaders, data: { work: work.id, remove: false } },
        )
      ).ok(),
    ).toBe(true);
    await page.goto("/works/" + work.id);
    await expect(
      page.frameLocator(".reader-frame").locator("p").first(),
    ).toHaveText("First saved passage for precise offline annotations.");
    await page
      .getByRole("button", { name: "Salva offline", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: /Copia offline/ }),
    ).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("link", { name: /Copia offline/ }).click();
    await page.reload();
    const frame = page.frameLocator(".reader-frame");
    await expect(frame.locator("p").first()).toHaveText(
      "First saved passage for precise offline annotations.",
    );
    await expect(frame.locator("img")).toHaveJSProperty("complete", true);
    expect(
      await frame
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(1);
    await page.getByRole("button", { name: "Aspetto", exact: true }).click();
    await page.getByRole("checkbox", { name: /Work Skin/ }).click();
    await expect(
      page.getByRole("checkbox", { name: /Work Skin/ }),
    ).toBeChecked();
    await expect(frame.locator(".saved-skin")).toHaveCSS(
      "font-style",
      "italic",
    );
    await page.getByRole("button", { name: "Scuro", exact: true }).click();
    await expect(frame.locator("body")).toHaveCSS(
      "background-color",
      "rgb(32, 39, 46)",
    );
    await page.getByRole("button", { name: "Chiaro", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Chiudi", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Capitolo", exact: true })
      .selectOption({ label: "2. Second chapter" });
    await expect(frame.locator("p").first()).toHaveText(
      "Second saved chapter with its original words.",
    );
    await page.getByRole("button", { name: "Lettura immersiva" }).click();
    await expect(page.locator(".reader.immersive")).toBeVisible();
    await page
      .getByRole("button", { name: "Esci dalla lettura immersiva" })
      .click();
    await page
      .getByRole("combobox", { name: "Capitolo", exact: true })
      .selectOption("");
    await frame
      .locator("p")
      .first()
      .evaluate((el) => {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const s = el.ownerDocument.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
      });
    await page.getByRole("button", { name: "Annota selezione" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Nota", { exact: true })
      .fill("Written entirely offline");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByLabel("Stato di lettura").selectOption("paused");
    await expect(page.getByText("Salvato sul dispositivo")).toBeVisible();
    await page.clock.setFixedTime(new Date("2026-11-06T10:00:00Z"));
    await page.getByLabel("Stato di lettura").selectOption("reading");
    await expect(page.getByLabel("Stato di lettura")).toHaveValue("reading");
    await page.getByLabel("Stato di lettura").selectOption("paused");
    await expect(page.getByLabel("Stato di lettura")).toHaveValue("paused");
    // Restart the browser process using the on-disk profile while disconnected.
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      baseURL: "http://localhost:5173",
      offline: true,
    });
    context.setDefaultTimeout(15000);
    const restart = await context.newPage();
    await restart.goto(
      "/works/" + work.id + "?local=1&snapshot=" + work.current_snapshot_id,
    );
    await expect(restart.getByLabel("Stato di lettura")).toHaveValue("paused");
    await restart.getByText("Annotazioni", { exact: true }).click();
    await expect(restart.getByText("Written entirely offline")).toBeVisible();
    // A concurrent device changes the server revision while this client is offline.
    const local = await restart.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("palimora-personal-v1");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return await new Promise<any[]>((resolve) => {
        const r = db.transaction("records").objectStore("records").getAll();
        r.onsuccess = () =>
          resolve(r.result.filter((x) => x?.operation === "readingSave"));
      });
    });
    const anchor = local[0].input.anchor;
    await pool.query(
      "INSERT INTO library_progress(user_id,work_id,state,anchor,revision,percent) VALUES($1,$2,'reading',$3,1,20)",
      [me.user.id, work.id, anchor],
    );
    await context.setOffline(false);
    await restart.goto("/offline");
    await expect(restart.getByText("Modifica concorrente")).toBeVisible();
    await restart.getByRole("button", { name: "Risolvi", exact: true }).click();
    await restart
      .getByRole("button", { name: "Mantieni modifica locale" })
      .click();
    await expect(restart.getByRole("dialog")).toBeHidden();
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT state FROM library_progress WHERE user_id=$1 AND work_id=$2",
              [me.user.id, work.id],
            )
          ).rows[0]?.state,
      )
      .toBe("paused");
    await expect
      .poll(async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM library_annotations WHERE user_id=$1",
              [me.user.id],
            )
          ).rows[0].count,
        ),
      )
      .toBe(1);
    // Replaying a committed request is idempotent; changing its payload is rejected.
    const receipt = (
      await pool.query(
        "SELECT request_id FROM library_mutation_receipts WHERE user_id=$1 AND operation='readingSave' ORDER BY created_at DESC LIMIT 1",
        [me.user.id],
      )
    ).rows[0];
    expect(receipt).toBeTruthy();
    const priorVersions = Number(
      (
        await pool.query(
          "SELECT count(*) FROM library_progress_versions WHERE user_id=$1",
          [me.user.id],
        )
      ).rows[0].count,
    );
    const replay = await restart.request.post(
      "/api/v1/reading-progress/" + work.id,
      {
        headers: { origin: "http://localhost:5173", "x-csrf-token": me.csrf },
        data: {
          revision: 1,
          anchor,
          state: "paused",
          requestId: receipt.request_id,
        },
      },
    );
    expect(replay.status()).toBe(200);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM library_progress_versions WHERE user_id=$1",
            [me.user.id],
          )
        ).rows[0].count,
      ),
    ).toBe(priorVersions);
    await ingest(2);
    // The dump is chronologically uncertain: explicitly publish the newer test snapshot.
    await pool.query(
      "UPDATE archive_work_heads SET current_snapshot_id=(SELECT id FROM archive_snapshots WHERE work_id=$1 AND id<>$2 ORDER BY imported_at DESC LIMIT 1) WHERE id=$1",
      [work.id, work.current_snapshot_id],
    );
    await restart.getByRole("button", { name: "Sincronizza" }).click();
    const cdp = await context.newCDPSession(restart);
    const manifest = await cdp.send("Page.getAppManifest");
    expect(manifest.errors).toEqual([]);
    await cdp.send("Storage.overrideQuotaForOrigin", {
      origin: "http://localhost:5173",
      quotaSize: 1,
    });
    await restart
      .getByRole("button", { name: "Scarica nuova versione" })
      .click();
    await expect(
      restart.getByText(
        "Spazio insufficiente. Rimuovi alcune copie e riprova.",
      ),
    ).toBeVisible();
    await expect(
      restart.getByRole("link", {
        name: "Offline reading fixture",
        exact: true,
      }),
    ).toHaveCount(1);
    await cdp.send("Storage.overrideQuotaForOrigin", {
      origin: "http://localhost:5173",
    });
    await restart
      .getByRole("button", { name: "Scarica nuova versione" })
      .click();
    await expect(
      restart.getByRole("link", {
        name: "Offline reading fixture",
        exact: true,
      }),
    ).toHaveCount(2);
    {
      await writeFile(
        workerPath,
        workerOriginal.replace(
          /const APP_VERSION = '[^']+'/,
          "const APP_VERSION = 'integration-update'",
        ),
      );
      await restart.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        await r!.update();
      });
      await expect(
        restart.getByRole("button", { name: "Aggiorna applicazione" }),
      ).toBeVisible();
      await Promise.all([
        restart.waitForEvent("load"),
        restart.getByRole("button", { name: "Aggiorna applicazione" }).click(),
      ]);
      await expect(
        restart.getByRole("link", {
          name: "Offline reading fixture",
          exact: true,
        }),
      ).toHaveCount(2);
    }
    for (const route of [
      "library",
      "collections",
      "collections/" + collection,
      "statistics",
      "activity",
      "subscriptions",
      "notifications",
      "social-settings",
      "offline",
    ]) {
      await restart.goto("/" + route);
      await expect(restart.locator("main h1")).toBeVisible();
      await expect(
        restart.getByText("Caricamento…", { exact: true }),
      ).toHaveCount(0);
      for (const width of [390, 820]) {
        await restart.setViewportSize({ width, height: 1000 });
        expect(
          await restart.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await restart.setViewportSize({ width: 390, height: 1000 });
      await restart.screenshot({
        path: info.outputPath("review-" + route.replaceAll("/", "-") + ".png"),
        fullPage: true,
      });
    }
    const latest = (
      await pool.query(
        "SELECT current_snapshot_id FROM archive_work_heads WHERE id=$1",
        [work.id],
      )
    ).rows[0].current_snapshot_id;
    await context.setOffline(true);
    await restart.goto(`/works/${work.id}?local=1&snapshot=${latest}`);
    await expect(
      restart.frameLocator(".reader-frame").locator("p").first(),
    ).toContainText("A new introduction.");
    await restart.getByText("Annotazioni", { exact: true }).click();
    await expect(restart.getByText("Written entirely offline")).toBeVisible();
    for (const width of [390, 820]) {
      await restart.setViewportSize({ width, height: 1000 });
      expect(
        await restart.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await restart.screenshot({
        path: info.outputPath(`offline-${width}.png`),
        fullPage: true,
      });
    }
    await restart.getByRole("button", { name: "Esci", exact: true }).click();
    const discard = restart.getByRole("button", {
      name: "Elimina dati locali ed esci",
    });
    if (await discard.isVisible()) await discard.click();
    await expect(
      restart.getByRole("button", { name: "Accedi", exact: true }),
    ).toBeVisible();
    const localCount = await restart.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("palimora-personal-v1");
        r.onsuccess = () => resolve(r.result);
      });
      return await new Promise<number>((resolve) => {
        const r = db.transaction("records").objectStore("records").getAllKeys();
        r.onsuccess = () =>
          resolve(
            r.result.filter(
              (k) =>
                String(k).startsWith("work:") ||
                String(k).startsWith("asset:") ||
                String(k).startsWith("queue:"),
            ).length,
          );
      });
    });
    expect(localCount).toBe(0);
    await context.setOffline(false);
    await restart.reload();
    await expect(
      restart.getByRole("button", { name: "Accedi", exact: true }),
    ).toBeVisible();
    await restart.goto("/register#" + invite.token);
    await restart
      .getByLabel("Nome utente", { exact: true })
      .fill("offlinereader");
    await restart.getByLabel("Password", { exact: true }).fill(password);
    await restart.getByRole("button", { name: "Crea account" }).click();
    await expect(
      restart.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await restart.goto("/offline");
    await expect(
      restart.getByText("Nessuna opera salvata su questo dispositivo."),
    ).toBeVisible();
    const cacheURLs = await restart.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys())
        for (const r of await (await caches.open(name)).keys())
          urls.push(r.url);
      return urls;
    });
    expect(cacheURLs.some((url) => url.includes("/api/"))).toBe(false);
    await context.setOffline(true);
    await restart.goto(`/works/${work.id}?local=1&snapshot=${latest}`);
    await expect(restart.locator(".reader-frame")).toHaveCount(0);
    expect(await restart.content()).not.toContain("Written entirely offline");
    await context.setOffline(false);
    await restart.goto("/works/" + work.id);
    await restart
      .getByRole("button", { name: "Salva offline", exact: true })
      .click();
    await expect(
      restart.getByRole("link", { name: /Copia offline/ }),
    ).toBeVisible();
    const secondMe = await (await restart.request.get("/api/v1/me")).json();
    await context.setOffline(true);
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      secondMe.session.id,
    ]);
    await restart.reload();
    await expect(restart.locator(".reader-frame")).toBeVisible();
    await context.setOffline(false);
    await restart.reload();
    await expect(
      restart.getByRole("button", { name: "Accedi", exact: true }),
    ).toBeVisible();
    const privateRecords = await restart.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("palimora-personal-v1");
        r.onsuccess = () => resolve(r.result);
      });
      return await new Promise<string[]>((resolve) => {
        const r = db.transaction("records").objectStore("records").getAllKeys();
        r.onsuccess = () => resolve(r.result.map(String));
      });
    });
    expect(
      privateRecords.filter((k) =>
        /^(work|copy|asset|queue|notes|progress):/.test(k),
      ),
    ).toEqual([]);
  } finally {
    await writeFile(workerPath, workerOriginal);
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await pool.end();
  }
});
