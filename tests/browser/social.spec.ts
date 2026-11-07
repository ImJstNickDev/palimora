import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
test("personal settings, subscriptions, private recommendations and notification reading", async ({
  page,
  browser,
}, info) => {
  const url = process.env.TEST_DATABASE_URL!;
  if (!new URL(url).pathname.includes("test"))
    throw Error("Dedicated test database required");
  const db = new Pool({ connectionString: url });
  const work = randomUUID(),
    password = "A secure social browser password 82";
  try {
    await db.query(
      "INSERT INTO archive_work_heads(id,external_id,title) VALUES($1,$2,$3)",
      [work, "social-browser", "A shared recommendation"],
    );
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("socialowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    const me = await (await page.request.get("/api/v1/me")).json();
    const invite = await (
      await page.request.post("/api/v1/invites", {
        headers: { origin: "http://localhost:5173", "x-csrf-token": me.csrf },
        data: { days: 7, maxUses: 1, requestId: randomUUID() },
      })
    ).json();
    const guestContext = await browser.newContext({
      baseURL: "http://localhost:5173",
    });
    const guest = await guestContext.newPage();
    await guest.goto("/register#" + invite.token);
    await guest.getByLabel("Nome utente", { exact: true }).fill("socialreader");
    await guest.getByLabel("Password", { exact: true }).fill(password);
    await guest.getByRole("button", { name: "Crea account" }).click();
    await expect(
      guest.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await page.goto("/social-settings");
    const privacy = page
      .locator("fieldset")
      .filter({ has: page.locator("legend", { hasText: "Statistiche" }) });
    await privacy.getByLabel("Visibile a").selectOption("selected");
    await privacy.getByLabel("Nomi utente, uno per riga").fill("socialreader");
    await page.getByRole("button", { name: "Salva preferenze" }).click();
    await expect(page.getByText("Preferenze salvate.")).toBeVisible();
    await expect
      .poll(async () =>
        (
          await guest.request.get(
            "/api/v1/library/statistics?username=socialowner",
          )
        ).status(),
      )
      .toBe(200);
    expect(
      (
        await guest.request.get("/api/v1/library/activity?username=socialowner")
      ).status(),
    ).toBe(404);
    await page.goto("/works/" + work);
    await page
      .getByLabel("Sottoscrizione", { exact: true })
      .selectOption("changes");
    await page.getByRole("button", { name: "Consiglia", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Destinatario")
      .fill("socialreader");
    await page
      .getByRole("dialog")
      .getByLabel("Nota", { exact: true })
      .fill("A private recommendation");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Invia", exact: true })
      .click();
    await expect(page.getByText("Consiglio inviato.")).toBeVisible();
    await guest.goto("/notifications");
    await expect(guest.getByText("A private recommendation")).toBeVisible();
    await guest
      .getByRole("button", { name: "Segna letta", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Segna non letta", exact: true }),
    ).toBeVisible();
    await guest.getByLabel("Solo non lette").check();
    await expect(guest.getByText("Nessuna notifica.")).toBeVisible();
    await page.goto("/subscriptions");
    await expect(
      page.getByRole("link", { name: "A shared recommendation" }),
    ).toBeVisible();
    await page.getByLabel("Sottoscrizione", { exact: true }).selectOption("");
    await expect(page.getByText("Nessuna sottoscrizione.")).toBeVisible();
    await page.goto("/social-settings");
    await page
      .locator("fieldset")
      .filter({ has: page.locator("legend", { hasText: "Statistiche" }) })
      .getByLabel("Visibile a")
      .selectOption("private");
    await page.getByRole("button", { name: "Salva preferenze" }).click();
    await expect(page.getByText("Preferenze salvate.")).toBeVisible();
    expect(
      (
        await guest.request.get(
          "/api/v1/library/statistics?username=socialowner",
        )
      ).status(),
    ).toBe(404);
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: info.outputPath("privacy-" + width + ".png"),
        fullPage: true,
      });
    }
    const worker = await page.request.get("/push-worker.js");
    expect(worker.status()).toBe(200);
    expect(await worker.text()).toContain("url.pathname.startsWith('/api/')");
    await guestContext.close();
  } finally {
    await db.end();
  }
});
