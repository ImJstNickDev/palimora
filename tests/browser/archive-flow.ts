import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

// Real catalog and pack writes in the disposable browser database/storage.
async function seedArchive() {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.includes("test") ||
    !process.env.ARCHIVE_ROOT?.startsWith(
      resolve(process.env.PALIMORA_TEST_ROOT || tmpdir()) + sep,
    )
  )
    throw Error("Isolated archive test environment required");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool } = require("../../apps/api/dist/db.js");
  const { ingestRecord } = require("../../apps/api/dist/archive.js");
  const batch = randomUUID();
  const source = {
    id: randomUUID(),
    path: "browser-sample.zip",
    fingerprint: "browser-verified",
  };
  try {
    for (const [path, size, state] of [
      [source.path, 2048, "discovered"],
      ["browser-metadata.sqlite3", 4096, "discovered"],
      ["browser-incomplete.zip.part", 128, "incomplete_transfer"],
    ])
      await pool.query(
        "INSERT INTO ingest_inventory(path,size,state) VALUES($1,$2,$3) ON CONFLICT(path) DO NOTHING",
        [path, size, state],
      );
    await pool.query(
      "INSERT INTO ingest_batches(id,state,selection,started_at) VALUES($1,'running',$2,now())",
      [batch, [source.path]],
    );
    await pool.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state,total) VALUES($1,$2,$3,$4,'valid',2)",
      [source.id, batch, source.path, source.fingerprint],
    );
    for (let version = 1; version <= 2; version++)
      await ingestRecord(source, {
        parser: "browser-1",
        cursor: version,
        locator: `story-${version}.html`,
        record: {
          external_id: "987654321",
          metadata: {
            Title: "The preserved archive",
            Author: "Archive author",
            Summary: "Two immutable versions",
            Category: "Preserved fandom",
            Rating: "General Audiences",
            Words: 3000,
            Language: "English",
          },
          state: "valid",
          observed_at: null,
          chapters: [{ name: "chapter.html" }],
          objects: [
            {
              name: "pixel.png",
              kind: "asset",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZaoAAAAASUVORK5CYII=",
            },
            {
              name: "chapter.html",
              kind: "chapter_html",
              data: Buffer.from(
                `<p>Preserved version ${version}</p><img src="pixel.png" alt="Preserved image"><script>window.unsafeArchive=true</script>`,
              ).toString("base64"),
            },
          ],
        },
      });
    await pool.query("UPDATE ingest_sources SET state='ingested' WHERE id=$1", [
      source.id,
    ]);
    const gap = randomUUID();
    await pool.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state,gaps,error) VALUES($1,$2,'browser-absent.zip','missing','missing_source',1,$3)",
      [gap, batch, { code: "MISSING_SOURCE" }],
    );
    await pool.query(
      "INSERT INTO ingest_issues(source_id,locator,code,detail,fingerprint) VALUES($1,'absent','MISSING_SOURCE',$2,'missing')",
      [gap, { message: "Source unavailable" }],
    );
    await pool.query(
      "UPDATE ingest_batches SET state='completed_with_gaps',finished_at=now() WHERE id=$1",
      [batch],
    );
    return { batch };
  } finally {
    await pool.end();
  }
}
export async function archiveFlow(page: Page) {
  const fixture = await seedArchive();
  await page.goto("/works?fulltext=Preserved");
  await expect(
    page.getByRole("link", { name: "The preserved archive", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const filterPanel = page.locator(".filter-drawer");
  await filterPanel.locator(":scope > summary").evaluate((el) => {
    const d = el.parentElement as HTMLDetailsElement;
    if (!d.open) el.click();
  });
  const tagInput = page.getByRole("combobox", {
    name: "Tag da includere",
    exact: true,
  });
  await expect(
    page.getByRole("searchbox", { name: "Cerca nei metadati" }),
  ).toHaveAttribute("autocomplete", "off");
  await expect(tagInput).toHaveAttribute("data-1p-ignore", "true");
  await tagInput.fill("Preserved");
  await expect(
    page.getByRole("option", { name: /Preserved fandom/ }),
  ).toBeVisible();
  await tagInput.press("ArrowDown");
  await tagInput.press("Enter");
  await expect(
    page.getByText("Modifiche da applicare", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("fandom")).toBe(false);
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page).toHaveURL(/fandom=Preserved/);
  await expect(page.locator(".work-blurb")).toHaveCount(1);
  await page.getByRole("button", { name: "− Escludi", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Tag da escludere", exact: true })
    .fill("Preserved");
  await page.getByRole("option", { name: /Preserved fandom/ }).click();
  await expect(
    page.locator('.selected-tags [data-excluded="true"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('.selected-tags [data-excluded="false"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page.locator(".work-blurb")).toHaveCount(0);
  await page.getByRole("button", { name: /Rimuovi filtro: Esclusi:/ }).click();
  await expect(page.locator(".work-blurb")).toHaveCount(1);
  await page
    .locator(".filter-group > summary")
    .filter({ hasText: "Lunghezza" })
    .click();
  await page
    .getByRole("spinbutton", { name: "Parole · Minimo", exact: true })
    .fill("1000");
  await page
    .getByRole("spinbutton", { name: "Parole · Massimo", exact: true })
    .fill("5000");
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page).toHaveURL(/words=1000-5000/);
  await expect(page.locator(".work-blurb")).toHaveCount(1);
  await page.getByRole("button", { name: "Azzera", exact: true }).click();
  await expect(page).toHaveURL(/fulltext=Preserved/);
  expect(new URL(page.url()).searchParams.has("words")).toBe(false);
  await page
    .locator(".filter-group > summary")
    .filter({ hasText: "Stato e lingua" })
    .click();
  const language = page.getByRole("combobox", { name: "Lingua", exact: true });
  await language.fill("Eng");
  await expect(page.getByRole("option", { name: /English/ })).toBeVisible();
  await language.press("ArrowDown");
  await language.press("Enter");
  await expect(
    page.getByRole("list", { name: "Lingue selezionate" }),
  ).toContainText("English");
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page).toHaveURL(/language=English/);
  await expect(page.locator(".work-blurb")).toHaveCount(1);
  await language.fill("Italiano");
  await language.press("Enter");
  await expect(
    page.getByRole("list", { name: "Lingue selezionate" }).locator("li"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page).toHaveURL(/language=English%0AItaliano/);
  await expect(page.locator(".work-blurb")).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Lingue selezionate" }).locator("li"),
  ).toHaveCount(2);
  await page
    .getByRole("button", {
      name: "Rimuovi filtro: Lingua: English",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/language=Italiano/);
  await expect(page.locator(".work-blurb")).toHaveCount(0);
  await language.fill("Eng");
  await expect(page.getByRole("option", { name: /English/ })).toBeVisible();
  await language.press("ArrowDown");
  await language.press("Enter");
  await page
    .getByRole("button", { name: "Rimuovi lingua: Italiano", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Applica filtri", exact: true })
    .click();
  await expect(page).toHaveURL(/language=English/);
  await expect(page.locator(".work-blurb")).toHaveCount(1);

  await page
    .getByRole("link", { name: "The preserved archive", exact: true })
    .click();
  await expect(page.frameLocator("iframe").locator("#workskin")).toContainText(
    "Preserved version 1",
  );
  const image = page.frameLocator("iframe").getByAltText("Preserved image");
  await expect(image).toBeVisible();
  const media = await image.getAttribute("src");
  const partial = await page.request.get(media!, {
    headers: { Range: "bytes=0-7" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-type"]).toBe("image/png");
  expect((await partial.body()).length).toBe(8);
  expect(
    (
      await page.request.get(media!, { headers: { Range: "bytes=9999-" } })
    ).status(),
  ).toBe(416);
  await page.getByRole("button", { name: "Versioni", exact: true }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Versione", exact: true })
      .locator("option"),
  ).toHaveCount(3);
  const choices = await page
    .getByRole("combobox", { name: "Versione", exact: true })
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  await page
    .getByRole("combobox", { name: "Versione", exact: true })
    .selectOption(choices[1]);
  await expect(page.frameLocator("iframe").locator("#workskin")).toContainText(
    "Preserved version 2",
  );
  await page
    .getByRole("button", { name: "Versione storica", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Versione", exact: true })
    .selectOption("");
  await expect(page.frameLocator("iframe").locator("#workskin")).toContainText(
    "Preserved version 1",
  );
  await expect(page.getByRole("radio", { name: /EPUB/ })).toHaveCount(0);
  for (const format of ["html", "epub"]) {
    await page
      .getByRole("button", { name: "Scarica opera", exact: true })
      .click();
    await page
      .getByRole("radio", { name: new RegExp(format.toUpperCase()) })
      .check();
    const received = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: "Scarica " + format.toUpperCase(),
        exact: true,
      })
      .click();
    const download = await received;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    if (format === "html")
      expect(data.toString()).toContain("Preserved version 1");
    else expect(data.subarray(0, 2).toString()).toBe("PK");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(
    await page.evaluate(() => Boolean((window as any).unsafeArchive)),
  ).toBe(false);
  await page
    .getByRole("link", { name: "Torna ai risultati", exact: true })
    .click();
  await expect(page).toHaveURL(/language=English/);
  await expect(page).toHaveURL(/fulltext=Preserved/);
  await page
    .getByRole("link", { name: "Amministrazione", exact: true })
    .click();
  await page.getByRole("link", { name: "Importazioni", exact: true }).click();
  await page
    .getByRole("button", { name: "Nuova importazione", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Avvia importazione", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Cerca sorgenti").fill("browser-sample");
  await page.getByRole("checkbox").check();
  await page.screenshot({
    path: ".local/archive-import-desktop.png",
    fullPage: true,
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/admin/ingest") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Avvia importazione", exact: true })
    .click();
  const batch = await (await created).json();
  expect(batch.selection).toEqual(["browser-sample.zip"]);
  await expect(page).toHaveURL(new RegExp(batch.id));
  await page.getByRole("button", { name: "Pausa", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Riprendi", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Riprendi", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pausa", exact: true }),
  ).toBeVisible();
  await page.goto("/admin/ingest/" + fixture.batch);
  await page
    .getByLabel("Mostra sorgenti", { exact: true })
    .selectOption("issues");
  await expect(page.locator(".archive-source-result")).toHaveCount(1);
  await page.locator(".archive-source-result > summary").click();
  await page
    .getByRole("link", { name: "Apri anomalie della sorgente" })
    .click();
  await expect(page.getByText("MISSING_SOURCE", { exact: true })).toBeVisible();
  const report = page.waitForEvent("download");
  await page.getByRole("button", { name: "Scarica report JSON" }).click();
  expect((await report).suggestedFilename()).toBe(
    "ingest-" + fixture.batch + ".json",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/archive-batch-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Archivio tecnico", exact: true })
    .click();
  await page.getByLabel("Titolo, ID AO3 o ID locale").fill("987654321");
  await page.getByRole("button", { name: "Cerca", exact: true }).click();
  await page
    .getByRole("link", { name: "The preserved archive", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Versione corrente", exact: true }),
  ).toBeVisible();
  await page
    .locator(".archive-component")
    .filter({ hasText: "chapter.html" })
    .first()
    .click();
  await expect(page.locator(".archive-code")).toContainText(
    "Preserved version",
  );
  expect(
    await page.evaluate(() => Boolean((window as any).unsafeArchive)),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/archive-work-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/archive-work-desktop.png",
    fullPage: true,
  });
  await page.locator(".archive-version[aria-pressed=false]").first().click();
  await page
    .getByRole("button", { name: "Imposta come corrente", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Conferma decisione" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Motivo della decisione")
    .fill("Verified preserved version");
  await dialog.getByRole("button", { name: "Conferma decisione" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Versione corrente", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Riconciliazione", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Evidenze dei metadati" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Usa valore", exact: true })
    .first()
    .click();
  await dialog
    .getByLabel("Motivo della decisione")
    .fill("Verified metadata provenance");
  await dialog.getByRole("button", { name: "Conferma decisione" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "Storage", exact: true }).click();
  await expect(page.locator("nav a.active")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Composizione dell’archivio" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Compatta pack", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Avvia manutenzione" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".archive-job")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Compatta pack", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: ".local/archive-storage-desktop.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.skin = "forest";
  });
  await page.screenshot({
    path: ".local/archive-storage-dark.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "auto";
    document.documentElement.dataset.skin = "ink";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/archive-storage-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Finish the real queued compaction, then exercise the dev reset through the
  // same API, worker and disposable Redis used by the application.
  await promisify(execFile)(
    process.execPath,
    [
      "-e",
      `
    const {maintenanceTick}=require('./apps/api/dist/archive-maintenance');
    const {pool}=require('./apps/api/dist/db');
    (async()=>{
      await maintenanceTick();
      // Remove only personal state generated by this reader fixture. The dev
      // reset itself must reject personal references, as the storage test checks.
      for(const table of ['library_progress_versions','library_progress','reading_intervals','reading_heartbeat','library_readings'])
        await pool.query('DELETE FROM '+table);
      await pool.end();
    })().catch(e=>{console.error(e);process.exit(1)});
  `,
    ],
    { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Reset archivio dev", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Elimina archivio dev" }),
  ).toBeDisabled();
  await dialog.getByLabel("Conferma reset").fill("RESET");
  await page.screenshot({
    path: ".local/archive-dev-reset.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Elimina archivio dev" }).click();
  await expect(dialog).toHaveCount(0);
  if (!process.env.REDIS_HOST)
    throw Error("Disposable Redis required for dev reset verification");
  const worker = spawn(process.execPath, ["apps/api/dist/ingest-worker.js"], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      PALIMORA_DEV: "1",
      AO3_DUMP_ROOT: process.env.ARCHIVE_ROOT + "/absent-dump",
    },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Reset worker exited: " + code)),
    );
    worker.once("error", reject);
  });
  // Attach rejection handling immediately while Playwright polls the UI.
  void exited.catch(() => {});
  try {
    await expect(
      page.getByText("Archivio svuotato. Account e dump conservati.", {
        exact: false,
      }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("Nessun oggetto archiviato", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".archive-job")).toHaveCount(1);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(process.env.ARCHIVE_ROOT + "/packs")).toEqual([]);
    expect(await readdir(process.env.ARCHIVE_ROOT + "/staging")).toEqual([]);
  } finally {
    worker.kill("SIGTERM");
    const force = setTimeout(() => worker.kill("SIGKILL"), 10000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
}
