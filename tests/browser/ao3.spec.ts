import { test, expect } from "@playwright/test";
import { Pool } from "pg";
test("AO3 control panel distinguishes suspended jobs and recovers a selected missing media", async ({
  page,
}) => {
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await db.query("BEGIN");
    await db.query(
      "DELETE FROM ao3_uploads WHERE url='https://media.example.test/lost.png'",
    );
    await db.query(
      "UPDATE ao3_control SET mode='auto',paused=false,observed_state='maintenance',checked_at=now(),cooldown_until=now()+interval '1 hour'",
    );
    await db.query(
      "INSERT INTO ao3_jobs(kind,target,error,attempts,started_at) VALUES('media','https://media.example.test/lost.png','MEDIA_UNRECOVERABLE',1,now()),('media','https://media.example.test/temporary.png','MEDIA_NETWORK',1,now()) ON CONFLICT(kind,target) DO UPDATE SET error=excluded.error,checkpoint='{}'::jsonb,state='retry'",
    );
    const work = (
      await db.query(
        "INSERT INTO archive_work_heads(id,external_id) VALUES(gen_random_uuid(),'789') ON CONFLICT(external_id) DO UPDATE SET external_id=excluded.external_id RETURNING id",
      )
    ).rows[0];
    await db.query(
      "INSERT INTO catalog_documents(work_id,title,metadata) VALUES($1,'A preserved story','{}') ON CONFLICT(work_id) DO NOTHING",
      [work.id],
    );
    await db.query(
      "INSERT INTO archive_media_references(work_id,url) VALUES($1,'https://media.example.test/lost.png') ON CONFLICT DO NOTHING",
      [work.id],
    );
    await db.query("DELETE FROM catalog_pending WHERE work_id=$1", [work.id]);
    await db.query("COMMIT");
  } finally {
    await db.end();
  }
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  if (await page.getByLabel("Nome utente Owner").isVisible()) {
    await page.getByLabel("Nome utente Owner").fill("syncowner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("A secure synchronization test password 19");
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
  } else {
    await page.getByLabel("Nome utente", { exact: true }).fill("syncowner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("A secure synchronization test password 19");
    await page.getByRole("button", { name: "Accedi", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await page.goto("/admin/ao3");
  await expect(
    page.getByRole("heading", { name: "Sincronizzazione AO3" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sincronizzazione sospesa", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Offline/ }).check();
  await expect(
    page.getByText("Modalità Offline.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: /Offline/ })).toBeChecked();
  await page.getByRole("radio", { name: /Auto/ }).check();
  await expect(page.getByRole("radio", { name: /Auto/ })).toBeChecked();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/m4/ao3-overview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".local/m4/ao3-overview-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("navigation", { name: "Sezioni sincronizzazione AO3" })
    .getByRole("link", { name: "Coda", exact: true })
    .click();
  await page.getByRole("button", { name: "Accoda verifica" }).click();
  await page.getByLabel("ID AO3", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Conferma accodamento" }).click();
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "AO3 · 123456", exact: true }),
  });
  await expect(
    row.getByText("In attesa di AO3", { exact: true }),
  ).toBeVisible();
  await expect(row.getByText("Alla ripresa del servizio")).toBeVisible();
  await row.getByRole("button", { name: "Pausa", exact: true }).click();
  await expect(row.getByRole("button", { name: "Riprendi" })).toBeVisible();
  await page.screenshot({
    path: ".local/m4/ao3-queue-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("navigation", { name: "Sezioni sincronizzazione AO3" })
    .getByRole("link", { name: /Media da recuperare/ })
    .click();
  await expect(page.getByText("lost.png", { exact: true })).toBeVisible();
  await expect(page.getByText("temporary.png", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Recupera media" }).click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "A preserved story" }),
  ).toBeVisible();
  await page.getByLabel("Copia locale del media").setInputFiles({
    name: "recovered.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+wAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.screenshot({
    path: ".local/m4/ao3-recover-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Carica copia locale", exact: true })
    .click();
  await expect(
    page.getByText("Copia caricata e accodata per l’acquisizione locale."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chiudi", exact: true }).click();
  await expect(
    page.getByText("Copia locale in attesa di acquisizione"),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/m4/ao3-media-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Sezioni sincronizzazione AO3" })
    .getByRole("link", { name: "Impostazioni", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Priorità dello scheduler" }),
  ).toBeVisible();
  await expect(page.locator(".sync-view details")).toHaveCount(0);
  await page.screenshot({
    path: ".local/m4/ao3-settings-desktop.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.skin = "forest";
  });
  await page.screenshot({
    path: ".local/m4/ao3-settings-dark.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
