import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("entire work tracks long desktop passages and keeps position in focus mode", async ({
  page,
}, info) => {
  const database = process.env.TEST_DATABASE_URL!;
  if (!new URL(database).pathname.includes("test"))
    throw Error("Dedicated database required");
  process.env.DATABASE_URL = database;
  const { ingestRecord } = await import("../../apps/api/dist/archive.js");
  const { pool } = await import("../../apps/api/dist/db.js");
  const batch = randomUUID(),
    source = {
      id: randomUUID(),
      path: "reader-flow.zip",
      fingerprint: "fixture",
    };
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
        external_id: "789123",
        source_entry: "work",
        metadata: {
          title: ["The long passage"],
          language: ["English"],
          creators: ["A reader"],
          summary: "A story with long passages and several chapters.",
        },
        chapters: [
          { name: "one", title: "First chapter" },
          { name: "two", title: "Second chapter" },
        ],
        objects: ["one", "two"].map((name, i) => ({
          name,
          kind: "chapter_html",
          data: Buffer.from(
            `<h2>${i + 1}. A long chapter</h2><div><p>${Array.from({ length: 600 }, (_, n) => `Sentence ${i}-${n}. The path continued between the trees, beyond the river and the quiet houses. `).join("")}</p></div>`,
          ).toString("base64"),
        })),
        state: "valid",
        observed_at: null,
      },
    });
    const work = (
      await pool.query(
        "SELECT id FROM archive_work_heads WHERE external_id='789123'",
      )
    ).rows[0].id;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("readerowner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("A secure reader flow password 82");
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await page.goto("/works/" + work);
    await expect(
      page.frameLocator(".reader-frame").locator("p").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Leggi", exact: true }).click();
    // Exercise the fallback used when a browser does not expose WebKit's caret API.
    await page.locator(".reader-frame").evaluate((f) => {
      Object.defineProperty(
        (f as HTMLIFrameElement).contentDocument!,
        "caretRangeFromPoint",
        { value: undefined, configurable: true },
      );
    });
    await page.mouse.move(720, 600);
    await page.mouse.wheel(0, 8000);
    await page.waitForTimeout(3000);
    const captured = () =>
      page.evaluate(async () =>
        (await import(/* @vite-ignore */ "/src/reading.tsx")).capture(
          document.querySelector<HTMLElement>(".reader")!.dataset.snapshot,
        ),
      );
    const before = await captured();
    await info.attach("captured-before", {
      body: JSON.stringify(before),
      contentType: "application/json",
    });
    expect(before?.offset).toBeGreaterThan(1000);
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
      .toBeGreaterThan(1);
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    await expect
      .poll(async () => Math.abs((await captured()).offset - before.offset))
      .toBeLessThan(160);
    await page
      .getByRole("button", {
        name: "Esci dalla lettura immersiva",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => Math.abs((await captured()).offset - before.offset))
      .toBeLessThan(160);
    await page.locator(".reader-frame").evaluate((f) => {
      Object.defineProperty(
        (f as HTMLIFrameElement).contentDocument!,
        "caretPositionFromPoint",
        { value: undefined, configurable: true },
      );
    });
    await page.evaluate(() => window.scrollBy(0, 1500));
    const geometric = await captured();
    expect(geometric.offset).toBeGreaterThan(before.offset);
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    await expect
      .poll(async () => Math.abs((await captured()).offset - geometric.offset))
      .toBeLessThan(160);
    await expect(
      page.locator(".reader-toolbar .reader-progress-status"),
    ).toHaveCount(0);
    await expect(
      page.locator(".reader-chapter-nav .reader-progress-status"),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("focus-desktop.png") });
    await page
      .getByRole("button", { name: "Capitolo successivo", exact: true })
      .click();
    await expect
      .poll(async () => (await captured()).chapter)
      .not.toBe(before.chapter);
    await expect(
      page
        .frameLocator(".reader-frame")
        .locator('.chapter[tabindex="-1"]:focus'),
    ).toHaveCSS("outline-style", "none");
    await expect(page.locator(".reader-frame")).toHaveCSS(
      "outline-style",
      "none",
    );
    await expect(
      page.getByRole("combobox", { name: "Capitolo", exact: true }),
    ).toHaveValue("");
    await page
      .getByRole("button", { name: "Capitolo precedente", exact: true })
      .click();
    await expect
      .poll(async () => (await captured()).chapter)
      .toBe(before.chapter);
    await page
      .getByRole("button", {
        name: "Esci dalla lettura immersiva",
        exact: true,
      })
      .click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page
      .getByRole("button", { name: "Salva in biblioteca", exact: true })
      .click();
    await expect(page.locator(".new-collection")).toHaveText(
      "Nuova collezione",
    );
    await page
      .getByRole("button", { name: "Nuova collezione", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Nome", { exact: true })
      .fill("From the reader");
    await page
      .getByRole("button", { name: "Crea e aggiungi", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Nuova collezione", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Nuova collezione", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Nome", { exact: true })
      .fill("Second shelf");
    await page
      .getByRole("button", { name: "Crea e aggiungi", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Second shelf",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM library_collection_works WHERE work_id=$1",
          [work],
        )
      ).rows[0].n,
    ).toBe(2);
    await page.keyboard.press("Escape");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM library_collection_works w JOIN library_collections c ON c.id=w.collection_id WHERE c.name='From the reader' AND w.work_id=$1",
          [work],
        )
      ).rows[0].count,
    ).toBe(1);
    await page
      .getByRole("button", { name: "Salvato in biblioteca", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "From the reader",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Gestisci collezioni" }),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("collection-menu.png") });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    await page.locator(".reader-frame").evaluate((f) => {
      const doc = (f as HTMLIFrameElement).contentDocument!,
        node = doc.querySelector("p")!.firstChild!;
      const range = doc.createRange();
      range.setStart(node, 80);
      range.setEnd(node, 140);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.locator(".reader-annotate-selection")).toBeVisible();
    const geometry = await page.locator(".reader-frame").evaluate((f) => {
      const doc = (f as HTMLIFrameElement).contentDocument!,
        r = doc.getSelection()!.getRangeAt(0).getBoundingClientRect(),
        box = f.getBoundingClientRect();
      return { top: r.top + box.top, bottom: r.bottom + box.top };
    });
    const action = await page
      .locator(".reader-annotate-selection")
      .boundingBox();
    expect(
      Math.min(
        Math.abs(action!.y + action!.height - geometry.top),
        Math.abs(action!.y - geometry.bottom),
      ),
    ).toBeLessThan(70);
    await page.locator(".reader-annotate-selection").click();
    await page
      .getByRole("dialog")
      .getByLabel("Nota", { exact: true })
      .fill("A note beside this passage.");
    await page.screenshot({ path: info.outputPath("annotation-editor.png") });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.locator(".reading-panel > summary").click();
    await expect(page.getByText("A note beside this passage.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("notes-mobile.png") });
    await page
      .getByRole("button", { name: "Chiudi strumenti di lettura" })
      .click();
    await page.screenshot({ path: info.outputPath("focus-mobile.png") });
  } finally {
    await pool.end();
  }
});
