import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { TOTP, Secret } from "otpauth";
const password = "A secure browser test password 82";
test.beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.includes("test")
  )
    throw Error("Dedicated test database required");
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query("DELETE FROM rate_limits");
  await db.query(
    "DELETE FROM passkeys WHERE user_id IN (SELECT id FROM users WHERE username='browserowner')",
  );
  await db.end();
});
test("Owner setup, invitation registration, account preferences and passkey lifecycle on desktop and mobile", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  if (
    await page
      .getByRole("heading", { name: "La tua biblioteca, il tuo spazio." })
      .isVisible()
  ) {
    await page.getByLabel("Nome utente Owner").fill("browserowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
  } else {
    await page.getByLabel("Nome utente", { exact: true }).fill("browserowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Accedi", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Inviti", exact: true }).click();
  await page.getByRole("button", { name: "Genera invito" }).click();
  const link = await page.getByLabel("Link", { exact: true }).inputValue();
  expect(link).toContain("/register#");
  await page.getByRole("button", { name: "Chiudi", exact: true }).click();
  const readerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const reader = await readerContext.newPage();
  await reader.goto(link);
  await expect(
    reader.getByRole("heading", { name: "Accetta l’invito" }),
  ).toBeVisible();
  await reader
    .getByLabel("Nome utente", { exact: true })
    .fill("reader" + Date.now());
  await reader.getByLabel("Password", { exact: true }).fill(password);
  await reader.getByRole("button", { name: "Crea account" }).click();
  await expect(
    reader.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await expect(
    reader.getByRole("link", { name: "Utenti", exact: true }),
  ).toHaveCount(0);
  expect(
    await reader.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await reader.getByLabel("Lingua", { exact: true }).selectOption("en");
  await reader.getByLabel("Tema", { exact: true }).selectOption("dark");
  await reader.getByRole("button", { name: "Salva modifiche" }).click();
  await expect(
    reader.getByRole("heading", { name: "Your account" }),
  ).toBeVisible();
  await reader.reload();
  await expect(
    reader.getByRole("heading", { name: "Your account" }),
  ).toBeVisible();
  await expect(reader.locator("html")).toHaveAttribute("data-theme", "dark");
  await reader.screenshot({
    path: ".local/mobile-account.png",
    fullPage: true,
  });
  // Expiry during a background /me refetch must evict private cached pages.
  const readerId = await reader.evaluate(
    async () => (await (await fetch("/api/v1/me")).json()).user.id,
  );
  await page.evaluate(async (id) => {
    const me = await (await fetch("/api/v1/me")).json();
    const result = await fetch("/api/v1/admin/users/" + id, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
      body: JSON.stringify({ disabled: true }),
    });
    if (!result.ok) throw Error("Disable failed");
  }, readerId);
  await reader.evaluate(async () => {
    const modulePath = "/src/shared.tsx";
    const { client } = await import(modulePath);
    await client.invalidateQueries({ queryKey: ["me"] });
  });
  await expect(
    reader.getByRole("heading", { name: "Sign in to Palimora" }),
  ).toBeVisible();
  await expect(
    reader.getByRole("link", { name: "Devices", exact: true }),
  ).toHaveCount(0);
  await expect(reader.getByLabel("Username", { exact: true })).toHaveAttribute(
    "autocomplete",
    "username webauthn",
  );
  await expect(reader.getByLabel("6-digit code")).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: "Use a passkey" }),
  ).toHaveCount(0);
  await readerContext.close();
  await page.getByRole("link", { name: "Sicurezza", exact: true }).click();
  await expect(page.locator(".security-cards a")).toHaveCount(3);
  await expect(page.locator("main form")).toHaveCount(0);
  await page.getByRole("link", { name: "Password", exact: true }).click();
  await expect(page).toHaveURL(/\/security\/password$/);
  await page.goBack();
  await expect(page.locator(".security-cards")).toBeVisible();
  await page.getByRole("link", { name: "Passkeys", exact: true }).click();
  await expect(page).toHaveURL(/\/security\/passkeys$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Passkeys", exact: true }),
  ).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await expect(page.getByLabel("Nome della passkey")).toHaveCount(0);
  await page.getByRole("button", { name: "Aggiungi passkey" }).click();
  const keyForm = page
    .locator("form")
    .filter({ has: page.getByLabel("Nome della passkey") });
  await keyForm.getByLabel("Nome della passkey").fill("Test device");
  await keyForm.getByLabel("Password attuale").fill(password);
  await keyForm.getByRole("button", { name: "Aggiungi passkey" }).click();
  await expect(
    page.getByText("Passkey aggiunta.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".records li").filter({ hasText: "Test device" }),
  ).toBeVisible();
  const conditionalOptions = page.waitForResponse((response) =>
    response.url().endsWith("/auth/passkey/options"),
  );
  await page.getByRole("button", { name: "Esci", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Accedi a Palimora" }),
  ).toBeVisible();
  // The CTAP2 virtual authenticator supplies user presence to the real
  // conditional WebAuthn request, including signature verification by the API.
  await conditionalOptions;
  await expect(
    page.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Sicurezza", exact: true }).click();
  await page.getByRole("link", { name: "Passkeys", exact: true }).click();
  await page.getByRole("button", { name: "Rimuovi", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Password attuale").fill(password);
  await modal.getByRole("button", { name: "Rimuovi", exact: true }).click();
  await expect(page.getByText("Nessuna passkey registrata.")).toBeVisible();
  await page.locator(".security-back").click();
  await page.getByRole("link", { name: "Password", exact: true }).click();
  const passwordForm = page
    .locator("form")
    .filter({ has: page.getByLabel("Conferma nuova password") });
  await passwordForm.getByLabel("Password attuale").fill(password);
  await passwordForm
    .getByLabel("Nuova password", { exact: true })
    .fill("A different password 456");
  await passwordForm
    .getByLabel("Conferma nuova password")
    .fill("Another password 789");
  await passwordForm
    .getByRole("button", { name: "Cambia password", exact: true })
    .click();
  await expect(
    page.getByText("Le nuove password non coincidono."),
  ).toBeVisible();
  await page.locator(".security-back").click();
  await page
    .getByRole("link", { name: "Autenticazione a due fattori", exact: true })
    .click();
  await page.getByRole("button", { name: "Attiva 2FA", exact: true }).click();
  const wizard = page.locator(".totp-wizard");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await wizard.getByLabel("Password attuale").fill(password);
  await wizard.getByRole("button", { name: "Continua", exact: true }).click();
  await expect(wizard.getByAltText("QR per configurare TOTP")).toBeVisible();
  const secret = await wizard.locator(".manual-key code").innerText();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".local/security-2fa-mobile.png",
    fullPage: true,
  });
  await wizard
    .getByLabel("Codice a 6 cifre")
    .fill(new TOTP({ secret: Secret.fromBase32(secret) }).generate());
  await wizard.getByRole("button", { name: "Verifica codice" }).click();
  await expect(
    wizard.getByRole("button", { name: "Conferma e attiva 2FA" }),
  ).toBeDisabled();
  await wizard.getByRole("button", { name: "Indietro", exact: true }).click();
  await expect(wizard.getByAltText("QR per configurare TOTP")).toBeVisible();
  await expect(
    wizard.getByText("Codice verificato", { exact: true }),
  ).toBeVisible();
  await wizard.getByRole("button", { name: "Continua", exact: true }).click();
  const backup = await wizard.locator(".backup-codes code").first().innerText();
  const loginBackup = await wizard
    .locator(".backup-codes code")
    .nth(1)
    .innerText();
  const download = page.waitForEvent("download");
  await wizard
    .getByRole("button", { name: "Scarica codici di backup" })
    .click();
  expect((await download).suggestedFilename()).toBe("palimora-recovery.txt");
  await wizard.getByRole("button", { name: "Conferma e attiva 2FA" }).click();
  await expect(wizard).toHaveCount(0);
  await page.getByRole("button", { name: "Esci", exact: true }).click();
  await expect(page.getByLabel("Codice a 6 cifre")).toHaveCount(0);
  await page.getByLabel("Nome utente", { exact: true }).fill("browserowner");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(page.getByLabel("Codice a 6 cifre")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: ".local/login-totp-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Codice a 6 cifre").fill(
    new TOTP({ secret: Secret.fromBase32(secret) }).generate({
      timestamp: Date.now() + 30000,
    }),
  );
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Esci", exact: true }).click();
  await page.getByLabel("Nome utente", { exact: true }).fill("browserowner");
  await page.getByLabel("Password", { exact: true }).fill(loginBackup);
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Il tuo account" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Sicurezza", exact: true }).click();
  await page
    .getByRole("link", { name: "Autenticazione a due fattori", exact: true })
    .click();
  const factorForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Disattiva TOTP" }) });
  await factorForm.getByLabel("Password attuale").fill(password);
  await factorForm.getByLabel("Codice TOTP o recovery").fill(backup);
  await factorForm.getByRole("button", { name: "Disattiva TOTP" }).click();
  await expect(
    page.getByRole("button", { name: "Attiva 2FA", exact: true }),
  ).toBeVisible();
  await page.locator(".security-back").click();
  await expect(page.locator(".security-cards a")).toHaveCount(3);
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({
    path: ".local/security-cards-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: ".local/desktop-security.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
