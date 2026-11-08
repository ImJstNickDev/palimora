import { auditState } from "./admin-audit";
import { maintenanceOperation } from "./maintenance-admin";
import { operationsOperation } from "./operations-admin";
import { backupOperation } from "./backup-admin";
import { socialOperation, statistics } from "./social";
import { readingOperation } from "./reading";
import { collectionOperation } from "./collections";
import { libraryOperation, recordReading } from "./library";
import { syncAdmin } from "./ao3-admin";
import { ao3MonitorOperation, recordAO3Open } from "./ao3-monitor";
import { downloadWork } from "./reader-download";
import { catalogOperation } from "./catalog";
import { archiveOperation } from "./archive-admin";
import { HttpException, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { api, type Operation, User } from "@palimora/contracts";
import { pool, transaction, type DB } from "./db";
import {
  config,
  digest,
  fail,
  hashPassword,
  random,
  seal,
  unseal,
  totp,
  verifyPassword,
} from "./security";
interface Context {
  request: Request;
  response: Response;
  requestId: string;
  user?: any;
  session?: any;
  actor?: any;
  parentSession?: any;
  auditOp?: string;
  auditInput?: any;
  before?: any;
  audited?: boolean;
}
const userColumns =
  "id,username,email,role,disabled,soft_deleted_at,created_at,preferences,(totp_secret IS NOT NULL) AS totp_enabled";
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value));
const publicUser = (row: any) =>
  User.parse(
    serialize({
      ...row,
      totp_enabled: !!row.totp_secret || row.totp_enabled === true,
    }),
  );
