import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Queue } from "bullmq";
const password = "Operations fixture password 83";
test("Operations: real Docker isolation, live metrics, projections, controls and recovery", async ({
  page,
  playwright,
}) => {
  if (
    !process.env.TEST_DATABASE_URL?.includes("palimora_ops_test") ||
    !process.env.OPERATIONS_TEST_PREFIX?.startsWith("palimora-ops-test-")
  )
    throw Error("Isolated services required");
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const env = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    AUTH_KEY: "ab".repeat(32),
    APP_ORIGIN: "http://localhost:5173",
    PORT: "3000",
  };
  const log = createWriteStream(
    join(process.env.OPERATIONS_TEST_ROOT!, "api.log"),
  );
  const launch = () => {
    const p = spawn(process.execPath, ["apps/api/dist/main.js"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout!.pipe(log, { end: false });
    p.stderr!.pipe(log, { end: false });
    return p;
  };
  const stop = async (p: ChildProcess) => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    await new Promise<void>((r) => p.once("exit", () => r()));
  };
  let api = launch(),
    scheduler: ChildProcess | undefined;
  const connection = {
    host: process.env.REDIS_HOST,
    port: 6379,
    maxRetriesPerRequest: 1,
  };
  const queue = new Queue("palimora-ao3-v1", { connection });
  queue.on("error", () => {});
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await expect
      .poll(
        async () =>
          fetch("http://localhost:3000/api/v1/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 60000 },
      )
      .toBe(200);
    await page.goto("/");
    await page.getByLabel("Nome utente Owner").fill("opsowner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crea la biblioteca" }).click();
    await expect(
      page.getByRole("heading", { name: "Il tuo account" }),
    ).toBeVisible();
    const owner = await playwright.request.newContext({
      baseURL: "http://localhost:5173",
      extraHTTPHeaders: { Origin: "http://localhost:5173" },
    });
    const login = await owner.post("/api/v1/auth/login", {
      data: { username: "opsowner", password },
    });
    const csrf = (await login.json()).csrf;
    await db.query("UPDATE ao3_control SET mode='force_offline',paused=true");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Operazioni", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "postgres", exact: true }),
    ).toBeVisible({ timeout: 40000 });
    await page.locator(".ops-card").filter({ hasText: "Importazioni" }).click();
    await expect(page).toHaveURL(/\/admin\/ingest/);
    await page.goto("/admin");
    await page.getByRole("link", { name: "postgres", exact: true }).click();
    await expect(page.getByLabel("Sorgente")).toHaveValue("container:postgres");
    await page.goto("/admin");
    const proxy = process.env.OPERATIONS_PROXY_URL!;
    expect((await fetch(proxy + "/containers/json")).status).toBe(403);
    expect((await fetch(proxy + "/snapshot", { method: "POST" })).status).toBe(
      403,
    );
    const docker = await (await fetch(proxy + "/snapshot")).json();
    expect(docker.containers).toHaveLength(5);
    expect(JSON.stringify(docker)).not.toContain("foreign");
    expect(JSON.stringify(docker)).not.toContain("POSTGRES_PASSWORD");
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT count(*) FROM operations_metrics WHERE series='container:postgres' AND metric='cpu_percent'",
              )
            ).rows[0].count,
          ),
        { timeout: 45000 },
      )
      .toBeGreaterThan(0);
    expect(
      Number(
        (
          await db.query(
            "SELECT last FROM operations_metrics WHERE series='container:postgres' AND metric='memory_bytes' ORDER BY bucket DESC LIMIT 1",
          )
        ).rows[0].last,
      ),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Configura sezioni" }).click();
    const modal = page.getByRole("dialog");
    await modal
      .getByRole("checkbox", { name: "Spazio", exact: true })
      .uncheck();
    await modal
      .getByRole("button", { name: "Sposta su Prestazioni API" })
      .click();
    await modal.getByRole("button", { name: "Salva disposizione" }).click();
    await expect(modal).not.toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Spazio", exact: true }),
    ).toHaveCount(0);
    // Produce real corpus commits and index them in the existing API workers.
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const archive = require("../../apps/api/dist/archive"),
      archiveDb = require("../../apps/api/dist/db");
    const batch = randomUUID(),
      source = {
        id: randomUUID(),
        path: "operations-fixture.zip",
        fingerprint: "operations-fixture",
      };
    await db.query(
      "INSERT INTO ingest_batches(id,state) VALUES($1,'completed')",
      [batch],
    );
    await db.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
    for (let n = 1; n <= 2; n++)
      await archive.ingestRecord(source, {
        parser: "operations-fixture-v1",
        cursor: n,
        locator: "story-" + n,
        record: {
          external_id: "991200",
          state: "valid",
          metadata: { title: ["Operations preserved work"] },
          chapters: [{ name: "chapter" }],
          objects: [
            {
              name: "chapter",
              kind: "chapter_html",
              data: Buffer.from(
                "<p>Measured historical version " + n + "</p>",
              ).toString("base64"),
            },
          ],
          observed_at: null,
        },
      });
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT processed FROM operations_index WHERE kind='search'",
              )
            ).rows[0].processed,
          ),
        { timeout: 60000 },
      )
      .toBeGreaterThan(0);
    const nativeHistory = await owner.get(
      "/api/v1/admin/operations/jobs/history?family=ingest&id=" + batch,
    );
    expect(nativeHistory.status()).toBe(200);
    expect(
      (await nativeHistory.json()).items.some(
        (r: any) => r.state === "completed",
      ),
    ).toBe(true);
    const telemetry = require("../../apps/api/dist/operations-metrics");
    await telemetry.collectStorage();
    const sizes = (
      await db.query("SELECT value FROM operations_status WHERE name='storage'")
    ).rows[0].value;
    expect(sizes.database_bytes).toBeGreaterThan(0);
    expect(sizes.pack_bytes).toBeGreaterThan(0);
    for (let n = 0; n < 8; n++)
      expect((await owner.get("/api/v1/works?q=preserved")).status()).toBe(200);
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query(
                "SELECT coalesce(sum(requests),0) AS n FROM operations_http WHERE kind='search'",
              )
            ).rows[0].n,
          ),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await page.goto("/admin/operations/jobs?family=index&id=search");
    const detail = page.getByRole("region", { name: "Dettaglio job" });
    await detail.getByRole("button", { name: "Pausa", exact: true }).click();
    await expect(detail.getByText("In pausa", { exact: true })).toBeVisible();
    const work = (await db.query("SELECT id FROM archive_work_heads")).rows[0]
      .id;
    await db.query(
      "INSERT INTO catalog_text_pending VALUES($1) ON CONFLICT DO NOTHING",
      [work],
    );
    await page.waitForTimeout(1500);
    expect(
      (await db.query("SELECT count(*) FROM catalog_text_pending")).rows[0]
        .count,
    ).toBe("1");
    await detail.getByRole("button", { name: "Riprendi" }).click();
    await expect
      .poll(
        async () =>
          (await db.query("SELECT count(*) FROM catalog_text_pending")).rows[0]
            .count,
      )
      .toBe("0");
    await expect(detail.getByRole("table")).toBeVisible();
    // The original AO3 scheduler updates real BullMQ jobs; the isolated transport is paused to avoid upstream traffic.
    await queue.pause();
    await db.query(
      "UPDATE ao3_control SET mode='force_online',paused=false,next_request_at=now()+interval '1 day'",
    );
    scheduler = spawn(
      process.execPath,
      [
        "-e",
        "const {runSyncQueue}=require('./apps/api/dist/ao3-scheduler');const {executeSync}=require('./apps/api/dist/ao3-worker');const {pool}=require('./apps/api/dist/db');let stopped=false;process.on('SIGTERM',()=>stopped=true);runSyncQueue(id=>executeSync(id,()=>stopped),()=>stopped).finally(()=>pool.end());",
      ],
      { env, stdio: "ignore" },
    );
    await page.goto("/admin/operations/jobs?family=sync");
    await page.getByRole("button", { name: "Priorità sync" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Discovery", { exact: true })
      .fill("2");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva priorità" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const discovery = (
      await db.query(
        "SELECT id,generation FROM ao3_jobs WHERE kind='discovery'",
      )
    ).rows[0];
    await expect
      .poll(
        async () => {
          const j = await queue.getJob(
            discovery.id + "-" + discovery.generation,
          );
          return j?.opts.priority;
        },
        { timeout: 15000 },
      )
      .toBe(102);
    await page.getByRole("button", { name: /^Discovery/ }).click();
    await detail.getByRole("button", { name: "Pausa", exact: true }).click();
    await expect(detail.getByText("Bloccato", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Riprendi" }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("SELECT state FROM ao3_jobs WHERE id=$1", [
              discovery.id,
            ])
          ).rows[0].state,
      )
      .toBe("pending");
    await stop(scheduler);
    scheduler = undefined;
    await db.query("UPDATE ao3_control SET mode='force_offline',paused=true");
    // Service degradation is visible and the same projection worker recovers on retry.
    execFileSync(
      "docker",
      ["stop", process.env.OPERATIONS_TEST_PREFIX + "-search"],
      { stdio: "ignore" },
    );
    await db.query(
      "INSERT INTO catalog_text_pending VALUES($1) ON CONFLICT DO NOTHING",
      [work],
    );
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT state FROM operations_index WHERE kind='search'",
            )
          ).rows[0].state,
        { timeout: 30000 },
      )
      .toBe("failed");
    await page.goto("/admin/operations/jobs?family=index&id=search");
    await expect(detail.getByRole("alert")).toBeVisible();
    execFileSync(
      "docker",
      ["start", process.env.OPERATIONS_TEST_PREFIX + "-search"],
      { stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          fetch(process.env.OPENSEARCH_URL + "/_cluster/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 60000 },
      )
      .toBe(200);
    await page.screenshot({
      path: ".local/operations-jobs.png",
      fullPage: true,
    });
    await detail.getByRole("button", { name: "Riprova ora" }).click();
    await expect
      .poll(
        async () =>
          (await db.query("SELECT count(*) FROM catalog_text_pending")).rows[0]
            .count,
        { timeout: 30000 },
      )
      .toBe("0");
    execFileSync(
      "docker",
      ["stop", process.env.OPERATIONS_TEST_PREFIX + "-redis"],
      { stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT value->>'available' AS available FROM operations_status WHERE name='queues'",
            )
          ).rows[0]?.available,
        { timeout: 30000 },
      )
      .toBe("false");
    execFileSync(
      "docker",
      ["start", process.env.OPERATIONS_TEST_PREFIX + "-redis"],
      { stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT value->>'available' AS available FROM operations_status WHERE name='queues'",
            )
          ).rows[0]?.available,
        { timeout: 30000 },
      )
      .toBe("true");
    await page.goto("/admin/operations/metrics");
    await expect(
      page.getByRole("img", { name: "API · latenza media" }),
    ).toBeVisible({ timeout: 20000 });
    await page.screenshot({
      path: ".local/operations-metrics.png",
      fullPage: true,
    });
    await page.getByLabel("Misura").selectOption("p95_ms");
    await expect(
      page.getByRole("img", { name: "API · p95 · limite superiore" }),
    ).toBeVisible();
    await page.getByLabel("Misura").selectOption("requests");
    await expect(
      page.getByRole("img", { name: "API · richieste" }),
    ).toBeVisible();
    await page.getByLabel("Misura").selectOption("mean_ms");
    await page.getByLabel("Intervallo").selectOption("day");
    await expect(
      page.getByRole("img", { name: "API · latenza media" }),
    ).toBeVisible();
    await owner.post("/api/v1/admin/operations/layout", {
      headers: { "X-CSRF-Token": csrf },
      data: { sections: ["activity", "containers", "performance", "storage"] },
    });
    await page.goto("/admin");
    await expect(
      page.getByRole("link", { name: "postgres", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.screenshot({
      path: ".local/operations-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.screenshot({
      path: ".local/operations-tablet.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/operations-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await owner.post("/api/v1/admin/operations/layout", {
      headers: { "X-CSRF-Token": csrf },
      data: { sections: ["activity", "performance", "containers"] },
    });
    // Samples and preferences survive API restart; collector downtime becomes stale, not a fabricated zero.
    const rowsBefore = Number(
      (await db.query("SELECT count(*) FROM operations_metrics")).rows[0].count,
    );
    await stop(api);
    api = launch();
    await expect
      .poll(
        async () =>
          fetch("http://localhost:3000/api/v1/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 30000 },
      )
      .toBe(200);
    expect(
      Number(
        (await db.query("SELECT count(*) FROM operations_metrics")).rows[0]
          .count,
      ),
    ).toBeGreaterThanOrEqual(rowsBefore);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Spazio", exact: true }),
    ).toHaveCount(0);
    execFileSync(
      "docker",
      ["stop", process.env.OPERATIONS_TEST_PREFIX + "-collector"],
      { stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT value->>'fresh' AS fresh FROM operations_status WHERE name='containers'",
            )
          ).rows[0]?.fresh,
        { timeout: 30000 },
      )
      .toBe("false");
    await expect(
      page.getByText("Collector non disponibile o campione scaduto."),
    ).toBeVisible({ timeout: 15000 });
    execFileSync(
      "docker",
      ["start", process.env.OPERATIONS_TEST_PREFIX + "-collector"],
      { stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT value->>'fresh' AS fresh FROM operations_status WHERE name='containers'",
            )
          ).rows[0]?.fresh,
        { timeout: 30000 },
      )
      .toBe("true");
    const restore = randomUUID();
    await db.query(
      "INSERT INTO backup_destinations(name,label,enabled) VALUES('acl-fixture','ACL fixture',false)",
    );
    await db.query(
      "INSERT INTO backup_runs(id,kind,destination,state) VALUES($1,'restore','acl-fixture','paused')",
      [restore],
    );
    expect(
      (
        await owner.get(
          "/api/v1/admin/operations/jobs?family=backup&id=" + restore,
        )
      ).status(),
    ).toBe(200);
    for (const role of ["Admin", "User"]) {
      const name = "ops" + role.toLowerCase();
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) SELECT $1,$2,password_hash,$3 FROM users WHERE username='opsowner'",
        [randomUUID(), name, role],
      );
      const c = await playwright.request.newContext({
        baseURL: "http://localhost:5173",
        extraHTTPHeaders: { Origin: "http://localhost:5173" },
      });
      const signed = await c.post("/api/v1/auth/login", {
        data: { username: name, password },
      });
      const token = (await signed.json()).csrf;
      for (const path of [
        "/admin/operations",
        "/admin/operations/metrics",
        "/admin/operations/jobs",
        "/admin/operations/jobs/history?family=index&id=search",
      ])
        expect((await c.get("/api/v1" + path)).status()).toBe(
          role === "Admin" ? 200 : 403,
        );
      expect(
        (
          await c.post("/api/v1/admin/operations/layout", {
            data: { sections: ["activity"] },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await c.post("/api/v1/admin/operations/jobs/control", {
            headers: { "X-CSRF-Token": token },
            data: {
              family: "index",
              id: "catalog",
              action: "pause",
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(role === "Admin" ? 200 : 403);
      expect(
        (
          await c.post("/api/v1/admin/operations/jobs/control", {
            headers: { "X-CSRF-Token": token },
            data: {
              family: "backup",
              id: restore,
              action: "resume",
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
      await c.dispose();
    }
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM audit WHERE action='operationsControl'",
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(0);
    // Exercise the persisted rollup, including whole-hour retention and bounded history.
    const {
      compactMetrics,
    } = require("../../apps/api/dist/operations-metrics");
    await db.query(
      "INSERT INTO operations_metrics VALUES(date_trunc('hour',now())-interval '25 hours',60,'fixture','value',2,10,7,7)",
    );
    await db.query(
      "INSERT INTO operations_http VALUES(date_trunc('hour',now())-interval '25 hours',60,'search',2,1,30,25,ARRAY[1,0,1,0,0,0,0,0,0,0,0,0,0]::bigint[])",
    );
    const conn = await db.connect();
    try {
      await compactMetrics(conn);
      await compactMetrics(conn);
    } finally {
      conn.release();
    }
    expect(
      (
        await db.query(
          "SELECT total FROM operations_metrics WHERE series='fixture' AND step=3600",
        )
      ).rows[0].total,
    ).toBe(10);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM operations_metrics WHERE series='fixture' AND step=60",
        )
      ).rows[0].count,
    ).toBe("0");
    const rolled = await owner.get(
      "/api/v1/admin/operations/metrics?range=week&series=http",
    );
    expect(rolled.status()).toBe(200);
    expect(
      (await rolled.json()).http.some(
        (p: any) =>
          p.kind === "search" &&
          p.requests === 2 &&
          p.p95_ms === 25 &&
          p.errors === 1,
      ),
    ).toBe(true);
    await archiveDb.pool.end();
    await owner.dispose();
    expect(errors).toEqual([]);
  } finally {
    if (scheduler) await stop(scheduler);
    await stop(api);
    await queue.close();
    await db.end();
    log.end();
  }
});
