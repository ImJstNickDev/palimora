import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("user management exposes audited statistics only to administrators", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  const database = process.env.TEST_DATABASE_URL!;
  if (!new URL(database).pathname.includes("test"))
    throw Error("Dedicated test database required");
  const db = new Pool({ connectionString: database });
  const password = "Local statistics browser password 42";
  const target = randomUUID(),
    work = randomUUID();
  const contexts = [];
  try {
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("statsowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    for (const [id, username, role] of [
      [target, "statstarget", "User"],
      [randomUUID(), "statsreader", "User"],
      [randomUUID(), "statsadmin", "Admin"],
    ]) {
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) SELECT $1,$2,password_hash,$3 FROM users WHERE username='statsowner'",
        [id, username, role],
      );
    }
    await db.query(
      "INSERT INTO archive_work_heads(id,external_id,title) VALUES($1,$2,'Statistics fixture')",
      [work, work],
    );
    await db.query(
      "INSERT INTO reading_intervals(id,user_id,work_id,span) VALUES($1,$2,$3,tstzrange('2026-01-01 00:00Z','2026-01-01 00:05Z','[)'))",
      [randomUUID(), target, work],
    );
    await db.query(
      "INSERT INTO personal_settings(user_id,statistics) VALUES($1,'instance')",
      [target],
    );
    await page.goto("/library/statistics?username=statstarget");
    await expect(page).toHaveURL(/\/library\/statistics$/);
    await expect(page.getByLabel("Nome utente", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator(".statistics-content")).toContainText(
      "0 h 0 min",
    );
    await page.goto("/library/settings");
    await expect(page.locator("fieldset legend")).toHaveText([
      "Attività di lettura",
    ]);
    await page.goto("/admin/users");
    await page.getByLabel("Cerca nome utente o email").fill("statstarget");
    await page.getByRole("button", { name: "Cerca", exact: true }).click();
    await page.getByRole("link", { name: "statstarget", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp("/admin/users/" + target + "\\?q=statstarget$"),
    );
    const tabs = page.getByRole("navigation", { name: "Gestione utente" });
    await expect(tabs.locator('[aria-current="page"]')).toHaveText("Account");
    await page.getByRole("button", { name: "Sessioni", exact: true }).click();
    await expect(page.getByText("Nessuna sessione attiva.")).toBeVisible();
    await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    await page.getByRole("button", { name: "Disabilita", exact: true }).click();
    await page.getByRole("button", { name: "Conferma", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Riabilita", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("link", { name: "Statistiche", exact: true }).click();
    await expect(page.locator(".statistics-content")).toContainText(
      "0 h 5 min",
    );
    await expect(page.locator(".user-detail > .library-back")).toHaveAttribute(
      "href",
      "/admin/users?q=statstarget",
    );
    await page.reload();
    await expect(page.locator(".statistics-content")).toContainText(
      "0 h 5 min",
    );
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(tabs.locator('[aria-current="page"]')).toHaveText(
        "Statistiche",
      );
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: info.outputPath(`admin-statistics-${width}.png`),
          fullPage: true,
        });
    }
    await page
      .getByRole("link", { name: "Utenti", exact: true })
      .last()
      .click();
    await expect(page).toHaveURL(/\/admin\/users\?q=statstarget$/);
    for (const username of ["statsadmin", "statsreader"]) {
      const context = await browser.newContext({
        baseURL: "http://localhost:5173",
        viewport: { width: 390, height: 844 },
      });
      contexts.push(context);
      const other = await context.newPage();
      await other.goto("/login");
      await other.getByLabel("Nome utente", { exact: true }).fill(username);
      await other.getByLabel("Password", { exact: true }).fill(password);
      await other.getByRole("button", { name: "Accedi", exact: true }).click();
      await expect(
        other.getByRole("heading", { name: "Il tuo account" }),
      ).toBeVisible();
      expect(
        (
          await other.request.get(
            "/api/v1/library/statistics?username=statstarget",
          )
        ).status(),
      ).toBe(400);
      const response = await other.request.get(
        `/api/v1/admin/users/${target}/statistics`,
      );
      expect(response.status()).toBe(username === "statsadmin" ? 200 : 403);
      await other.goto(`/admin/users/${target}/statistics`);
      if (username === "statsadmin") {
        await expect(other.locator(".statistics-content")).toContainText(
          "0 h 5 min",
        );
      } else {
        await expect(
          other.getByRole("heading", { name: "Il tuo account" }),
        ).toBeVisible();
        await other.goto("/library/statistics?username=statstarget");
        await expect(
          other.getByLabel("Nome utente", { exact: true }),
        ).toHaveCount(0);
        await expect(other.locator(".statistics-content")).toContainText(
          "0 h 0 min",
        );
      }
    }
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM audit WHERE action='userStatistics' AND target=$1",
            [target],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await db.end();
  }
});
