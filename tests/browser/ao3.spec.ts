import { test, expect } from "@playwright/test";
test("AO3 administration persists controls and manual work requests", async ({
  page,
}) => {
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
    page.getByRole("heading", { name: "Disponibilità AO3" }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/admin/ao3/control") && r.request().method() === "POST",
  );
  await page.getByLabel("Disponibilità imposta").selectOption("force_offline");
  await saved;
  await page.reload();
  await expect(page.getByLabel("Disponibilità imposta")).toHaveValue(
    "force_offline",
  );
  await page.getByLabel("ID AO3", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Accoda verifica" }).click();
  await expect(
    page.getByRole("button", { name: "Opera · 123456", exact: true }),
  ).toBeVisible();
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Opera · 123456", exact: true }),
  });
  await row.getByRole("button", { name: "Pausa", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Riprendi", exact: true }),
  ).toBeVisible();
  await page
    .getByText("Carica un media irrecuperabile", { exact: true })
    .click();
  await page
    .getByLabel("URL originale del media")
    .fill("https://media.example.test/manual.png");
  await page
    .getByLabel("File locale")
    .setInputFiles({
      name: "manual.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+wAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  await page
    .getByRole("button", { name: "Carica e acquisisci", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Media · https://media.example.test/manual.png",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".local/m4/admin-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/m4/admin-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
