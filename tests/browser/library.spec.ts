import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("personal library: reader bookmark, later, history and mobile editing", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const database = process.env.TEST_DATABASE_URL!;
  if (!new URL(database).pathname.includes("test"))
    throw Error("Dedicated test database required");
  const db = new Pool({ connectionString: database }),
    work = randomUUID();
  try {
    await db.query(
      "INSERT INTO archive_work_heads(id,external_id,title) VALUES($1,$2,$3)",
      [work, "987654321", "Library browser work"],
    );
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("libraryowner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("A secure library test password 82");
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    const me = await (await page.request.get("/api/v1/me")).json();
    for (const name of ["Preferiti", "Da rileggere"]) {
      const response = await page.request.post("/api/v1/collections", {
        headers: { origin: "http://localhost:5173", "x-csrf-token": me.csrf },
        data: { id: randomUUID(), name, description: "" },
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto("/works/" + work);
    await page
      .getByRole("button", { name: "Salva in biblioteca", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "La tua biblioteca", exact: true }),
    ).toHaveClass("action-menu");
    await expect(page.locator(".overlay")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Aggiungi a collezione" }),
    ).toHaveCount(0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva in biblioteca", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeVisible();
    const savedButton = page
      .getByRole("dialog")
      .getByRole("button", { name: "Salvato in biblioteca", exact: true });
    await expect(savedButton.locator("svg")).toHaveAttribute(
      "fill",
      "currentColor",
    );
    await savedButton.click();
    const saveButton = page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva in biblioteca", exact: true });
    await expect(saveButton).toHaveAttribute("aria-pressed", "false");
    await expect(saveButton.locator("svg")).toHaveAttribute("fill", "none");
    expect(
      (await (await page.request.get("/api/v1/library/works/" + work)).json())
        .bookmark,
    ).toBeNull();
    await saveButton.click();
    await expect(savedButton).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: testInfo.outputPath("saved-work-menu-desktop.png"),
    });
    await page
      .getByRole("button", { name: "Note e tag personali", exact: true })
      .click();
    await expect(page.getByLabel("Note personali")).toBeFocused();
    await page.getByLabel("Note personali").fill("A note kept across devices");
    await page
      .getByLabel("Tag personali, uno per riga")
      .fill("Favorites\nReread");
    await page.screenshot({
      path: testInfo.outputPath("bookmark-menu-desktop.png"),
    });
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Note e tag personali", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toHaveAttribute("data-active", "true");
    await page
      .getByRole("button", { name: "Salvato in biblioteca", exact: true })
      .click();
    for (const name of ["Preferiti", "Da rileggere"]) {
      await page
        .getByRole("dialog")
        .getByRole("button", { name, exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: name,
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    const favorite = page
      .getByRole("dialog")
      .getByRole("button", { name: "Preferiti", exact: true });
    await favorite.focus();
    await page.keyboard.press("Space");
    await expect(favorite).toHaveAttribute("aria-pressed", "false");
    await expect(favorite).toBeFocused();
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM library_collection_works WHERE work_id=$1",
          [work],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await favorite.click();
    await expect(favorite).toHaveAttribute("aria-pressed", "true");
    const entry = await (
      await page.request.get("/api/v1/library/works/" + work)
    ).json();
    expect(entry.bookmark.notes).toBe("A note kept across devices");
    expect(entry.bookmark.tags).toEqual(["Favorites", "Reread"]);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Leggi più tardi", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Rimuovi da più tardi" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Biblioteca", exact: true }).click();
    await expect(page.getByText("A note kept across devices")).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Biblioteca personale",
      exact: true,
    });
    await expect(navigation).toHaveCount(1);
    await expect(page.locator(".personal-library > nav")).toHaveCount(1);
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(
      "Opere salvate",
    );
    await expect(
      page.getByRole("heading", { name: "Opere salvate", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Salvato in biblioteca" }).click();
    await page
      .getByRole("button", { name: "Note e tag personali", exact: true })
      .click();
    await page.getByLabel("Note personali").fill("Edited on mobile");
    const menu = await page.getByRole("dialog").boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: testInfo.outputPath("bookmark-menu-mobile.png"),
    });
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salvato in biblioteca", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Edited on mobile")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const width of [390, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`library-${width}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("link", { name: "Cronologia", exact: true }).click();
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(
      "Cronologia",
    );
    await page.goBack();
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(
      "Opere salvate",
    );
    await page.goForward();
    await page.reload();
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(
      "Cronologia",
    );
    await expect(
      page.getByRole("link", { name: "Library browser work" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Rimuovi dalla cronologia" })
      .click();
    await expect(
      page.getByText("Nessuna opera in questo elenco."),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Da leggere più tardi", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Library browser work" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Salvato in biblioteca" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salvato in biblioteca", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rimuovi", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Salva in biblioteca", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page
        .getByRole("button", { name: "Salva in biblioteca", exact: true })
        .locator("svg"),
    ).toHaveAttribute("fill", "none");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM library_collection_works WHERE work_id=$1",
          [work],
        )
      ).rows[0].n,
    ).toBe(2);
    // Existing bookmarks keep filters and fragments when routes are normalized.
    await page.goto("/library?kind=later&q=Library#results");
    await expect(page).toHaveURL(/\/library\/later\?q=Library#results$/);
    await expect(page.getByLabel("Titolo o note")).toHaveValue("Library");
    await page.getByRole("button", { name: "Filtra", exact: true }).click();
    await expect(page).toHaveURL(/\/library\/later\?q=Library$/);
    await page.getByRole("link", { name: "Azzera filtri" }).click();
    await expect(page).toHaveURL(/\/library\/later$/);
    for (const [oldPath, path] of [
      ["/library?kind=bookmarks", "/library"],
      ["/library?kind=history", "/library/history"],
      ["/collections", "/library/collections"],
      ["/offline", "/library/offline"],
      ["/statistics", "/library/statistics"],
      ["/activity", "/library/activity"],
      ["/subscriptions", "/library/subscriptions"],
      ["/notifications", "/library/notifications"],
      ["/social-settings", "/library/settings"],
    ]) {
      await page.goto(oldPath);
      await expect(page).toHaveURL(new RegExp(path + "$"));
      await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
      for (const width of [320, 820, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        // The active section stays visible within the horizontal tab strip.
        await expect
          .poll(() =>
            navigation.locator('[aria-current="page"]').evaluate((el) => {
              const r = el.getBoundingClientRect(),
                parent = el.parentElement!.getBoundingClientRect();
              return r.left >= parent.left - 1 && r.right <= parent.right + 1;
            }),
          )
          .toBe(true);
      }
    }
    await page.goto("/notifications?unread=true");
    await expect(page).toHaveURL(/\/library\/notifications\?unread=true$/);
    await expect(
      page.getByRole("button", { name: /^Non lette/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(
      page.getByRole("button", { name: /^Non lette/ }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    await db.end();
  }
});
