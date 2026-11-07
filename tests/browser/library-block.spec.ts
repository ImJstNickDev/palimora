import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("collection management and reader progress with anchored annotations on mobile", async ({
  page,
}, testInfo) => {
  const database = process.env.TEST_DATABASE_URL!;
  if (!new URL(database).pathname.includes("test"))
    throw Error("Dedicated test database required");
  process.env.DATABASE_URL = database;
  const { ingestRecord } = await import("../../apps/api/dist/archive.js");
  const { pool } = await import("../../apps/api/dist/db.js");
  const batch = randomUUID(),
    source = { id: randomUUID(), path: "browser.zip", fingerprint: "fixture" };
  try {
    await pool.query(
      "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
      [batch],
    );
    await pool.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
    await ingestRecord(source, {
      parser: "browser-test",
      cursor: 1,
      locator: "work",
      record: {
        external_id: "456789",
        source_entry: "work",
        metadata: { title: ["Reading fixture"] },
        chapters: [{ name: "chapter" }],
        objects: [
          {
            name: "chapter",
            kind: "chapter_html",
            data: Buffer.from(
              Array.from(
                { length: 30 },
                (_, i) =>
                  `<p>Paragraph ${i}. Reading together preserves every original passage. Words for a precise position in the chapter.</p>`,
              ).join(""),
            ).toString("base64"),
          },
        ],
        state: "valid",
        observed_at: null,
      },
    });
    const work = (
      await pool.query(
        "SELECT id FROM archive_work_heads WHERE external_id='456789'",
      )
    ).rows[0].id;
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("blockowner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("A secure library block password 82");
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await page.goto("/collections");
    await page
      .getByRole("button", { name: "Nuova collezione", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Nome", { exact: true })
      .fill("Reading group");
    await page.getByRole("button", { name: "Crea", exact: true }).click();
    await page
      .getByRole("link", { name: "Reading group", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Reading group" }),
    ).toBeVisible();
    await page.goto("/works/" + work);
    await page.getByRole("button", { name: "Aggiungi a collezione" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reading group" })
      .click();
    const frame = page.frameLocator(".reader-frame");
    await expect(frame.locator("p").first()).toBeVisible();
    await frame
      .locator("p")
      .nth(8)
      .evaluate((el) => {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const s = el.ownerDocument.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
      });
    await expect(
      page.getByRole("button", { name: "Annota selezione" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Annota selezione" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Nota", { exact: true })
      .fill("Preserve this reference");
    await page
      .getByRole("dialog")
      .getByLabel("Visibilità")
      .selectOption({ label: "Reading group" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByLabel("Stato di lettura").selectOption("paused");
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT state FROM library_progress WHERE work_id=$1",
              [work],
            )
          ).rows[0]?.state,
      )
      .toBe("paused");
    await page.getByText("Annotazioni", { exact: true }).click();
    await expect(page.getByText("Preserve this reference")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("reading-mobile.png"),
      fullPage: false,
    });
    await frame.locator("p").nth(20).scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        Number(
          (
            await pool.query(
              "SELECT percent FROM library_progress WHERE work_id=$1",
              [work],
            )
          ).rows[0]?.percent ?? 0,
        ),
      )
      .toBeGreaterThan(20);
    await page.reload();
    await expect(page.getByLabel("Stato di lettura")).toHaveValue("paused");
    await page.goto("/collections");
    await page
      .getByRole("link", { name: "Reading group", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Reading fixture" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("collection-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 820, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("collection-tablet.png"),
      fullPage: true,
    });
  } finally {
    await pool.end();
  }
});