@Injectable()
export class Identity {
  private dummy = "";
  async initialize() {
    this.dummy = await hashPassword(random());
  }
  async audit(
    db: DB,
    c: Context,
    action: string,
    target?: string,
    details: object = {},
    outcome = "success",
  ) {
    c.audited = true;
    const state =
      c.before !== undefined
        ? {
            before: c.before,
            after:
              outcome === "success"
                ? await auditState(db, c.auditOp!, c.auditInput, c.user?.id)
                : c.before,
          }
        : {};
    await db.query(
      "INSERT INTO audit(actor_id,effective_user_id,session_id,ip,action,target,details,outcome,request_id) VALUES($1,$9,$2,$3,$4,$5,$6,$7,$8)",
      [
        c.actor?.id ?? c.user?.id ?? null,
        c.session?.id ?? null,
        c.request.ip ?? "",
        action,
        target ?? null,
        {
          ...details,
          ...state,
          ...(c.parentSession
            ? { original_session_id: c.parentSession.id }
            : {}),
        },
        outcome,
        c.requestId,
        c.user?.id ?? null,
      ],
    );
  }
  async rate(c: Context, op: Operation) {
    if (
      api[op].method === "get" ||
      ["login", "passkeyLoginFinish", "logout"].includes(op)
    )
      return;
    const sensitive = [
      "register",
      "setup",
      "passkeyLoginStart",
      "inviteInfo",
    ].includes(op);
    const buckets = [
      {
        key:
          (op === "passkeyLoginStart"
            ? "login-challenge-ip:"
            : op === "ao3UploadChunk"
              ? "media-ip:"
              : op === "readingHeartbeat"
                ? "reading-time-ip:"
                : "ip:") + digest(c.request.ip ?? ""),
        limit:
          op === "passkeyLoginStart"
            ? 60
            : op === "ao3UploadChunk"
              ? 6000
              : op === "readingHeartbeat"
                ? 1800
                : sensitive
                  ? 40
                  : 180,
      },
    ];
    if (
      c.request.cookies?.palimora_session &&
      [
        "password",
        "deleteAccount",
        "totpStart",
        "totpVerify",
        "totpEnable",
        "totpDisable",
        "recovery",
        "passkeyStart",
        "passkeyDelete",
        "userReset",
      ].includes(op)
    )
      buckets.push({
        key: "proof:" + digest(c.request.cookies.palimora_session),
        limit: 20,
      });
    await transaction(async (db) => {
      for (const bucket of buckets) {
        const r = await db.query(
          `INSERT INTO rate_limits(key,hits,until_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.until_at<now() THEN 1 ELSE rate_limits.hits+1 END,until_at=CASE WHEN rate_limits.until_at<now() THEN now()+$2*interval '1 second' ELSE rate_limits.until_at END RETURNING hits,ceil(extract(epoch FROM until_at-now()))::int AS retry_after`,
          [bucket.key, op === "passkeyLoginStart" ? 60 : 900],
        );
        if (r.rows[0].hits > bucket.limit) {
          c.response.setHeader(
            "Retry-After",
            Math.max(1, r.rows[0].retry_after),
          );
          fail("RATE_LIMITED", 429);
        }
      }
    });
  }
  private async loginAttempt(
    db: DB,
    op: "login" | "passkeyLoginFinish",
    input: any,
    c: Context,
  ) {
    const keys = ["login-failure-ip:" + digest(c.request.ip ?? "")];
    if (op === "login")
      keys.push("login-failure-user:" + digest(input.username.toLowerCase()));
    const blocked = await db.query(
      `SELECT ceil(extract(epoch FROM max(until_at)-clock_timestamp()))::int AS retry_after
       FROM rate_limits WHERE key=ANY($1::text[]) AND hits>=4 AND until_at>clock_timestamp()`,
      [keys],
    );
    if (blocked.rows[0].retry_after > 0) {
      c.response.setHeader("Retry-After", blocked.rows[0].retry_after);
      fail("RATE_LIMITED", 429);
    }
    await db.query("SAVEPOINT login_attempt");
    try {
      return { result: serialize(await this.run(db, op, input, c)) };
    } catch (error) {
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const code =
        response && typeof response === "object" && "code" in response
          ? response.code
          : null;
      if (
        ![
          "CREDENTIALS_INVALID",
          "SECOND_FACTOR_INVALID",
          "PASSKEY_INVALID",
          "CHALLENGE_EXPIRED",
        ].includes(String(code))
      )
        throw error;
      // Roll back authentication effects, but commit failed attempts under the same
      // identity lock so concurrent requests cannot bypass the limit.
      await db.query("ROLLBACK TO SAVEPOINT login_attempt");
      for (const key of keys) {
        await db.query(
          `INSERT INTO rate_limits(key,hits,until_at) VALUES($1,1,clock_timestamp()+interval '1 minute')
           ON CONFLICT(key) DO UPDATE SET
             hits=CASE WHEN rate_limits.until_at<=clock_timestamp() THEN 1 ELSE rate_limits.hits+1 END,
             until_at=CASE WHEN rate_limits.until_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE rate_limits.until_at END`,
          [key],
        );
      }
      return { error };
    }
  }
  async execute(op: Operation, input: any, c: Context) {
    await this.rate(c, op);
    try {
      const outcome = await transaction(async (db) => {
        // Serialize identity mutations, including authority checks and immediate revocation.
        if (api[op].method !== "get")
          await db.query(
            op.startsWith("backup") ||
              op.startsWith("integrity") ||
              op === "maintenanceSet" ||
              (op === "operationsControl" &&
                ["backup", "admin"].includes(input.family))
              ? "SELECT pg_advisory_xact_lock_shared(70210402)"
              : "SELECT pg_advisory_xact_lock(70210402)",
          );
        if (api[op].access !== "public") {
          const token = c.request.cookies?.palimora_session;
          if (!token) {
            c.response.clearCookie("palimora_impersonation", { path: "/" });
            fail("UNAUTHENTICATED", 401);
          }
          const r = await db.query(
            `SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.parent_session_id IS NULL AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled AND u.soft_deleted_at IS NULL`,
            [digest(token)],
          );
          c.session = r.rows[0];
          if (!c.session) {
            c.response.clearCookie("palimora_impersonation", { path: "/" });
            fail("UNAUTHENTICATED", 401);
          }
          c.user = (
            await db.query("SELECT * FROM users WHERE id=$1", [
              c.session.user_id,
            ])
          ).rows[0];
          const childToken = c.request.cookies?.palimora_impersonation;
          if (childToken) {
            const child = (
              await db.query(
                "SELECT * FROM sessions WHERE token_hash=$1 AND parent_session_id=$2",
                [digest(childToken), c.session.id],
              )
            ).rows[0];
            const target = child
              ? (
                  await db.query("SELECT * FROM users WHERE id=$1", [
                    child.user_id,
                  ])
                ).rows[0]
              : null;
            const valid =
              child &&
              !child.revoked_at &&
              new Date(child.expires_at).getTime() > Date.now() &&
              target?.role === "User" &&
              !target.disabled &&
              !target.soft_deleted_at &&
              c.user.role !== "User";
            if (valid || (op === "impersonationStop" && child)) {
              c.actor = c.user;
              c.parentSession = c.session;
              c.session = child;
              c.user = target;
            } else if (op === "me") {
              if (child) {
                await db.query(
                  "UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1",
                  [child.id],
                );
                await this.audit(db, c, "impersonation.expired", child.user_id);
              }
              c.response.clearCookie("palimora_impersonation", { path: "/" });
            } else fail("UNAUTHENTICATED", 401);
          }
          if (
            c.actor &&
            (op === "impersonationStart" ||
              /^(password|deleteAccount|totp|recovery|passkey)/.test(op) ||
              api[op].path.startsWith("/me/sessions"))
          )
            fail("IMPERSONATION_RESTRICTED", 403);
          if (
            api[op].method !== "get" &&
            c.request.headers["x-csrf-token"] !== c.session.csrf
          )
            fail("CSRF", 403);
          if (api[op].access === "owner" && c.user.role !== "Owner")
            fail("FORBIDDEN", 403);
          if (api[op].access === "admin" && c.user.role === "User")
            fail("FORBIDDEN", 403);
          await db.query(
            "UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at<now()-interval '5 minutes'",
            [c.session.id],
          );
        }
        const mode = (await db.query("SELECT maintenance_mode FROM instance"))
          .rows[0].maintenance_mode;
        if (
          mode === "maintenance_full" &&
          ![
            "status",
            "me",
            "login",
            "passkeyLoginStart",
            "passkeyLoginFinish",
            "logout",
            "impersonationStop",
          ].includes(op) &&
          (!c.user || c.user.role === "User")
        )
          fail("MAINTENANCE", 503);
        if (
          api[op].access === "public" &&
          c.request.cookies?.palimora_impersonation &&
          op !== "status"
        )
          fail("IMPERSONATION_RESTRICTED", 403);
        if (op === "login" || op === "passkeyLoginFinish")
          return this.loginAttempt(db, op, input, c);
        c.auditOp = op;
        c.auditInput = input;
        if (
          api[op].method !== "get" &&
          (c.actor || c.user?.role === "Owner" || c.user?.role === "Admin")
        )
          c.before = await auditState(db, op, input, c.user?.id);
        const result = await this.run(db, op, input, c);
        if (
          !c.audited &&
          (c.actor ||
            (api[op].method !== "get" && c.user?.role !== "User" && c.user))
        )
          await this.audit(
            db,
            c,
            op,
            input.id ?? input.requestId ?? input.issue,
            { action: input.action },
          );
        return { result: op === "readerDownload" ? result : serialize(result) };
      });
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    } catch (e) {
      if (api[op].method !== "get") {
        await transaction((db) =>
          this.audit(
            db,
            c,
            op,
            input.id ?? input.issue ?? input.requestId,
            {},
            "failure",
          ),
        ).catch(() => {});
      }
      throw e;
    }
  }
  private authResult(c: Context) {
    return {
      user: publicUser(c.user),
      csrf: c.session.csrf,
      session: {
        id: c.session.id,
        expires_at: new Date(c.session.expires_at).toISOString(),
      },
      impersonation: c.actor
        ? {
            actor_id: c.actor.id,
            actor_username: c.actor.username,
            expires_at: new Date(c.session.expires_at).toISOString(),
          }
        : null,
    };
  }
  private async newSession(db: DB, c: Context, user: any) {
    if (
      user.role === "User" &&
      (await db.query("SELECT maintenance_mode FROM instance")).rows[0]
        .maintenance_mode === "maintenance_full"
    )
      fail("MAINTENANCE", 503);
    const token = random(),
      csrf = random(),
      id = randomUUID();
    const createdSession = await db.query(
      "INSERT INTO sessions(id,user_id,token_hash,csrf,device,ip) VALUES($1,$2,$3,$4,$5,$6) RETURNING expires_at",
      [
        id,
        user.id,
        digest(token),
        csrf,
        (c.request.headers["user-agent"] ?? "Unknown").slice(0, 300),
        c.request.ip ?? "",
      ],
    );
    c.response.cookie("palimora_session", token, {
      httpOnly: true,
      secure: config().secure,
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 86400000,
    });
    c.user = user;
    c.session = { id, csrf, expires_at: createdSession.rows[0].expires_at };
    return {
      user: publicUser(user),
      csrf,
      session: { id, expires_at: c.session.expires_at.toISOString() },
    };
  }
  private async factor(db: DB, user: any, code?: string, allowReuse = false) {
    if (!user.totp_secret) return;
    if (!code) fail("SECOND_FACTOR_REQUIRED", 401);
    const r = await db.query(
      "DELETE FROM recovery_codes WHERE user_id=$1 AND code_hash=$2 RETURNING code_hash",
      [user.id, digest(code)],
    );
    if (r.rowCount) return;
    const otp = totp(unseal(user.totp_secret)),
      delta = otp.validate({ token: code, window: 1 });
    if (delta === null) fail("SECOND_FACTOR_INVALID", 401);
    const counter = Math.floor(Date.now() / 30000) + delta;
    if (!allowReuse && counter <= Number(user.totp_counter))
      fail("SECOND_FACTOR_INVALID", 401);
    await db.query(
      "UPDATE users SET totp_counter=GREATEST(totp_counter,$2) WHERE id=$1",
      [user.id, counter],
    );
  }
  private async proof(db: DB, c: Context, input: any) {
    if (!(await verifyPassword(c.user.password_hash, input.password)))
      fail("CREDENTIALS_INVALID", 401);
    await this.factor(db, c.user, input.code);
  }
  private async codes(db: DB, userId: string) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(10).toString("hex"),
    );
    await db.query("DELETE FROM recovery_codes WHERE user_id=$1", [userId]);
    for (const code of codes)
      await db.query("INSERT INTO recovery_codes VALUES($1,$2)", [
        userId,
        digest(code),
      ]);
    return { codes };
  }
  private async target(db: DB, c: Context, id: string) {
    const user = (await db.query("SELECT * FROM users WHERE id=$1", [id]))
      .rows[0];
    if (!user) fail("NOT_FOUND", 404);
    if (
      user.id === c.user.id ||
      user.role === "Owner" ||
      (c.user.role === "Admin" && user.role !== "User")
    )
      fail("FORBIDDEN", 403);
    return user;
  }
  private async revoke(db: DB, userId: string) {
    await db.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
    await db.query("DELETE FROM challenges WHERE user_id=$1", [userId]);
  }
  private async sessionList(db: DB, userId: string, current: string) {
    return (
      await db.query(
        `SELECT id,device,ip,created_at,last_seen_at,expires_at,(id=$2) AS current FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`,
        [userId, current],
      )
    ).rows;
  }
  private async challenge(db: DB, c: Context, kind: string, value: string) {
    const id = random();
    if (c.session)
      await db.query("DELETE FROM challenges WHERE session_id=$1 AND kind=$2", [
        c.session.id,
        kind,
      ]);
    await db.query(
      "INSERT INTO challenges(id,user_id,session_id,kind,value) VALUES($1,$2,$3,$4,$5)",
      [digest(id), c.user?.id ?? null, c.session?.id ?? null, kind, value],
    );
    if (kind === "authentication")
      c.response.cookie("palimora_challenge", id, {
        httpOnly: true,
        secure: config().secure,
        sameSite: "strict",
        path: "/api/v1/auth/passkey",
        maxAge: 300000,
      });
  }
  private async takeChallenge(db: DB, c: Context, kind: string) {
    const r =
      kind === "authentication"
        ? await db.query(
            "DELETE FROM challenges WHERE id=$1 AND kind=$2 AND expires_at>now() RETURNING *",
            [digest(c.request.cookies?.palimora_challenge ?? ""), kind],
          )
        : await db.query(
            "DELETE FROM challenges WHERE session_id=$1 AND kind=$2 AND expires_at>now() RETURNING *",
            [c.session.id, kind],
          );
    if (!r.rowCount) fail("CHALLENGE_EXPIRED", 400);
    return r.rows[0];
  }
  private async run(
    db: DB,
    op: Operation,
    x: any,
    c: Context,
  ): Promise<unknown> {
    switch (op) {
      case "maintenanceSet":
      case "integrityStatus":
      case "integrityIssues":
      case "integrityStart":
      case "integrityControl":
      case "integritySchedule":
      case "integrityRepair":
      case "auditList": {
        const r = await maintenanceOperation(db, op, x, c.user);
        if (op === "auditList") await this.audit(db, c, op, x.target);
        return r;
      }
      case "impersonationStart": {
        if (c.actor) fail("FORBIDDEN", 403);
        const target = (
          await db.query(
            "SELECT * FROM users WHERE id=$1 AND role='User' AND NOT disabled AND soft_deleted_at IS NULL",
            [x.id],
          )
        ).rows[0];
        if (!target) fail("FORBIDDEN", 403);
        const token = random(),
          csrf = random(),
          id = randomUUID();
        await db.query(
          "UPDATE sessions SET revoked_at=now() WHERE parent_session_id=$1 AND revoked_at IS NULL",
          [c.session.id],
        );
        const child = (
          await db.query(
            "INSERT INTO sessions(id,user_id,token_hash,csrf,device,ip,parent_session_id,actor_admin_id,expires_at) VALUES($1,$2,$3,$4,'Impersonation',$5,$6,$7,least($8::timestamptz,now()+interval '15 minutes')) RETURNING *",
            [
              id,
              target.id,
              digest(token),
              csrf,
              c.request.ip ?? "",
              c.session.id,
              c.user.id,
              c.session.expires_at,
            ],
          )
        ).rows[0];
        c.actor = c.user;
        c.parentSession = c.session;
        c.user = target;
        c.session = child;
        c.response.cookie("palimora_impersonation", token, {
          httpOnly: true,
          secure: config().secure,
          sameSite: "strict",
          path: "/",
          maxAge: 900000,
        });
        await this.audit(db, c, "impersonation.start", target.id, {
          before: { impersonating: false },
          after: { impersonating: true },
        });
        return this.authResult(c);
      }
      case "impersonationStop": {
        if (c.parentSession) {
          await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
            c.session.id,
          ]);
          await this.audit(db, c, "impersonation.stop", c.user.id);
          c.user = c.actor;
          c.session = c.parentSession;
          c.actor = undefined;
          c.parentSession = undefined;
        }
        c.response.clearCookie("palimora_impersonation", { path: "/" });
        return this.authResult(c);
      }

      case "operationsOverview":
      case "operationsMetrics":
      case "operationsJobs":
      case "operationsHistory":
      case "operationsLayout":
      case "operationsControl": {
        const result = await operationsOperation(db, op, x, c.user);
        if (api[op].method !== "get")
          await this.audit(db, c, op, x.id ?? c.user.id, {
            family: x.family,
            action: x.action,
            sections: x.sections,
          });
        return result;
      }

      case "backupStatus":
      case "backupCreate":
      case "backupDetail":
      case "backupControl":
      case "backupDestination":
      case "backupSchedule":
      case "backupRestorePreview":
      case "backupRestore":
      case "backupFile": {
        const result = await backupOperation(db, op, x, c.user);
        if (
          api[op].method !== "get" ||
          op === "backupFile" ||
          op === "backupRestorePreview"
        )
          await this.audit(db, c, op, x.id ?? x.requestId, {
            action: x.action,
            target: x.target,
          });
        return result;
      }

      case "ao3UploadStart":
      case "ao3UploadChunk":
      case "ao3UploadFinish":
      case "ao3Media":
      case "ao3Jobs":
      case "ao3Manual":
      case "ao3JobControl":
      case "ao3Account":
      case "ao3Priorities": {
        const result = await syncAdmin(db, op, x);
        if (op !== "ao3Jobs" && op !== "ao3Media" && op !== "ao3UploadChunk")
          await this.audit(db, c, op, x.id, {
            kind: x.kind,
            action: x.action,
            remove: x.remove,
          });
        return result;
      }

      case "ao3Status":
      case "ao3Control": {
        const result = await ao3MonitorOperation(db, op, x);
        if (op === "ao3Control") await this.audit(db, c, op, undefined, x);
        return result;
      }
      case "readerOpen": {
        if (
          !(
            await db.query("SELECT 1 FROM archive_work_heads WHERE id=$1", [
              x.id,
            ])
          ).rowCount
        )
          fail("NOT_FOUND", 404);
        await recordAO3Open(db, x.id);
        await recordReading(db, c.user.id, x.id);
        return { ok: true };
      }

      case "socialPreferences":
      case "socialPreferencesSave":
      case "personalStatistics":
      case "personalActivity":
      case "readingHeartbeat":
      case "recommendWork":
      case "recommendationRecipients":
      case "subscriptionStatus":
      case "subscriptionSave":
      case "subscriptions":
      case "notifications":
      case "notificationsReadAll":
      case "notificationRead":
      case "pushDevices":
      case "pushRegister":
      case "pushRevoke":
        return socialOperation(db, op, x, c.user.id, c.session.id);
      case "readingProgress":
      case "readingSave":
      case "annotationList":
      case "annotationSave":
        return readingOperation(db, op, x, c.user.id);
      case "collectionList":
      case "collectionCreate":
      case "collectionDetail":
      case "collectionUpdate":
      case "collectionCandidates":
      case "collectionMember":
      case "collectionRespond":
      case "collectionWork": {
        const result = await collectionOperation(db, op, x, c.user.id);
        if (api[op].method !== "get") await this.audit(db, c, op, x.id);
        return result;
      }
      case "libraryList":
      case "libraryWork":
      case "librarySave":
      case "bookmarkSave":
      case "libraryLater":
      case "libraryForget":
        return libraryOperation(db, op, x, c.user.id);
      case "readerDownload":
        return downloadWork(db, x);
      case "readerInteractions":
      case "bibliographyPage":
      case "catalogWorks":
      case "catalogBrowse":
      case "readerWork":
      case "readerMedia":
      case "readerContent":
        return catalogOperation(db, op, x);
      case "archiveDownload":
      case "archiveInventory":
      case "ingestReport":
      case "archiveConflicts":
      case "archiveResolve":
      case "archiveMaintenance":
      case "archiveDevReset":
      case "archiveStorage":
      case "ingestBatches":
      case "ingestCreate":
      case "ingestDetail":
      case "ingestControl":
      case "archiveWorks":
      case "archiveWork":
      case "archiveSnapshot":
      case "archiveObject": {
        const result = await archiveOperation(db, op, x);
        if (op === "archiveStorage")
          result.dev_reset_available &&= c.user.role === "Owner";
        if (api[op].method !== "get")
          await this.audit(db, c, op, x.id ?? x.requestId, {
            requestId: x.requestId,
            kind: x.kind,
            target: x.target,
            reason: x.reason,
            action: x.action,
          });
        return result;
      }
      case "status": {
        const r = (
          await db.query("SELECT state,name,maintenance_mode FROM instance")
        ).rows[0];
        return r;
      }
      case "setup": {
        const instance = (
          await db.query("SELECT * FROM instance WHERE id=true FOR UPDATE")
        ).rows[0];
        if (instance.state !== "uninitialized") fail("SETUP_CLOSED", 409);
        await db.query(
          "UPDATE instance SET state='initializing' WHERE id=true",
        );
        const user = (
          await db.query(
            `INSERT INTO users(id,username,email,password_hash,role,preferences) VALUES($1,$2,$3,$4,'Owner',$5) RETURNING *`,
            [
              randomUUID(),
              x.username,
              x.email || null,
              await hashPassword(x.password),
              x.preferences,
            ],
          )
        ).rows[0];
        await db.query(
          "UPDATE instance SET state='active',name=$1,initialized_at=now() WHERE id=true",
          [x.name],
        );
        const result = await this.newSession(db, c, user);
        await this.audit(db, c, "setup", user.id);
        return result;
      }
      case "inviteInfo":
      case "register": {
        const invite = (
          await db.query(
            "SELECT * FROM invites WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND uses<max_uses FOR UPDATE",
            [digest(x.token)],
          )
        ).rows[0];
        if (!invite) fail("INVITE_INVALID", 400);
        if (op === "inviteInfo") return { email: invite.email };
        if (
          invite.email &&
          invite.email.toLowerCase() !== (x.email ?? "").toLowerCase()
        )
          fail("INVITE_INVALID", 400);
        const user = (
          await db.query(
            `INSERT INTO users(id,username,email,password_hash,role,preferences) VALUES($1,$2,$3,$4,'User',$5) RETURNING *`,
            [
              randomUUID(),
              x.username,
              x.email || null,
              await hashPassword(x.password),
              x.preferences,
            ],
          )
        ).rows[0];
        await db.query("UPDATE invites SET uses=uses+1 WHERE id=$1", [
          invite.id,
        ]);
        const result = await this.newSession(db, c, user);
        await this.audit(db, c, "register", user.id, { inviteId: invite.id });
        return result;
      }
      case "login": {
        const user = (
          await db.query(
            "SELECT * FROM users WHERE lower(username)=lower($1)",
            [x.username],
          )
        ).rows[0];
        const valid = await verifyPassword(
          user?.password_hash ?? this.dummy,
          x.password,
        );
        if (!user || user.disabled || user.soft_deleted_at)
          fail("CREDENTIALS_INVALID", 401);
        let recovered = false;
        if (!valid && user.totp_secret) {
          const recovery = await db.query(
            "DELETE FROM recovery_codes WHERE user_id=$1 AND code_hash=$2 RETURNING code_hash",
            [user.id, digest(x.password)],
          );
          recovered = !!recovery.rowCount;
        }
        if (!valid && !recovered) fail("CREDENTIALS_INVALID", 401);
        if (!recovered) await this.factor(db, user, x.code, true);
        const result = await this.newSession(db, c, user);
        await this.audit(db, c, "login", user.id, {
          method: recovered ? "recovery" : "password",
        });
        return result;
      }
      case "me":
        return this.authResult(c);
      case "logout":
        if (c.parentSession)
          await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
            c.parentSession.id,
          ]);
        c.response.clearCookie("palimora_impersonation", { path: "/" });
        await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
          c.session.id,
        ]);
        c.response.clearCookie("palimora_session", { path: "/" });
        break;
      case "deleteAccount":
        await this.proof(db, c, x);
        if (c.user.role === "Owner") fail("FORBIDDEN", 403);
        await db.query("UPDATE users SET soft_deleted_at=now() WHERE id=$1", [
          c.user.id,
        ]);
        await this.revoke(db, c.user.id);
        c.response.clearCookie("palimora_session", { path: "/" });
        break;
      case "profile": {
        const r = await db.query(
          `UPDATE users SET email=$2,preferences=$3 WHERE id=$1 RETURNING *`,
          [c.user.id, x.email || null, x.preferences],
        );
        return publicUser(r.rows[0]);
      }
      case "password":
        await this.proof(db, c, x);
        await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
          c.user.id,
          await hashPassword(x.newPassword),
        ]);
        await this.revoke(db, c.user.id);
        c.response.clearCookie("palimora_session", { path: "/" });
        break;
      case "sessions":
        return this.sessionList(db, c.user.id, c.session.id);
      case "revokeSession":
        await db.query(
          "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2",
          [x.id, c.user.id],
        );
        break;
      case "revokeOthers":
        await db.query(
          "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",
          [c.user.id, c.session.id],
        );
        break;
      case "totpStart": {
        await this.proof(db, c, x);
        if (c.user.totp_secret) fail("CONFLICT", 409);
        const secret = new (require("otpauth").Secret)({ size: 20 }).base32;
        const configured = totp(secret, c.user.username);
        await db.query(
          "DELETE FROM challenges WHERE session_id=$1 AND kind='totp-ready'",
          [c.session.id],
        );
        await this.challenge(db, c, "totp", seal(secret));
        return { secret, uri: configured.toString() };
      }
      case "totpVerify": {
        if (c.user.totp_secret) fail("CONFLICT", 409);
        const ch = await this.takeChallenge(db, c, "totp");
        const secret = unseal(ch.value),
          delta = totp(secret).validate({ token: x.code, window: 1 });
        if (delta === null) fail("SECOND_FACTOR_INVALID", 400);
        const codes = Array.from({ length: 10 }, () =>
          randomBytes(10).toString("hex"),
        );
        await this.challenge(
          db,
          c,
          "totp-ready",
          JSON.stringify({
            secret: ch.value,
            counter: Math.floor(Date.now() / 30000) + delta,
            hashes: codes.map((code) => digest(code)),
          }),
        );
        return { codes };
      }
      case "totpEnable": {
        if (c.user.totp_secret) fail("CONFLICT", 409);
        const pending = JSON.parse(
          (await this.takeChallenge(db, c, "totp-ready")).value,
        );
        await db.query(
          "UPDATE users SET totp_secret=$2,totp_counter=$3 WHERE id=$1",
          [c.user.id, pending.secret, pending.counter],
        );
        await db.query("DELETE FROM recovery_codes WHERE user_id=$1", [
          c.user.id,
        ]);
        for (const hash of pending.hashes)
          await db.query("INSERT INTO recovery_codes VALUES($1,$2)", [
            c.user.id,
            hash,
          ]);
        await db.query(
          "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2",
          [c.user.id, c.session.id],
        );
        break;
      }
      case "totpDisable":
        await this.proof(db, c, x);
        await db.query(
          "UPDATE users SET totp_secret=NULL,totp_counter=-1 WHERE id=$1",
          [c.user.id],
        );
        await db.query("DELETE FROM recovery_codes WHERE user_id=$1", [
          c.user.id,
        ]);
        break;
      case "recovery":
        await this.proof(db, c, x);
        if (!c.user.totp_secret) fail("CONFLICT", 409);
        {
          const result = await this.codes(db, c.user.id);
          await this.audit(db, c, op, c.user.id);
          return result;
        }
      case "passkeys":
        return (
          await db.query(
            "SELECT id,name,created_at FROM passkeys WHERE user_id=$1 ORDER BY created_at",
            [c.user.id],
          )
        ).rows;
      case "passkeyStart": {
        await this.proof(db, c, x);
        const keys = (
          await db.query("SELECT id FROM passkeys WHERE user_id=$1", [
            c.user.id,
          ])
        ).rows;
        const options = await generateRegistrationOptions({
          rpName: "Palimora",
          rpID: config().rpID,
          userID: new TextEncoder().encode(c.user.id),
          userName: c.user.username,
          attestationType: "none",
          excludeCredentials: keys,
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
        });
        await this.challenge(db, c, "registration", options.challenge);
        return options;
      }
      case "passkeyFinish": {
        const ch = await this.takeChallenge(db, c, "registration");
        let verification;
        try {
          verification = await verifyRegistrationResponse({
            response: x.response as RegistrationResponseJSON,
            expectedChallenge: ch.value,
            expectedOrigin: config().origin,
            expectedRPID: config().rpID,
            requireUserVerification: true,
          });
        } catch {
          fail("PASSKEY_INVALID", 400);
        }
        if (!verification.verified || !verification.registrationInfo)
          fail("PASSKEY_INVALID", 400);
        const key = verification.registrationInfo.credential;
        await db.query(
          "INSERT INTO passkeys(id,user_id,public_key,counter,transports,name) VALUES($1,$2,$3,$4,$5,$6)",
          [
            key.id,
            c.user.id,
            Buffer.from(key.publicKey),
            key.counter,
            JSON.stringify(key.transports ?? []),
            x.name,
          ],
        );
        break;
      }
      case "passkeyDelete":
        await this.proof(db, c, x);
        await db.query("DELETE FROM passkeys WHERE id=$1 AND user_id=$2", [
          x.id,
          c.user.id,
        ]);
        break;
      case "passkeyLoginStart": {
        const options = await generateAuthenticationOptions({
          rpID: config().rpID,
          userVerification: "required",
        });
        await this.challenge(db, c, "authentication", options.challenge);
        return options;
      }
      case "passkeyLoginFinish": {
        const ch = await this.takeChallenge(db, c, "authentication");
        const key = (
          await db.query("SELECT * FROM passkeys WHERE id=$1", [
            x.response.id ?? "",
          ])
        ).rows[0];
        if (!key) fail("PASSKEY_INVALID", 401);
        const user = (
          await db.query(
            "SELECT * FROM users WHERE id=$1 AND NOT disabled AND soft_deleted_at IS NULL",
            [key.user_id],
          )
        ).rows[0];
        if (!user) fail("PASSKEY_INVALID", 401);
        let verification;
        try {
          verification = await verifyAuthenticationResponse({
            response: x.response as AuthenticationResponseJSON,
            expectedChallenge: ch.value,
            expectedOrigin: config().origin,
            expectedRPID: config().rpID,
            requireUserVerification: true,
            credential: {
              id: key.id,
              publicKey: key.public_key,
              counter: Number(key.counter),
              transports: key.transports,
            },
          });
        } catch {
          fail("PASSKEY_INVALID", 401);
        }
        if (!verification.verified) fail("PASSKEY_INVALID", 401);
        await db.query("UPDATE passkeys SET counter=$2 WHERE id=$1", [
          key.id,
          verification.authenticationInfo.newCounter,
        ]);
        const result = await this.newSession(db, c, user);
        await this.audit(db, c, op, user.id);
        return result;
      }
      case "users": {
        const rows = (
          await db.query(
            `SELECT ${userColumns} FROM users WHERE ($1='' OR username ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%') AND ($2='' OR id::text>$2) ORDER BY id LIMIT 51`,
            [x.q ?? "", x.cursor ?? ""],
          )
        ).rows;
        return {
          items: rows.slice(0, 50),
          next: rows.length > 50 ? rows[49].id : null,
        };
      }
      case "userDetail":
      case "userStatistics": {
        const target = (
          await db.query(`SELECT ${userColumns} FROM users WHERE id=$1`, [x.id])
        ).rows[0];
        if (!target) fail("NOT_FOUND", 404);
        const result =
          op === "userStatistics" ? await statistics(db, target.id) : target;
        await this.audit(db, c, op, target.id);
        return result;
      }
      case "userUpdate": {
        const user = await this.target(db, c, x.id);
        if (x.role && c.user.role !== "Owner") fail("FORBIDDEN", 403);
        const result = (
          await db.query(
            "UPDATE users SET disabled=$2,soft_deleted_at=$3,role=$4 WHERE id=$1 RETURNING *",
            [
              user.id,
              x.disabled ?? user.disabled,
              x.deleted === undefined
                ? user.soft_deleted_at
                : x.deleted
                  ? new Date()
                  : null,
              x.role ?? user.role,
            ],
          )
        ).rows[0];
        await this.revoke(db, user.id);
        await this.audit(db, c, op, user.id, {
          before: {
            role: user.role,
            disabled: user.disabled,
            deleted: !!user.soft_deleted_at,
          },
          after: {
            role: result.role,
            disabled: result.disabled,
            deleted: !!result.soft_deleted_at,
          },
        });
        return publicUser(result);
      }
      case "userSessions":
        await this.target(db, c, x.id);
        await this.audit(db, c, op, x.id);
        return this.sessionList(db, x.id, c.session.id);
      case "userRevoke":
        await this.target(db, c, x.id);
        await this.revoke(db, x.id);
        break;
      case "userReset":
        await this.proof(db, c, x);
        await this.target(db, c, x.id);
        await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
          x.id,
          await hashPassword(x.newPassword),
        ]);
        if (x.resetFactors) {
          await db.query(
            "UPDATE users SET totp_secret=NULL,totp_counter=-1 WHERE id=$1",
            [x.id],
          );
          await db.query("DELETE FROM recovery_codes WHERE user_id=$1", [x.id]);
          await db.query("DELETE FROM passkeys WHERE user_id=$1", [x.id]);
        }
        await this.revoke(db, x.id);
        break;
      case "invites": {
        const rows = (
          await db.query(
            "SELECT id,email,expires_at,max_uses,uses,revoked_at,created_at FROM invites WHERE ($1='' OR id::text>$1) ORDER BY id LIMIT 51",
            [x.cursor ?? ""],
          )
        ).rows;
        return {
          items: rows.slice(0, 50),
          next: rows.length > 50 ? rows[49].id : null,
        };
      }
      case "inviteCreate": {
        const previous = (
          await db.query("SELECT * FROM invites WHERE request_id=$1", [
            x.requestId,
          ])
        ).rows[0];
        if (previous) return { invite: previous, token: null };
        const token = random();
        const invite = (
          await db.query(
            "INSERT INTO invites(id,token_hash,email,expires_at,max_uses,created_by,request_id) VALUES($1,$2,$3,now()+($4 * interval '1 day'),$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              digest(token),
              x.email || null,
              x.days,
              x.maxUses,
              c.user.id,
              x.requestId,
            ],
          )
        ).rows[0];
        await this.audit(db, c, op, invite.id);
        return { invite, token };
      }
      case "inviteRevoke":
        await db.query(
          "UPDATE invites SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",
          [x.id],
        );
        break;
      default: {
        const never: never = op;
        throw Error(never);
      }
    }
    await this.audit(db, c, op, x.id ?? c.user?.id);
    return { ok: true };
  }
}
