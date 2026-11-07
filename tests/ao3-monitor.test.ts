import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  classifyAO3,
  retryAfter,
  nextProbeDelay,
} from "../apps/api/src/ao3-availability";
const search =
  '<html><title>Search Works | Archive of Our Own</title><form action="/works/search"><input name="work_search[query]"></form></html>';
test("AO3 health requires a usable search page and preserves rate limits", () => {
  assert.equal(classifyAO3(200, search), "online");
  assert.equal(
    classifyAO3(
      200,
      "<title>Archive of Our Own</title><p>The archive is down for maintenance.</p>",
    ),
    "maintenance",
  );
  assert.equal(
    classifyAO3(200, "<title>Maintenance</title>" + search),
    "maintenance",
  );
  assert.equal(
    classifyAO3(200, search + "<p>The archive is undergoing maintenance.</p>"),
    "maintenance",
  );
  assert.equal(classifyAO3(200, "<h1>Archive of Our Own</h1>"), "unknown");
  assert.equal(
    classifyAO3(200, "<p>Verify you are human</p>" + search),
    "blocked",
  );
  assert.equal(classifyAO3(429, search), "rate_limited");
  assert.equal(classifyAO3(503, search), "maintenance");
  assert.equal(classifyAO3(403, search), "blocked");
  assert.equal(classifyAO3(302, search), "unknown");
  assert.equal(classifyAO3(404, "Not found"), "unknown");
  assert.equal(retryAfter("120", 0), 120000);
  assert.equal(retryAfter("Thu, 01 Jan 1970 00:02:00 GMT", 0), 120000);
  assert.equal(retryAfter("invalid", 0), null);
  assert.equal(nextProbeDelay("rate_limited", 1, 86400000, 0), 86400000);
  assert.ok(
    nextProbeDelay("maintenance", 5, null, 0) >
      nextProbeDelay("maintenance", 1, null, 0),
  );
});
test(
  "persistent AO3 monitor serializes probes, honors overrides and retains watch deadlines",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "test_monitor_" + randomUUID().replaceAll("-", "");
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = url.toString();
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { monitorAO3, recordAO3Open, ao3MonitorOperation } = await import(
      "../apps/api/src/ao3-monitor"
    );
    const original = globalThis.fetch;
    let requests = 0;
    try {
      await migrate();
      globalThis.fetch = async () => {
        requests++;
        return new Response("<title>Maintenance</title>", { status: 200 });
      };
      await Promise.all([monitorAO3(), monitorAO3()]);
      assert.equal(requests, 1);
      assert.equal(
        (await pool.query("SELECT observed_state FROM ao3_control")).rows[0]
          .observed_state,
        "maintenance",
      );
      await pool.query(
        "UPDATE ao3_control SET next_probe_at=now()-interval '1 second',next_request_at=now()",
      );
      globalThis.fetch = async () => {
        requests++;
        return new Response(search, {
          status: 429,
          headers: { "Retry-After": "7200" },
        });
      };
      await monitorAO3();
      await transaction((db) =>
        ao3MonitorOperation(db, "ao3Control", {
          mode: "force_online",
          paused: false,
        }),
      );
      await pool.query(
        "UPDATE ao3_control SET next_probe_at=now()-interval '1 second',next_request_at=now()",
      );
      await monitorAO3();
      assert.equal(requests, 2, "Online override cannot bypass cooldown");
      assert.equal(
        (await pool.query("SELECT count(*) FROM ao3_health_history")).rows[0]
          .count,
        "2",
      );
      await transaction((db) =>
        ao3MonitorOperation(db, "ao3Control", {
          mode: "force_offline",
          paused: false,
        }),
      );
      await pool.query("UPDATE ao3_control SET cooldown_until=NULL");
      await monitorAO3();
      assert.equal(requests, 2);
      await transaction((db) =>
        ao3MonitorOperation(db, "ao3Control", { mode: "auto", paused: false }),
      );
      globalThis.fetch = async () => {
        requests++;
        return new Response(search);
      };
      await monitorAO3();
      const status: any = await transaction((db) =>
        ao3MonitorOperation(db, "ao3Status", {}),
      );
      assert.equal(status.control.observed_state, "online");
      assert.equal(status.control.eligible, true);
      await transaction((db) =>
        ao3MonitorOperation(db, "ao3Control", { mode: "auto", paused: true }),
      );
      await pool.query(
        "UPDATE ao3_control SET next_probe_at=now()-interval '1 second',next_request_at=now()",
      );
      await monitorAO3();
      assert.equal(requests, 3, "Paused monitor does not probe");
      const id = randomUUID();
      await pool.query(
        "INSERT INTO archive_work_heads(id,external_id) VALUES($1,$2)",
        [id, "123"],
      );
      await transaction((db) => recordAO3Open(db, id));
      const first = (await pool.query("SELECT * FROM ao3_watch")).rows[0];
      await transaction((db) => recordAO3Open(db, id));
      const second = (await pool.query("SELECT * FROM ao3_watch")).rows[0];
      assert.equal(first.next_due_at.getTime(), second.next_due_at.getTime());
      assert.ok(second.watch_until >= first.watch_until);
      assert.equal(
        second.watch_until.getTime() - second.last_open_at.getTime(),
        48 * 3600000,
      );
      const { scheduleSync } = await import("../apps/api/src/ao3-scheduler");
      await pool.query(
        "UPDATE ao3_control SET seed_cursor='ffffffff-ffff-ffff-ffff-ffffffffffff'",
      );
      await scheduleSync();
      const watched = (
        await pool.query(
          "SELECT * FROM ao3_jobs WHERE kind='work' AND target='123'",
        )
      ).rows[0];
      assert.ok(
        watched,
        "watch bypasses historical cursor without an immediate fetch",
      );
      assert.equal(watched.due_at.getTime(), first.next_due_at.getTime());
      await pool.query("UPDATE ao3_watch SET availability='deleted'");
      await transaction((db) => recordAO3Open(db, id));
      assert.equal(
        (
          await pool.query("SELECT last_open_at FROM ao3_watch")
        ).rows[0].last_open_at.getTime(),
        second.last_open_at.getTime(),
      );
      assert.equal(requests, 3, "Reader opens never request AO3");
    } finally {
      globalThis.fetch = original;
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    }
  },
);
