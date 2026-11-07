import { syncGate } from "./ao3-policy";
import { pool } from "./db";
import { seal, unseal } from "./security";
import { retryAfter, classifyAO3 } from "./ao3-availability";
import { dom, all, attr, clean } from "./ao3-html";
import { SyncError } from "./ao3-errors";
export { SyncError } from "./ao3-errors";
const origin = "https://archiveofourown.org";
export function permittedByRobots(body: string, path: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let group = groups[0];
  let rules = false;
  for (const line of body.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[1].toLowerCase() === "user-agent") {
      if (!group || rules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        rules = false;
      }
      group.agents.push(m[2].toLowerCase());
    } else if (group && /^(allow|disallow)$/i.test(m[1])) {
      rules = true;
      if (m[2])
        group.rules.push({ allow: m[1].toLowerCase() === "allow", path: m[2] });
    }
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && "palimora".includes(a)),
  );
  const applicable = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  let winner = { allow: true, length: -1 };
  for (const rule of applicable.flatMap((g) => g.rules)) {
    const pattern =
      "^" +
      rule.path
        .split("*")
        .map((p) => p.replace(/[.+?^{}()|[\]\\]/g, "\\$&"))
        .join(".*");
    if (
      new RegExp(pattern).test(path) &&
      (rule.path.length > winner.length ||
        (rule.path.length === winner.length && rule.allow))
    )
      winner = { allow: rule.allow, length: rule.path.length };
  }
  return winner.allow;
}
export class AO3Client {
  private cookies: Record<string, string> = {};
  private authenticated = false;
  private credentialVersion: string | null | undefined;
  constructor(private stopped: () => boolean = () => false) {}
  private async raw(
    path: string,
    method = "GET",
    body?: URLSearchParams,
  ): Promise<{ status: number; html: string; location: string | null }> {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password)
      throw new SyncError("AO3_REDIRECT_BLOCKED");
    const db = await pool.connect();
    try {
      await db.query("SELECT pg_advisory_lock(70210421)");
      const c = (await db.query("SELECT * FROM ao3_control")).rows[0];
      if (
        this.credentialVersion !== undefined &&
        c.credentials !== this.credentialVersion
      )
        throw new SyncError("AO3_ACCOUNT_CHANGED", 60000);
      if (this.stopped() || c.paused || c.mode === "force_offline")
        throw new SyncError("AO3_PAUSED", 60000);
      if (syncGate(c) !== null) throw new SyncError("AO3_OFFLINE", 300000);
      const due = Math.max(
        c.next_request_at.getTime(),
        c.cooldown_until?.getTime() ?? 0,
      );
      if (due - Date.now() > 30000)
        throw new SyncError("AO3_COOLDOWN", due - Date.now());
      while (Date.now() < due) {
        if (this.stopped()) throw new SyncError("STOPPED", 60000);
        await new Promise((r) =>
          setTimeout(r, Math.min(500, due - Date.now())),
        );
      }
      const current = (
        await db.query(
          "SELECT paused,mode,observed_state,cooldown_until,credentials FROM ao3_control",
        )
      ).rows[0];
      if (syncGate(current) !== null) throw new SyncError("AO3_PAUSED", 60000);
      if (
        this.credentialVersion !== undefined &&
        current.credentials !== this.credentialVersion
      )
        throw new SyncError("AO3_ACCOUNT_CHANGED", 60000);
      await db.query(
        "UPDATE ao3_control SET next_request_at=now()+spacing_ms*interval '1 millisecond'",
      );
      const response = await fetch(url, {
        method,
        body: body?.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
        headers: {
          "User-Agent": "Palimora/1.0 (personal archive synchronization)",
          "Accept-Language": "en",
          Accept: "text/html",
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(Object.keys(this.cookies).length
            ? {
                Cookie: Object.entries(this.cookies)
                  .map(([k, v]) => k + "=" + v)
                  .join("; "),
              }
            : {}),
        },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0],
          i = pair.indexOf("=");
        if (i > 0) this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const retry = retryAfter(response.headers.get("retry-after"));
      if (
        response.status === 429 ||
        response.status === 503 ||
        retry !== null
      ) {
        const delay = Math.max(
          retry ?? 0,
          300000,
          Math.min(3600000, c.spacing_ms * 4),
        );
        await response.body?.cancel();
        await db.query(
          `UPDATE ao3_control SET cooldown_until=greatest(cooldown_until,now()+$1*interval '1 millisecond'),
          spacing_ms=least(3600000,spacing_ms*2),observed_state=$2,next_probe_at=now()+$1*interval '1 millisecond'`,
          [delay, response.status === 503 ? "maintenance" : "rate_limited"],
        );
        throw new SyncError("AO3_RATE_LIMIT", delay);
      }
      const bytes: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const p = await reader.read();
            if (p.done) break;
            size += p.value.length;
            if (size > 64 * 1024 * 1024) {
              await reader.cancel();
              throw new SyncError("AO3_DOCUMENT_MEMORY_BUDGET");
            }
            bytes.push(p.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const html = Buffer.concat(bytes).toString("utf8"),
        state = classifyAO3(response.status, html);
      if (
        response.status === 429 ||
        response.status === 503 ||
        retry !== null ||
        state === "maintenance" ||
        state === "blocked"
      ) {
        const delay = Math.max(
          retry ?? 0,
          Math.min(3600000, c.spacing_ms * 4),
          300000,
        );
        await db.query(
          `UPDATE ao3_control SET cooldown_until=greatest(cooldown_until,now()+$1*interval '1 millisecond'),
          spacing_ms=least(3600000,spacing_ms*2),observed_state=$2,next_probe_at=now()+$1*interval '1 millisecond'`,
          [delay, state === "unknown" ? "rate_limited" : state],
        );
        throw new SyncError(
          state === "maintenance"
            ? "AO3_MAINTENANCE"
            : state === "blocked"
              ? "AO3_BLOCKED"
              : "AO3_RATE_LIMIT",
          delay,
        );
      }
      await db.query(
        "UPDATE ao3_control SET spacing_ms=greatest(10000,(spacing_ms*0.95)::int)",
      );
      return {
        status: response.status,
        html,
        location: response.headers.get("location"),
      };
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError("AO3_NETWORK", 300000);
    } finally {
      await db.query("SELECT pg_advisory_unlock(70210421)");
      db.release();
    }
  }
  async get(path: string, auth = true) {
    const c = (
      await pool.query("SELECT robots,robots_checked_at FROM ao3_control")
    ).rows[0];
    let robots = c.robots;
    if (
      !c.robots_checked_at ||
      Date.now() - c.robots_checked_at.getTime() > 86400000
    ) {
      const r = await this.raw("/robots.txt");
      if (r.status !== 200 && r.status !== 404)
        throw new SyncError("ROBOTS_UNAVAILABLE");
      robots = r.status === 404 ? "" : r.html;
      await pool.query(
        "UPDATE ao3_control SET robots=$1,robots_checked_at=now()",
        [robots],
      );
    }
    if (
      !permittedByRobots(
        robots,
        new URL(path, origin).pathname + new URL(path, origin).search,
      )
    )
      throw new SyncError("ROBOTS_DISALLOWED", 86400000);
    if (auth && !this.authenticated) await this.login();
    for (let hop = 0; hop < 5; hop++) {
      const r = await this.raw(path);
      if (!r.location || r.status < 300 || r.status >= 400)
        return { ...r, path };
      const u = new URL(r.location, origin);
      if (u.origin !== origin) throw new SyncError("AO3_REDIRECT_BLOCKED");
      if (u.pathname.includes("/users/login")) {
        await pool.query(
          "UPDATE ao3_control SET cookies=NULL,auth_state=CASE WHEN credentials IS NULL THEN 'anonymous' ELSE 'expired' END",
        );
        throw new SyncError("AO3_LOGIN_REQUIRED");
      }
      if (!permittedByRobots(robots, u.pathname + u.search))
        throw new SyncError("ROBOTS_DISALLOWED", 86400000);
      path = u.pathname + u.search;
    }
    throw new SyncError("AO3_REDIRECT_LOOP");
  }
  private async login() {
    this.authenticated = true;
    const c = (await pool.query("SELECT credentials,cookies FROM ao3_control"))
      .rows[0];
    this.credentialVersion = c.credentials;
    if (!c.credentials) return;
    if (c.cookies) {
      this.cookies = JSON.parse(unseal(c.cookies));
      return;
    }
    const credentials = JSON.parse(unseal(c.credentials));
    const page = await this.raw("/users/login");
    const token = all(
      dom(page.html),
      (n) => n.name === "input" && attr(n, "name") === "authenticity_token",
    ).map((n) => attr(n, "value"))[0];
    if (!token) throw new SyncError("AO3_LOGIN_FORM");
    const r = await this.raw(
      "/users/login",
      "POST",
      new URLSearchParams({
        authenticity_token: token,
        "user[login]": credentials.username,
        "user[password]": credentials.password,
        "user[remember_me]": "1",
      }),
    );
    if (
      r.status !== 302 ||
      !r.location ||
      r.location.includes("/users/login")
    ) {
      await pool.query(
        "UPDATE ao3_control SET auth_state='rejected',cookies=NULL",
      );
      throw new SyncError("AO3_LOGIN_REJECTED", 86400000);
    }
    const verify = await this.raw("/");
    if (
      !all(
        dom(verify.html),
        (n) => n.name === "a" && attr(n, "href").includes("/users/logout"),
      ).length
    )
      throw new SyncError("AO3_LOGIN_UNVERIFIED");
    await pool.query(
      "UPDATE ao3_control SET cookies=$1,auth_state='authenticated' WHERE credentials=$2",
      [seal(JSON.stringify(this.cookies)), c.credentials],
    );
  }
}
