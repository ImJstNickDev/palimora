import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test(
  "login: failed-attempt quota, concurrent requests and reusable valid TOTP",
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const schema = "test_" + randomUUID().replaceAll("-", "");
    const setup = new Pool({ connectionString: url.toString() });
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_KEY = "ab".repeat(32);
    process.env.APP_ORIGIN = "http://localhost:5173";
    process.env.PORT = "0";
    const { start } = await import("../apps/api/dist/main.js");
    const { pool } = await import("../apps/api/dist/db.js");
    const { digest, seal, totp } = await import("../apps/api/dist/security.js");
    const runtime = await start();
    const base = await runtime.app.getUrl();
    const password = "Login rate test password 42";
    let cookie = "",
      csrf = "";
    const request = async (path: string, body: unknown, ip = "192.0.2.1") => {
      const response = await fetch(base + "/api/v1" + path, {
        method: "POST",
        headers: {
          origin: process.env.APP_ORIGIN!,
          "content-type": "application/json",
          cookie,
          "x-csrf-token": csrf,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const set = response.headers.get("set-cookie");
      if (set?.includes("palimora_session=")) cookie = set.split(";")[0];
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    };
    const login = (extra = {}, ip?: string) =>
      request("/auth/login", { username: "reader", password, ...extra }, ip);
    const failures = async () =>
      (
        await pool.query(
          "SELECT key,hits,until_at FROM rate_limits WHERE key LIKE 'login-failure-%' ORDER BY key",
        )
      ).rows;
    try {
      assert.equal(
        (
          await request("/auth/setup", {
            name: "Test",
            username: "reader",
            password,
            preferences: { language: "it", theme: "auto", skin: "ink" },
          })
        ).status,
        200,
      );
      await pool.query("DELETE FROM rate_limits");
      await t.test(
        "successful logins/logout bypass old shared buckets and do not count",
        async () => {
          await pool.query(
            "INSERT INTO rate_limits VALUES($1,180,now()+interval '15 minutes')",
            ["ip:" + digest("192.0.2.1")],
          );
          for (let i = 0; i < 5; i++) {
            assert.equal((await login()).status, 200);
            assert.equal((await request("/auth/logout", {})).status, 200);
          }
          assert.deepEqual(await failures(), []);
          assert.equal((await request("/auth/passkey/options", {})).status, 200);
          await pool.query("DELETE FROM rate_limits");
        },
      );

      const otp = totp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
      await pool.query(
        "UPDATE users SET totp_secret=$1,totp_counter=$2 WHERE username='reader'",
        [seal(otp.secret.base32), Math.floor(Date.now() / 30000)],
      );
      await t.test(
        "2FA challenges are free, TOTP can be reused, expired codes fail",
        async () => {
          for (let i = 0; i < 5; i++)
            assert.equal((await login()).data.code, "SECOND_FACTOR_REQUIRED");
          const code = otp.generate();
          assert.equal((await login({ code })).status, 200);
          assert.equal((await request("/auth/logout", {})).status, 200);
          assert.equal((await login({ code })).status, 200);
          assert.deepEqual(await failures(), []);
          let expired = otp.generate({ timestamp: Date.now() - 300000 });
          // Avoid a coincidental six-digit match with the current acceptance window.
          for (
            let offset = 600000;
            otp.validate({ token: expired, window: 1 }) !== null;
            offset += 300000
          )
            expired = otp.generate({ timestamp: Date.now() - offset });
          assert.equal(
            (await login({ code: expired })).data.code,
            "SECOND_FACTOR_INVALID",
          );
          assert.deepEqual(
            (await failures()).map((r) => r.hits),
            [1, 1],
          );
          assert.equal((await login({ code: otp.generate() })).status, 200);
          assert.deepEqual(
            (await failures()).map((r) => r.hits),
            [1, 1],
          );
          await pool.query("DELETE FROM rate_limits");
        },
      );

      await t.test(
        "four failures are durable, concurrent excess requests are blocked without extending the wait",
        async () => {
          const results = await Promise.all(
            Array.from({ length: 7 }, () =>
              login({ password: "wrong password" }),
            ),
          );
          assert.equal(
            results.filter((r) => r.data.code === "CREDENTIALS_INVALID").length,
            4,
          );
          assert.equal(
            results.filter((r) => r.data.code === "RATE_LIMITED").length,
            3,
          );
          for (const r of results.filter((r) => r.status === 429)) {
            const seconds = Number(r.headers.get("retry-after"));
            assert(seconds > 0 && seconds <= 60);
          }
          const before = await failures();
          assert.deepEqual(
            before.map((r) => r.hits),
            [4, 4],
          );
          assert.equal((await login({ code: otp.generate() })).status, 429);
          assert.deepEqual(await failures(), before);
          // Username quota survives an IP change; IP quota survives a username change.
          assert.equal(
            (await login({ username: "READER" }, "192.0.2.2")).status,
            429,
          );
          assert.equal((await login({ username: "missinguser" })).status, 429);
          await pool.query(
            "UPDATE rate_limits SET until_at=now()-interval '1 second' WHERE key LIKE 'login-failure-%'",
          );
          assert.equal((await login({ code: otp.generate() })).status, 200);
          assert.equal(
            (await login({ password: "wrong password" })).status,
            401,
          );
          assert.deepEqual(
            (await failures()).map((r) => r.hits),
            [1, 1],
          );
          await pool.query("DELETE FROM rate_limits");
        },
      );

      await t.test(
        "recovery remains single use and failed transactions retain no authentication effects",
        async () => {
          const recovery = "0123456789abcdefabcd";
          await pool.query(
            "INSERT INTO recovery_codes SELECT id,$1 FROM users WHERE username='reader'",
            [digest(recovery)],
          );
          await pool.query(`CREATE FUNCTION reject_login_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='login' AND NEW.outcome='success' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_login BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION reject_login_audit()`);
          const sessions = (
            await pool.query("SELECT count(*)::int n FROM sessions")
          ).rows[0].n;
          assert.equal((await login({ password: recovery })).status, 500);
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM sessions")).rows[0]
              .n,
            sessions,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM recovery_codes"))
              .rows[0].n,
            1,
          );
          assert.deepEqual(await failures(), []);
          await pool.query(
            "DROP TRIGGER reject_login ON audit; DROP FUNCTION reject_login_audit()",
          );
          assert.equal((await login({ password: recovery })).status, 200);
          assert.equal(
            (await login({ password: recovery })).data.code,
            "CREDENTIALS_INVALID",
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM recovery_codes"))
              .rows[0].n,
            0,
          );
        },
      );
    } finally {
      await runtime.close();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  },
);
