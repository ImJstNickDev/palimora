import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
test("personal settings, subscriptions, private recommendations and notification reading", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
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
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("main h1")).toHaveCSS("outline-style", "none");
    await expect(page.locator("html")).toHaveAttribute(
      "data-focus-mode",
      "pointer",
    );
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
    expect(
      (
        await guestContext.request.get("/api/v1/recommendations/recipients")
      ).status(),
    ).toBe(401);
    expect(
      (
        await guestContext.request.post("/api/v1/notifications/read-all", {
          headers: { origin: "http://localhost:5173" },
          data: {},
        })
      ).status(),
    ).toBe(401);
    const guest = await guestContext.newPage();
    await guest.goto("/register#" + invite.token);
    await guest.getByLabel("Nome utente", { exact: true }).fill("socialreader");
    await guest.getByLabel("Password", { exact: true }).fill(password);
    await guest.getByRole("button", { name: "Crea account" }).click();
    await expect(
      guest.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    await db.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,'anotherreader','unused-test-hash','User')",
      [randomUUID()],
    );
    const directory = await (
      await guest.request.get("/api/v1/recommendations/recipients")
    ).json();
    expect(directory.items).toEqual([
      { username: "anotherreader" },
      { username: "socialowner" },
    ]);
    await page.goto("/social-settings");
    await expect(page.locator("fieldset legend")).toHaveText([
      "Attività di lettura",
    ]);
    await page.getByRole("button", { name: "Salva preferenze" }).click();
    await expect(page.getByText("Preferenze salvate.")).toBeVisible();
    expect(
      (
        await guest.request.get(
          "/api/v1/library/statistics?username=socialowner",
        )
      ).status(),
    ).toBe(400);
    expect(
      (await guest.request.get("/api/v1/library/statistics")).status(),
    ).toBe(200);
    expect(
      (
        await guest.request.get("/api/v1/library/activity?username=socialowner")
      ).status(),
    ).toBe(404);
    await page.goto("/works/" + work);
    await page
      .getByRole("button", { name: "Sottoscrizione", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Sottoscrizione", exact: true }),
    ).toHaveClass("action-menu");
    await page.getByRole("radio", { name: /Anche modifiche al testo/ }).check();
    await expect(
      page.getByText("Preferenza salvata", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /Anche modifiche al testo/ }),
    ).toBeChecked();
    await page.screenshot({
      path: info.outputPath("subscription-menu-desktop.png"),
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Sottoscrizione", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Consiglia", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Consiglia opera", exact: true }),
    ).toHaveClass("action-menu");
    await expect(page.getByLabel("Cerca utenti")).toBeFocused();
    await expect(
      page.getByRole("checkbox", { name: "socialreader", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog").locator("textarea")).toHaveCount(0);
    // Autofocus after a mouse click stays visually quiet; typing is not keyboard navigation.
    const search = page.getByLabel("Cerca utenti");
    const pointerBorder = await search.evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    await expect(search).toHaveCSS("outline-style", "none");
    await search.pressSequentially("social");
    await expect(page.locator("html")).toHaveAttribute(
      "data-focus-mode",
      "pointer",
    );
    await expect(search).toHaveCSS("border-color", pointerBorder);
    await search.fill("");
    await expect(
      page.getByRole("checkbox", { name: "anotherreader", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    const recipient = page.getByRole("checkbox", {
      name: "anotherreader",
      exact: true,
    });
    await expect(recipient).toBeFocused();
    await expect(recipient.locator("..")).toHaveCSS("outline-width", "1px");
    await page.keyboard.press("Shift+Tab");
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-style", "none");
    await expect(search).not.toHaveCSS("border-color", pointerBorder);
    await expect(search.locator("..")).not.toHaveCSS("box-shadow", "none");
    // Neutral keyboard indication also works in the dark theme and forced colors.
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await expect(search).toHaveCSS("outline-style", "none");
    await page.emulateMedia({ forcedColors: "active" });
    await expect(search).toHaveCSS("outline-width", "2px");
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "light"),
    );
    await search.click();
    await expect(search).toHaveCSS("border-color", pointerBorder);
    await expect(search.locator("..")).toHaveCSS("box-shadow", "none");
    await page.screenshot({ path: info.outputPath("quiet-search-focus.png") });
    // Opening another action with the keyboard dismisses the previous menu.
    await page
      .getByRole("button", { name: "Sottoscrizione", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      page.getByRole("dialog", { name: "Sottoscrizione", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Consiglia", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Invia", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "socialreader", exact: true })
      .check();
    await page.getByLabel("Cerca utenti").fill("another");
    await expect(
      page.getByRole("checkbox", { name: "socialreader", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("checkbox", { name: "anotherreader", exact: true })
      .check();
    await page.getByLabel("Cerca utenti").fill("");
    await page.screenshot({
      path: info.outputPath("recommend-menu-mobile.png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // One failed request must not resend to recipients already completed.
    let failOnce = true;
    const attempts: string[] = [];
    await page.route("**/api/v1/recommendations", async (route) => {
      const body = route.request().postDataJSON();
      attempts.push(body.username);
      if (body.username === "anotherreader" && failOnce) {
        failOnce = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "INTERNAL",
            requestId: randomUUID(),
          }),
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Invia", exact: true }).click();
    await expect(page.getByText("1 inviato · 1 da inviare")).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /socialreader Inviato/ }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(page.getByText("Consiglio inviato.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Fatto", exact: true }),
    ).toHaveCSS("outline-style", "none");
    expect(attempts).toEqual([
      "socialreader",
      "anotherreader",
      "anotherreader",
    ]);
    const delivered = await db.query(
      "SELECT recipient_id,count(*)::int AS count,max(note) AS note FROM personal_recommendations WHERE work_id=$1 GROUP BY recipient_id",
      [work],
    );
    expect(delivered.rows).toHaveLength(2);
    expect(delivered.rows.every((r) => r.count === 1 && r.note === "")).toBe(
      true,
    );
    await guest.goto("/notifications");
    await expect(
      guest.getByRole("link", { name: "A shared recommendation", exact: true }),
    ).toBeVisible();
    await guest
      .getByRole("button", { name: "Segna letta", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Segna non letta", exact: true }),
    ).toBeVisible();
    await guest.getByRole("button", { name: /^Non lette/ }).click();
    await expect(
      guest.getByText("Hai letto tutte le notifiche."),
    ).toBeVisible();
    await expect(
      guest.getByRole("heading", { name: "Notifiche", exact: true }),
    ).toBeVisible();
    await guest.reload();
    await expect(
      guest.getByRole("button", { name: /^Non lette/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await guest.getByRole("button", { name: "Tutte", exact: true }).click();
    await guest
      .getByRole("button", { name: "Segna non letta", exact: true })
      .click();
    await guest.locator(".notification-entry").getByRole("link").click();
    await expect(guest).toHaveURL(new RegExp("/works/" + work));
    await guest.goto("/library/notifications");
    await expect(guest.locator(".notification-entry.unread")).toHaveCount(0);
    const recipientId = (
      await db.query("SELECT id FROM users WHERE username='socialreader'")
    ).rows[0].id;
    const otherUnread = (
      await db.query(
        "SELECT count(*) FROM personal_notifications WHERE user_id<>$1 AND read_at IS NULL",
        [recipientId],
      )
    ).rows[0].count;
    await db.query(
      "UPDATE personal_recommendations SET note=$2 WHERE recipient_id=$1",
      [recipientId, "Una nota storica da conservare. ".repeat(20)],
    );
    await db.query(
      "INSERT INTO personal_notifications(user_id,kind,work_id,bucket,versions,updated_at) VALUES($1,'update',$2,-1,1,now()),($1,'update',$2,-2,3,now()-interval '1 day')",
      [recipientId, work],
    );
    await guest.reload();
    await expect(
      guest.getByText("Opera aggiornata", { exact: true }),
    ).toBeVisible();
    await expect(
      guest.getByText("3 aggiornamenti", { exact: true }),
    ).toBeVisible();
    await expect(guest.getByText("Ieri", { exact: true })).toBeVisible();
    await expect(guest.locator(".notification-note p")).toBeHidden();
    for (const width of [320, 390, 820, 1440]) {
      await guest.setViewportSize({ width, height: 900 });
      expect(
        await guest.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await guest.screenshot({
        path: info.outputPath(`notifications-${width}.png`),
        fullPage: true,
      });
    }
    await guest.getByText("Messaggio", { exact: true }).click();
    await expect(guest.locator(".notification-note p")).toBeVisible();
    await db.query(
      "INSERT INTO personal_notifications(user_id,kind,work_id,bucket) SELECT $1,'update',$2,-g FROM generate_series(3,56) g",
      [recipientId, work],
    );
    await guest.reload();
    await expect(guest.locator(".notification-entry")).toHaveCount(50);
    await expect(
      guest.getByRole("button", { name: "Altre notifiche", exact: true }),
    ).toBeVisible();
    expect(
      (
        await guest.request.post("/api/v1/notifications/read-all", { data: {} })
      ).status(),
    ).toBe(403);
    await guest
      .getByRole("button", { name: "Segna tutte come lette", exact: true })
      .click();
    await expect(
      guest.getByRole("button", {
        name: "Segna tutte come lette",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM personal_notifications WHERE user_id=$1 AND read_at IS NULL",
          [recipientId],
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM personal_notifications WHERE user_id<>$1 AND read_at IS NULL",
          [recipientId],
        )
      ).rows[0].count,
    ).toBe(otherUnread);
    await guest.getByRole("button", { name: "Non lette", exact: true }).click();
    await expect(
      guest.getByText("Hai letto tutte le notifiche."),
    ).toBeVisible();
    await page.goto("/subscriptions");
    await expect(
      page.getByRole("link", { name: "A shared recommendation" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Sottoscrizione", exact: true })
      .click();
    await page.getByRole("radio", { name: /Non seguire/ }).check();
    await expect(page.getByText("Nessuna sottoscrizione.")).toBeVisible();
    await page.goto("/social-settings");
    await expect(page.locator("fieldset legend")).toHaveText([
      "Attività di lettura",
    ]);
    await page.getByRole("button", { name: "Salva preferenze" }).click();
    await expect(page.getByText("Preferenze salvate.")).toBeVisible();
    expect(
      (
        await guest.request.get(
          "/api/v1/library/statistics?username=socialowner",
        )
      ).status(),
    ).toBe(400);
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
