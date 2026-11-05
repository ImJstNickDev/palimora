import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { TOTP, Secret } from "otpauth";
const enabled = !!process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL identity: bootstrap race, invitations, ACL, MFA, revocation, audit and restart",
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(
      url.pathname,
      /test/,
      "Refuse to run integration suite against a production database",
    );
    const schema = "test_" + randomUUID().replaceAll("-", "");
    const setupPool = new Pool({ connectionString: url.toString() });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_KEY = "ab".repeat(32);
    process.env.APP_ORIGIN = "http://localhost:5173";
    process.env.PORT = "0";
    const { start } = await import("../apps/api/dist/main.js");
    const { pool, migrate } = await import("../apps/api/dist/db.js");
    let runtime = await start();
    let base = await runtime.app.getUrl();
    const pref = { language: "it", theme: "auto", skin: "ink" },
      password = "Very strong test passphrase 42";
    class Client {
      cookie = "";
      csrf = "";
      async request(
        path: string,
        body?: unknown,
        method = body === undefined ? "GET" : "POST",
        extra: Record<string, string> = {},
      ) {
        const res = await fetch(base + "/api/v1" + path, {
          method,
          headers: {
            origin: process.env.APP_ORIGIN!,
            "content-type": "application/json",
            cookie: this.cookie,
            "x-csrf-token": this.csrf,
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await res.json();
        const set = res.headers.get("set-cookie");
        if (set?.includes("palimora_session=")) this.cookie = set.split(";")[0];
        if (data.csrf) this.csrf = data.csrf;
        return { status: res.status, data, headers: res.headers };
      }
    }
    const owner = new Client();
    let userId = "",
      adminId = "",
      user: Client,
      admin: Client;
    const invite = async (overrides = {}) => {
      const r = await owner.request("/invites", {
        days: 7,
        maxUses: 1,
        requestId: randomUUID(),
        ...overrides,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert(!JSON.stringify(r.data).includes("token_hash"));
      return r.data;
    };
    const register = async (name: string, token: string, email = "") => {
      const c = new Client();
      const r = await c.request("/auth/register", {
        username: name,
        password,
        email,
        token,
        preferences: pref,
      });
      return { c, r };
    };
    try {
      await t.test(
        "Bootstrap failure rolls back ownership and instance state",
        async () => {
          await pool.query(
            `CREATE FUNCTION reject_setup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test transaction failure'; END $$; CREATE TRIGGER reject_setup BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION reject_setup_audit()`,
          );
          const result = await new Client().request("/auth/setup", {
            name: "Rollback",
            username: "rollbackowner",
            password,
            preferences: pref,
          });
          assert.equal(result.status, 500);
          assert.equal(
            (await pool.query("SELECT state FROM instance")).rows[0].state,
            "uninitialized",
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM users")).rows[0].n,
            0,
          );
          await pool.query(
            "DROP TRIGGER reject_setup ON audit; DROP FUNCTION reject_setup_audit()",
          );
        },
      );
      await t.test(
        "Exactly one bootstrap succeeds and wizard remains closed",
        async () => {
          const attempts = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
              new Client().request("/auth/setup", {
                name: "Test library",
                username: "owner" + i,
                password,
                preferences: pref,
              }),
            ),
          );
          assert.equal(attempts.filter((r) => r.status === 200).length, 1);
          assert.equal(
            attempts.filter((r) => r.data.code === "SETUP_CLOSED").length,
            7,
          );
          const username = attempts.find((r) => r.status === 200)!.data.user
            .username;
          assert.equal(
            (await owner.request("/auth/login", { username, password })).status,
            200,
          );
          assert.match(owner.cookie, /palimora_session=/);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM users WHERE role='Owner'",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            pool.query("UPDATE users SET role='Admin' WHERE role='Owner'"),
          );
        },
      );
      await t.test(
        "Origin and synchronizer token required for mutations",
        async () => {
          assert.equal(
            (
              await owner.request(
                "/invites",
                { days: 1, maxUses: 1, requestId: randomUUID() },
                "POST",
                { origin: "https://evil.invalid" },
              )
            ).data.code,
            "CSRF",
          );
          assert.equal(
            (
              await owner.request(
                "/invites",
                { days: 1, maxUses: 1, requestId: randomUUID() },
                "POST",
                { "x-csrf-token": "" },
              )
            ).data.code,
            "CSRF",
          );
        },
      );
      await t.test(
        "Invitation consumption is atomic, bounded, hash-only, email bound and idempotent",
        async () => {
          assert.equal(
            (await register("outsider", "x".repeat(43))).r.data.code,
            "INVITE_INVALID",
          );
          const i = await invite();
          const results = await Promise.all([
            register("alice", i.token),
            register("bob", i.token),
          ]);
          assert.equal(results.filter((x) => x.r.status === 200).length, 1);
          const winner = results.find((x) => x.r.status === 200)!;
          user = winner.c;
          userId = winner.r.data.user.id;
          const stored = (
            await pool.query(
              "SELECT token_hash,uses FROM invites WHERE id=$1",
              [i.invite.id],
            )
          ).rows[0];
          assert.notEqual(stored.token_hash, i.token);
          assert.equal(stored.uses, 1);
          const bound = await invite({ email: "Reader@example.org" });
          assert.equal(
            (await register("boundwrong", bound.token, "other@example.org")).r
              .status,
            400,
          );
          const joined = await register(
            "boundok",
            bound.token,
            "reader@example.org",
          );
          assert.equal(joined.r.status, 200);
          admin = joined.c;
          adminId = joined.r.data.user.id;
          const requestId = randomUUID();
          const first = await invite({ requestId });
          const retry = await invite({ requestId });
          assert.equal(first.invite.id, retry.invite.id);
          assert.equal(retry.token, null);
          await owner.request("/invites/" + first.invite.id, {}, "DELETE");
          assert.equal((await register("revoked", first.token)).r.status, 400);
          const expired = await invite();
          await pool.query(
            "UPDATE invites SET expires_at=now()-interval '1 second' WHERE id=$1",
            [expired.invite.id],
          );
          assert.equal(
            (await register("expired", expired.token)).r.status,
            400,
          );
        },
      );
      await t.test(
        "Role boundaries and immediate session invalidation",
        async () => {
          assert.equal((await user.request("/invites", {})).status, 400);
          assert.equal((await user.request("/invites")).status, 403);
          assert.equal((await user.request("/admin/users")).status, 403);
          assert.equal(
            (
              await owner.request(
                "/admin/users/" + adminId,
                { role: "Admin" },
                "PATCH",
              )
            ).status,
            200,
          );
          assert.equal((await admin.request("/me")).status, 401);
          await admin.request("/auth/login", { username: "boundok", password });
          assert.equal((await admin.request("/invites")).status, 403);
          assert.equal(
            (
              await admin.request(
                "/admin/users/" + userId,
                { role: "Admin" },
                "PATCH",
              )
            ).status,
            403,
          );
          const ownerId = (await owner.request("/me")).data.user.id;
          assert.equal(
            (
              await admin.request(
                "/admin/users/" + ownerId,
                { disabled: true },
                "PATCH",
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await owner.request(
                "/admin/users/" + userId,
                { disabled: true },
                "PATCH",
              )
            ).status,
            200,
          );
          assert.equal((await user.request("/me")).status, 401);
          await owner.request(
            "/admin/users/" + userId,
            { disabled: false },
            "PATCH",
          );
          const username = (
            await pool.query("SELECT username FROM users WHERE id=$1", [userId])
          ).rows[0].username;
          await user.request("/auth/login", { username, password });
          assert.equal(
            (await admin.request("/admin/users/" + userId + "/sessions"))
              .status,
            200,
          );
          await admin.request(
            "/admin/users/" + userId,
            { deleted: true },
            "PATCH",
          );
          assert.equal((await user.request("/me")).status, 401);
          assert.equal(
            (await user.request("/auth/login", { username, password })).status,
            401,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM users WHERE id=$1",
                [userId],
              )
            ).rows[0].n,
            1,
          );
          await owner.request(
            "/admin/users/" + userId,
            { deleted: false },
            "PATCH",
          );
          await user.request("/auth/login", { username, password });
        },
      );
      await t.test(
        "TOTP enrollment, anti-replay, single-use recovery and encrypted secret",
        async () => {
          await pool.query("DELETE FROM rate_limits");
          const abandoned = await user.request("/me/totp/start", { password });
          await user.request("/me/totp/verify", {
            code: new TOTP({
              secret: Secret.fromBase32(abandoned.data.secret),
            }).generate(),
          });
          await pool.query(
            "UPDATE challenges SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND kind='totp-ready'",
            [userId],
          );
          assert.equal(
            (await user.request("/me/totp/enable", { backupCodesSaved: true }))
              .data.code,
            "CHALLENGE_EXPIRED",
          );
          assert.equal(
            (await user.request("/me")).data.user.totp_enabled,
            false,
          );
          const start = await user.request("/me/totp/start", { password });
          assert.equal(start.status, 200);
          const otp = new TOTP({
            secret: Secret.fromBase32(start.data.secret),
          });
          assert.equal(
            (await user.request("/me/totp/enable", { backupCodesSaved: true }))
              .data.code,
            "CHALLENGE_EXPIRED",
          );
          const enabled = await user.request("/me/totp/verify", {
            code: otp.generate(),
          });
          assert.equal(
            (await user.request("/me")).data.user.totp_enabled,
            false,
          );
          assert.equal(
            (await user.request("/me/totp/enable", { backupCodesSaved: false }))
              .status,
            400,
          );
          const staged = (
            await pool.query(
              "SELECT value FROM challenges WHERE user_id=$1 AND kind='totp-ready'",
              [userId],
            )
          ).rows[0].value;
          assert.ok(!staged.includes(enabled.data.codes[0]));
          assert.equal(
            (await owner.request("/me/totp/enable", { backupCodesSaved: true }))
              .data.code,
            "CHALLENGE_EXPIRED",
          );
          assert.equal(
            (await user.request("/me/totp/enable", { backupCodesSaved: true }))
              .status,
            200,
          );
          assert.equal(
            (await user.request("/me")).data.user.totp_enabled,
            true,
          );
          assert.equal(
            (await user.request("/me/totp/enable", { backupCodesSaved: true }))
              .status,
            409,
          );
          assert.equal(enabled.status, 200);
          assert.equal(enabled.data.codes.length, 10);
          const row = (
            await pool.query("SELECT * FROM users WHERE id=$1", [userId])
          ).rows[0];
          assert.notEqual(row.totp_secret, start.data.secret);
          const fresh = new Client();
          assert.equal(
            (
              await fresh.request("/auth/login", {
                username: row.username,
                password,
              })
            ).data.code,
            "SECOND_FACTOR_REQUIRED",
          );
          assert.equal(
            (
              await fresh.request("/auth/login", {
                username: row.username,
                password,
                code: otp.generate(),
              })
            ).data.code,
            "SECOND_FACTOR_INVALID",
          );
          assert.equal(
            (
              await fresh.request("/auth/login", {
                username: "missinguser",
                password: enabled.data.codes[0],
              })
            ).data.code,
            "CREDENTIALS_INVALID",
          );
          assert.equal(
            (
              await fresh.request("/auth/login", {
                username: row.username,
                password: "incorrect password",
              })
            ).data.code,
            "CREDENTIALS_INVALID",
          );
          for (const state of ["disabled=true", "soft_deleted_at=now()"]) {
            await pool.query(`UPDATE users SET ${state} WHERE id=$1`, [userId]);
            assert.equal(
              (
                await fresh.request("/auth/login", {
                  username: row.username,
                  password: enabled.data.codes[0],
                })
              ).data.code,
              "CREDENTIALS_INVALID",
            );
            await pool.query(
              "UPDATE users SET disabled=false,soft_deleted_at=NULL WHERE id=$1",
              [userId],
            );
          }
          const outcomes = await Promise.all(
            [new Client(), new Client()].map((c) =>
              c.request("/auth/login", {
                username: row.username,
                password: enabled.data.codes[0],
              }),
            ),
          );
          assert.equal(outcomes.filter((r) => r.status === 200).length, 1);
          assert.equal(
            (
              await fresh.request("/auth/login", {
                username: row.username,
                password: enabled.data.codes[0],
              })
            ).data.code,
            "CREDENTIALS_INVALID",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT details->>'method' method FROM audit WHERE action='login' AND target=$1 ORDER BY created_at DESC LIMIT 1",
                [String(userId)],
              )
            ).rows[0].method,
            "recovery",
          );
          assert.equal(
            (
              await user.request("/me/totp/disable", {
                password,
                code: enabled.data.codes[1],
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM recovery_codes WHERE user_id=$1",
                [userId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "Admin reset, own password change and logout revoke credentials immediately",
        async () => {
          await pool.query("DELETE FROM rate_limits");
          const newPassword = "A different secure password 84";
          assert.equal(
            (
              await admin.request("/admin/users/" + userId + "/reset", {
                password,
                newPassword,
                resetFactors: true,
              })
            ).status,
            200,
          );
          assert.equal((await user.request("/me")).status, 401);
          const username = (
            await pool.query("SELECT username FROM users WHERE id=$1", [userId])
          ).rows[0].username;
          assert.equal(
            (await user.request("/auth/login", { username, password })).status,
            401,
          );
          assert.equal(
            (
              await user.request("/auth/login", {
                username,
                password: newPassword,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await user.request("/me/password", {
                password: newPassword,
                newPassword: password,
              })
            ).status,
            200,
          );
          assert.equal((await user.request("/me")).status, 401);
          await user.request("/auth/login", { username, password });
          const sessions = await user.request("/me/sessions");
          assert.equal(sessions.data.length, 1);
          const stolen = user.cookie;
          await user.request("/auth/logout", {});
          user.cookie = stolen;
          assert.equal((await user.request("/me")).status, 401);
        },
      );
      await t.test(
        "Self deletion retains identity and cannot remove Owner",
        async () => {
          const username = (
            await pool.query("SELECT username FROM users WHERE id=$1", [userId])
          ).rows[0].username;
          await user.request("/auth/login", { username, password });
          assert.equal(
            (await user.request("/me", { password }, "DELETE")).status,
            200,
          );
          assert.equal((await user.request("/me")).status, 401);
          assert(
            (
              await pool.query(
                "SELECT soft_deleted_at FROM users WHERE id=$1",
                [userId],
              )
            ).rows[0].soft_deleted_at,
          );
          assert.equal(
            (await owner.request("/me", { password }, "DELETE")).status,
            403,
          );
        },
      );
      await t.test(
        "Passkey endpoints reject missing challenges and malformed responses",
        async () => {
          assert.equal(
            (
              await new Client().request("/auth/passkey/verify", {
                response: { id: "fake" },
              })
            ).data.code,
            "CHALLENGE_EXPIRED",
          );
          const options = await owner.request("/me/passkeys/options", {
            password,
          });
          assert.equal(options.status, 200);
          assert.equal(
            options.data.authenticatorSelection.userVerification,
            "required",
          );
          assert.equal(
            (
              await owner.request("/me/passkeys", {
                name: "Invalid",
                response: { id: "fake" },
              })
            ).data.code,
            "PASSKEY_INVALID",
          );
        },
      );
      await t.test(
        "Durable rate limiting and append-only audit with no credentials",
        async () => {
          await pool.query("DELETE FROM rate_limits");
          const stranger = new Client();
          for (let i = 0; i < 15; i++)
            assert.equal(
              (
                await stranger.request("/auth/login", {
                  username: "absent",
                  password,
                })
              ).status,
              401,
            );
          assert.equal(
            (
              await stranger.request("/auth/login", {
                username: "absent",
                password,
              })
            ).status,
            429,
          );
          const rows = (await pool.query("SELECT * FROM audit")).rows;
          assert(rows.some((r: any) => r.action === "userReset"));
          const encoded = JSON.stringify(rows);
          assert(!encoded.includes(password));
          assert(!encoded.includes("token_hash"));
          await assert.rejects(pool.query("DELETE FROM audit"));
          await migrate();
        },
      );
      await t.test(
        "Restart preserves ownership, sessions and schema checksums",
        async () => {
          const old = owner.cookie;
          await runtime.app.close();
          runtime = await start();
          base = await runtime.app.getUrl();
          owner.cookie = old;
          assert.equal(
            (await owner.request("/auth/status")).data.state,
            "active",
          );
          assert.equal((await owner.request("/me")).status, 200);
          assert.equal(
            (
              await owner.request("/auth/setup", {
                username: "ownerAgain",
                password,
                name: "Again",
                preferences: pref,
              })
            ).data.code,
            "SETUP_CLOSED",
          );
        },
      );
    } finally {
      await runtime.close();
      await setupPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await setupPool.end();
    }
  },
);
