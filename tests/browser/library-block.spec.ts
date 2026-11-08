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
        metadata: { title: ["Reading fixture"], language: ["English"] },
        chapters: [
          { name: "chapter" },
          { name: "second", title: "Second chapter" },
        ],
        objects: [
          {
            name: "second",
            kind: "chapter_html",
            data: Buffer.from("<p>A separate chapter.</p>").toString("base64"),
          },
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
    await pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,'invitedreader','test','User')",
      [randomUUID()],
    );
    await expect(page.locator("details.library-options")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Membri e condivisione", exact: true })
      .click();
    const membersMenu = page.getByRole("dialog", {
      name: "Membri e condivisione",
    });
    await membersMenu.getByLabel("Cerca utenti").fill("invited");
    await membersMenu
      .getByRole("checkbox", { name: "invitedreader", exact: true })
      .check();
    await membersMenu
      .getByRole("button", { name: "Invita (1)", exact: true })
      .click();
    await expect(
      membersMenu.getByText("Sola lettura · Invito in attesa", { exact: true }),
    ).toBeVisible();
    await expect(
      membersMenu.getByRole("checkbox", { name: "invitedreader", exact: true }),
    ).toHaveCount(0);
    await membersMenu
      .getByRole("button", {
        name: "Modifica permesso di invitedreader",
        exact: true,
      })
      .click();
    await membersMenu
      .getByLabel("Permessi di invitedreader")
      .selectOption("Editor");
    await expect(
      membersMenu.getByText("Può modificare · Invito in attesa", {
        exact: true,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await membersMenu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath("collection-members-mobile.png"),
    });
    await membersMenu
      .getByRole("button", { name: "Rimuovi invitedreader", exact: true })
      .click();
    await membersMenu
      .getByRole("button", { name: "Rimuovi", exact: true })
      .click();
    await expect(
      membersMenu.locator(".collection-member-list"),
    ).not.toContainText("invitedreader");
    await page.keyboard.press("Escape");
    await expect(membersMenu).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/works/" + work);
    await expect(page.locator(".reader-library-actions")).toBeVisible();
    await expect(page.locator(".reading-panel")).not.toHaveAttribute("open");
    await expect(page.locator(".reader-toolbar + .reader-paper")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Leggi", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("reader-desktop.png") });
    const toolbarHeight = await page
      .locator(".reader-toolbar")
      .evaluate((el) => el.getBoundingClientRect().height);
    await page
      .frameLocator(".reader-frame")
      .locator("p")
      .first()
      .evaluate((el) => {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const selection = el.ownerDocument.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await expect(
      page.getByRole("button", { name: "Annota selezione" }),
    ).toBeVisible();
    expect(
      await page
        .locator(".reader-toolbar")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(toolbarHeight);
    await page
      .frameLocator(".reader-frame")
      .locator("p")
      .first()
      .evaluate((el) => el.ownerDocument.getSelection()!.removeAllRanges());
    await expect(
      page.getByRole("button", { name: "Annota selezione" }),
    ).toBeHidden();
    await page.locator(".reading-panel > summary").click();
    await page
      .getByRole("button", { name: "Salva in biblioteca", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reading group" })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
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
    await expect(
      page.getByRole("heading", { name: "Annotazioni", exact: true }),
    ).toBeVisible();
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
    await page.locator(".reading-panel > summary").click();
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
    const visibleParagraph = () =>
      page.locator(".reader-frame").evaluate((el) => {
        const f = el as HTMLIFrameElement,
          box = f.getBoundingClientRect();
        const top = f.closest(".immersive")
          ? box.top
          : Math.max(
              0,
              document.querySelector(".reader-toolbar")!.getBoundingClientRect()
                .bottom,
            );
        return [...f.contentDocument!.querySelectorAll("p")].findIndex(
          (p) => p.getBoundingClientRect().bottom + box.top > top + 16,
        );
      });
    const beforePanel = await visibleParagraph();
    await page.locator(".reading-panel > summary").click();
    expect(await visibleParagraph()).toBe(beforePanel);
    await page
      .getByRole("button", { name: "Chiudi strumenti di lettura" })
      .click();
    expect(await visibleParagraph()).toBe(beforePanel);
    await page.waitForTimeout(3000);
    const beforeMode = await visibleParagraph();
    const savedBeforeMode = (
      await pool.query(
        "SELECT revision,anchor FROM library_progress WHERE work_id=$1",
        [work],
      )
    ).rows[0];
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.waitForTimeout(3000);
    expect(
      (
        await pool.query(
          "SELECT revision,anchor FROM library_progress WHERE work_id=$1",
          [work],
        )
      ).rows[0],
    ).toEqual(savedBeforeMode);
    await page
      .getByRole("button", {
        name: "Esci dalla lettura immersiva",
        exact: true,
      })
      .click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.waitForTimeout(3000);
    expect(
      (
        await pool.query(
          "SELECT revision,anchor FROM library_progress WHERE work_id=$1",
          [work],
        )
      ).rows[0],
    ).toEqual(savedBeforeMode);
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.screenshot({
      path: testInfo.outputPath("reader-immersive-mobile.png"),
    });
    await page.locator(".reading-panel > summary").click();
    await frame.locator("body").evaluate((el) => {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(".reading-panel")).not.toHaveAttribute("open");
    await expect(page.locator(".reader.immersive")).toBeVisible();
    await frame
      .locator("body")
      .evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Escape");
    await expect(page.locator(".reader.immersive")).toHaveCount(0);
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page
      .getByRole("button", { name: "Lettura immersiva", exact: true })
      .click();
    let typographyRequests = 0;
    const countContent = (r: import("@playwright/test").Request) => {
      if (r.url().includes("/read?")) typographyRequests++;
    };
    page.on("request", countContent);
    await page.getByRole("button", { name: "Aspetto", exact: true }).click();
    await page.getByRole("button", { name: "Sans serif", exact: true }).click();
    await expect(frame.locator("body")).toHaveCSS(
      "font-family",
      "system-ui, sans-serif",
    );
    await page.getByRole("slider", { name: "Dimensione testo" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(frame.locator("body")).toHaveCSS("font-size", "20px");
    await page.getByRole("button", { name: "Compatta", exact: true }).click();
    await expect(frame.locator("body")).toHaveCSS("line-height", "31px");
    await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.waitForTimeout(3000);
    expect(typographyRequests).toBe(0);
    page.off("request", countContent);
    expect(
      (
        await pool.query(
          "SELECT revision,anchor FROM library_progress WHERE work_id=$1",
          [work],
        )
      ).rows[0],
    ).toEqual(savedBeforeMode);
    await page.getByRole("button", { name: "Aspetto", exact: true }).click();
    await page.getByRole("button", { name: "Scuro", exact: false }).click();
    await expect(frame.locator("body")).toHaveCSS(
      "background-color",
      "rgb(32, 39, 46)",
    );
    await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.goto("/works/" + work);
    await expect(frame.locator("body")).toHaveCSS("font-size", "20px");
    await expect(frame.locator("body")).toHaveCSS(
      "font-family",
      "system-ui, sans-serif",
    );
    await page.screenshot({ path: testInfo.outputPath("reader-mobile.png") });
    await expect(
      page.getByRole("button", { name: "Riprendi lettura" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Riprendi lettura" }).click();
    await expect.poll(visibleParagraph).toBe(beforeMode);
    await page.getByRole("button", { name: "Aspetto", exact: true }).click();
    // Re-selecting the active option must not freeze progress sampling.
    await page.getByRole("button", { name: "Sans serif", exact: true }).click();
    await page
      .getByRole("button", { name: "Automatico", exact: false })
      .click();
    await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    await frame.locator("p").nth(26).scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        Number(
          (
            await pool.query(
              "SELECT revision FROM library_progress WHERE work_id=$1",
              [work],
            )
          ).rows[0].revision,
        ),
      )
      .toBeGreaterThan(Number(savedBeforeMode.revision));
    await page.reload();
    await expect(page.getByLabel("Stato di lettura")).toHaveValue("paused");
    await expect(frame.locator("html")).toHaveAttribute("lang", "en");
    await page.locator(".reading-panel > summary").click();
    await frame
      .locator("p")
      .nth(5)
      .evaluate((el) => {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const sel = el.ownerDocument.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
      });
    await expect(
      page.getByRole("button", { name: "Annota selezione" }),
    ).toBeEnabled();
    const second = await page
      .getByRole("combobox", { name: "Capitolo", exact: true })
      .locator("option")
      .nth(2)
      .getAttribute("value");
    await page.getByRole("combobox", { name: "Capitolo", exact: true }).focus();
    await page.keyboard.press("Home");
    await page
      .getByRole("combobox", { name: "Capitolo", exact: true })
      .selectOption(second!);
    await expect(frame.locator("p")).toHaveText(["A separate chapter."]);
    await expect
      .poll(async () =>
        parseInt(await page.locator(".reader-progress-status").innerText()),
      )
      .toBeGreaterThan(90);
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT anchor->>'chapter' AS chapter FROM library_progress WHERE work_id=$1",
              [work],
            )
          ).rows[0]?.chapter,
      )
      .toBe(second);

    await expect
      .poll(() =>
        page
          .locator(".reader-frame")
          .evaluate(
            (f) =>
              !!(
                f as HTMLIFrameElement
              ).contentDocument?.activeElement?.closest(".chapter"),
          ),
      )
      .toBe(true);
    await expect(frame.locator('[tabindex="-1"]:focus')).toHaveCSS(
      "outline-style",
      "none",
    );
    await expect(page.locator(".reader-frame")).toHaveCSS(
      "outline-style",
      "none",
    );
    await page.screenshot({
      path: testInfo.outputPath("chapter-change-no-outline.png"),
    });
    await expect(
      page.getByRole("button", { name: "Annota selezione" }),
    ).toBeDisabled();
    const current = (
      await pool.query(
        "SELECT current_snapshot_id FROM archive_work_heads WHERE id=$1",
        [work],
      )
    ).rows[0].current_snapshot_id;
    await page.goto(`/works/${work}?snapshot=${current}`);
    await expect(page.locator(".reader-frame")).toBeVisible();
    await expect(page.locator(".version-indicator")).toHaveCount(0);
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
