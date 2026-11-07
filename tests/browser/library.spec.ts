import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("personal library: reader bookmark, later, history and mobile editing", async ({
  page,
}, testInfo) => {
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
    await page.goto("/works/" + work);
    await page
      .getByRole("button", { name: "Crea bookmark", exact: true })
      .click();
    await page.getByLabel("Note personali").fill("A note kept across devices");
    await page
      .getByLabel("Tag personali, uno per riga")
      .fill("Favorites\nReread");
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page
      .getByRole("button", { name: "Leggi più tardi", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Rimuovi da più tardi" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Biblioteca", exact: true }).click();
    await expect(page.getByText("A note kept across devices")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Modifica bookmark" }).click();
    await page.getByLabel("Note personali").fill("Edited on mobile");
    await page.getByRole("button", { name: "Salva", exact: true }).click();
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
    await page.getByRole("button", { name: "Modifica bookmark" }).click();
    await page.getByRole("button", { name: "Elimina bookmark" }).click();
    await expect(
      page.getByRole("button", { name: "Crea bookmark" }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});
