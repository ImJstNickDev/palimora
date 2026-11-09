// Real entrypoint/leadership regressions in a fully populated disposable fixture.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw Error("Private fixture required");
if (process.env.P2D_PROBE_CHILD === "1") {
  const fetch = global.fetch;
  let held = false;
  global.fetch = async (...args) => {
    const response = await fetch(...args);
    if (!held && String(args[0]).endsWith("/_bulk")) {
      held = true;
      assert.ok(response.ok);
      await response.clone().json();
      fs.writeFileSync(process.env.P2D_PROBE_MARKER, "accepted");
      while (!fs.existsSync(process.env.P2D_PROBE_MARKER + "-release"))
        await new Promise((r) => setTimeout(r, 25));
    }
    return response;
  };
} else {
  const { spawn } = require("node:child_process"),
    { once } = require("node:events");
  const { pool } = require("../apps/api/dist/db");
  const children = new Set(),
    connections = new Set(),
    report = {};
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, timeout = 30000) {
    const end = Date.now() + timeout;
    while (!(await fn())) {
      assert.ok(Date.now() < end, "Role test deadline");
      await pause(25);
    }
  }
  function launch(role, name, env = {}) {
    const fd = fs.openSync("/results/role-" + name + ".log", "w");
    const child = spawn(
      process.execPath,
      [
        ...(env.P2D_PROBE_CHILD ? ["--require", __filename] : []),
        "apps/api/dist/" +
          (role === "api" ? "main.js" : "projection-worker.js"),
      ],
      {
        stdio: ["ignore", fd, fd],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          P0_PROFILE: "",
          PROJECTION_MODE: "isolated",
          PGAPPNAME: "p2d-" + name,
          ...env,
        },
      },
    );
    fs.closeSync(fd);
    child.projectionRole = role;
    children.add(child);
    return child;
  }
  async function stop(child, signal = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(child);
      return;
    }
    child.kill(signal);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20000);
    await once(child, "exit");
    clearTimeout(deadline);
    children.delete(child);
    if (signal !== "SIGKILL") {
      if (child.projectionRole === "worker")
        assert.equal(child.exitCode, 0, "Clean role shutdown");
      else assert.ok(child.exitCode === 0 || child.signalCode === signal);
    }
  }
  const queues = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM catalog_pending) current,(SELECT count(*)::int FROM catalog_snapshot_pending) historical,(SELECT count(*)::int FROM catalog_text_pending) text",
      )
    ).rows[0];
  const drained = async () =>
    Object.values(await queues()).every((v) => v === 0);
  const ready = async (name) =>
    until(() =>
      fs
        .readFileSync("/results/role-" + name + ".log", "utf8")
        .includes("projection_worker_ready"),
    );
  let ids, snapshots, api;
  async function enqueue(all = false) {
    await pool.query(
      "INSERT INTO catalog_text_pending(work_id) SELECT unnest($1::uuid[]) ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
      [ids],
    );
    if (all) {
      await pool.query(
        "INSERT INTO catalog_pending SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING",
        [ids],
      );
      await pool.query(
        "INSERT INTO catalog_snapshot_pending SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING",
        [snapshots],
      );
    }
  }
  async function readable() {
    const login = await fetch("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: {
        origin: "https://release.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "p0owner",
        password: "Private benchmark password 862!",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join(";");
    for (const path of [
      "/works",
      "/works/" + ids[0],
      "/works/" + ids[0] + "/read",
    ]) {
      const r = await fetch("http://localhost:3000/api/v1" + path, {
        headers: { cookie },
      });
      assert.equal(r.status, 200);
      const value = await r.json();
      if (path === "/works" && value.next) {
        const pit = JSON.parse(Buffer.from(value.next, "base64url")).p;
        await require("../apps/api/dist/catalog-search").searchRequest(
          "/_search/point_in_time",
          { pit_id: [pit] },
          "DELETE",
        );
      }
    }
  }
  (async () => {
    assert.ok(await drained());
    const rows = (
      await pool.query(
        "SELECT work_id,snapshot_id FROM catalog_documents ORDER BY work_id LIMIT 12",
      )
    ).rows;
    assert.equal(rows.length, 12);
    ids = rows.map((r) => r.work_id);
    snapshots = rows.map((r) => r.snapshot_id);
    api = launch("api", "api-only");
    await until(async () => {
      try {
        return (await fetch("http://localhost:3000/api/v1/health")).ok;
      } catch {
        return false;
      }
    });
    await enqueue(true);
    await pause(1500);
    assert.deepEqual(await queues(), { current: 12, historical: 12, text: 12 });
    await readable();
    report.api_only_leaves_all_projection_queues_untouched_and_reads_available = true;
    const w1 = launch("worker", "first"),
      w2 = launch("worker", "second");
    await ready("first");
    await ready("second");
    await until(drained);
    await stop(w1);
    await stop(w2, "SIGINT");
    report.two_workers_and_sigterm_sigint = true;
    // SIGTERM must wait for an already entered atomic catalog transaction.
    const lock = await pool.connect();
    connections.add(lock);
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock(70210408)");
    const atom = launch("worker", "atomic");
    await ready("atomic");
    await enqueue(true);
    await until(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='p2d-atomic' AND wait_event='advisory'",
          )
        ).rows[0].n > 0,
    );
    atom.kill("SIGTERM");
    await pause(200);
    assert.equal(atom.exitCode, null);
    assert.equal(atom.signalCode, null);
    await lock.query("COMMIT");
    lock.release();
    connections.delete(lock);
    await stop(atom);
    report.sigterm_waits_for_atomic_catalog_transaction = true;
    // Pause/maintenance keep their existing SQL authority in the dedicated role.
    await pool.query("UPDATE operations_index SET paused=true");
    await enqueue(true);
    const paused = launch("worker", "paused");
    await ready("paused");
    await pause(1200);
    assert.equal((await queues()).current, 12);
    await pool.query(
      "UPDATE instance SET maintenance_mode='maintenance_light'; UPDATE operations_index SET paused=false",
    );
    await until(drained);
    await stop(paused);
    await pool.query("UPDATE instance SET maintenance_mode='normal'");
    report.dedicated_pause_resume_and_maintenance = true;
    // Kill the actual worker after a real accepted bulk and before its ACK.
    await enqueue();
    const marker = "/results/role-accepted";
    const killed = launch("worker", "killed", {
      P2D_PROBE_CHILD: "1",
      P2D_PROBE_MARKER: marker,
    });
    await ready("killed");
    await until(() => fs.existsSync(marker));
    await stop(killed, "SIGKILL");
    assert.ok((await queues()).text > 0);
    await readable();
    await pool.query(
      "UPDATE catalog_text_pending SET lease_until=clock_timestamp()-interval '1 second' WHERE claim IS NOT NULL",
    );
    const started = performance.now(),
      restarted = launch("worker", "restarted");
    await ready("restarted");
    await until(drained);
    report.sigkill_after_accepted_http = {
      recovery_ms: performance.now() - started,
      lease_expiry_forced: true,
    };
    await stop(restarted);
    // Revoke a session leader while its already accepted HTTP is held; a new
    // process must own operations_index state when the old response returns.
    await enqueue();
    const lostMarker = "/results/role-leader-lost";
    const old = launch("worker", "old", {
      P2D_PROBE_CHILD: "1",
      P2D_PROBE_MARKER: lostMarker,
    });
    await ready("old");
    await until(() => fs.existsSync(lostMarker));
    const leaders = await pool.query(
      "SELECT a.pid FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='p2d-old' AND l.locktype='advisory' AND l.objid=70210473 AND l.granted",
    );
    assert.equal(leaders.rows.length, 1);
    await pool.query("SELECT pg_terminate_backend($1)", [leaders.rows[0].pid]);
    await pool.query(
      "UPDATE catalog_text_pending SET lease_until=clock_timestamp()-interval '1 second' WHERE claim IS NOT NULL",
    );
    const replacement = launch("worker", "replacement");
    await ready("replacement");
    await until(drained);
    await stop(replacement);
    const state = (
      await pool.query(
        "SELECT state,processed,error,retry_at FROM operations_index WHERE kind='search'",
      )
    ).rows[0];
    old.kill("SIGTERM");
    fs.writeFileSync(lostMarker + "-release", "release");
    await stop(old);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT state,processed,error,retry_at FROM operations_index WHERE kind='search'",
        )
      ).rows[0],
      state,
    );
    report.lost_leader_cannot_overwrite_replacement_state = true;
    // Forward transition and rollback use exactly the same locks and queues.
    await stop(api);
    api = launch("api", "inline", { PROJECTION_MODE: "inline" });
    await until(async () => {
      try {
        return (await fetch("http://localhost:3000/api/v1/health")).ok;
      } catch {
        return false;
      }
    });
    await enqueue(true);
    await until(drained);
    await stop(api);
    api = launch("api", "isolated-again");
    await until(async () => {
      try {
        return (await fetch("http://localhost:3000/api/v1/health")).ok;
      } catch {
        return false;
      }
    });
    await enqueue(true);
    await pause(1200);
    assert.equal((await queues()).current, 12);
    const forward = launch("worker", "forward");
    await ready("forward");
    await until(drained);
    await stop(forward);
    await readable();
    report.inline_isolated_transitions_both_directions = true;
    if (process.env.P2D_HOST_LIFECYCLE === "1") {
      await pool.query("UPDATE operations_index SET paused=true");
      await enqueue(true);
      fs.writeFileSync("/results/role-container-start-ready", "ready");
      await until(() => fs.existsSync("/results/role-container-started"));
      assert.equal((await queues()).current, 12);
      fs.writeFileSync("/results/role-container-restart-ready", "ready");
      await until(() => fs.existsSync("/results/role-container-restarted"));
      await pool.query("UPDATE operations_index SET paused=false");
      await until(drained);
      report.actual_container_restart_preserves_pending_work = true;
      await enqueue(true);
      fs.writeFileSync("/results/role-pg-stop-ready", "ready");
      await until(() => fs.existsSync("/results/role-pg-restarted"), 60000);
      await pool.query(
        "UPDATE catalog_text_pending SET lease_until=clock_timestamp()-interval '1 second' WHERE claim IS NOT NULL",
      );
      const recovery = performance.now();
      await until(drained, 120000);
      await readable();
      report.postgres_container_restart = {
        recovery_after_ready_ms: performance.now() - recovery,
        lease_expiry_forced: true,
      };
      fs.writeFileSync("/results/role-container-stop-ready", "ready");
      await until(() => fs.existsSync("/results/role-container-stopped"));
    }
    await stop(api);
    assert.ok(await drained());
    fs.writeFileSync(
      "/results/projection-role.json",
      JSON.stringify(report, null, 2),
    );
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      for (const c of children) await stop(c, "SIGKILL");
      for (const db of connections) {
        await db.query("ROLLBACK").catch(() => {});
        db.release();
      }
      await pool
        .query(
          "UPDATE operations_index SET paused=false; UPDATE instance SET maintenance_mode='normal'",
        )
        .catch(() => {});
      await pool.end();
    });
}
