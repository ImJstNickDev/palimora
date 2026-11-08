const { chromium } = require("@playwright/test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  { performance } = require("node:perf_hooks");
const origin = process.env.RELEASE_UI_ORIGIN,
  root = process.env.RELEASE_RESULTS;
if (
  !origin ||
  new URL(origin).protocol !== "https:" ||
  require("ipaddr.js").parse(new URL(origin).hostname).range() !== "private" ||
  !root?.includes("palimora-release-")
)
  throw Error("Isolated release gateway required");
const password = "Local release rehearsal password 86";
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    mean_ms: a.reduce((x, y) => x + y, 0) / a.length,
    p50_ms: a[Math.ceil(a.length * 0.5) - 1],
    p95_ms: a[Math.ceil(a.length * 0.95) - 1],
    p99_ms: a[Math.ceil(a.length * 0.99) - 1],
  };
};
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        ignoreHTTPSErrors: true,
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page
      .getByLabel(/Nome utente/)
      .first()
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        await page.screenshot({ path: root + "/ui-failure.png" });
        console.error(errors, await page.locator("body").innerText());
        throw error;
      });
    if (await page.getByLabel("Nome utente Owner").isVisible()) {
      await page.getByLabel("Nome utente Owner").fill("releaseowner");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    } else {
      await page
        .getByLabel("Nome utente", { exact: true })
        .fill("releaseowner");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Accedi", exact: true }).click();
    }
    await page.getByRole("heading", { name: "Il tuo account" }).waitFor();
    const cookie = (await context.cookies())
      .map((c) => c.name + "=" + c.value)
      .join(";");
    const get = async (path) => {
      const r = await fetch(origin + "/api/v1" + path, { headers: { cookie } });
      assert.equal(r.status, 200, path);
      return r.json();
    };
    const catalog = await get("/works");
    assert.ok(catalog.total >= 11032);
    const work = catalog.items.find((w) => w.snapshot_id).id;
    const detail = await get("/works/" + work);
    assert.ok(detail.manifest.chapters.length);
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["tablet", 820, 1180],
      ["mobile", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(origin + "/works");
      await page.locator(".work-blurb").first().waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "catalog overflow " + name,
      );
      await page.screenshot({
        path: root + "/catalog-" + name + ".png",
        fullPage: true,
      });
      await page.goto(origin + "/works/" + work);
      await page.frameLocator(".reader-frame").locator("body").waitFor();
      assert.ok(
        (await page.frameLocator(".reader-frame").locator("body").innerText())
          .length > 100,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "reader overflow " + name,
      );
      await page.screenshot({ path: root + "/reader-" + name + ".png" });
    }
    const result = {
      catalog_works: catalog.total,
      chapters: detail.manifest.chapters.length,
      errors,
      api: {},
    };
    if (!process.env.RELEASE_UI_SMOKE_ONLY) {
      const pits = new Set();
      if (catalog.next)
        pits.add(JSON.parse(Buffer.from(catalog.next, "base64url")).p);
      for (const [name, path] of Object.entries({
        search: "/works?q=love",
        work: "/works/" + work,
        chapter:
          "/works/" +
          work +
          "/read?chapter=" +
          detail.manifest.chapters[0].chapter_id,
      })) {
        const times = [];
        for (let i = 0; i < 103; i++) {
          const t = performance.now();
          const r = await get(path);
          if (i >= 3) times.push(performance.now() - t);
          if (r.next) pits.add(JSON.parse(Buffer.from(r.next, "base64url")).p);
        }
        result.api[name] = stats(times);
      }
      if (pits.size)
        await fetch(process.env.OPENSEARCH_URL + "/_search/point_in_time", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pit_id: [...pits] }),
        });
    }
    await page.goto(origin + "/admin");
    await page.getByRole("heading", { level: 1 }).waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "operations overflow",
    );
    await page.screenshot({
      path: root + "/operations-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await fs.writeFile(
      root +
        "/" +
        (process.env.RELEASE_UI_SMOKE_ONLY ? "ui-restarted" : "ui-api") +
        ".json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
