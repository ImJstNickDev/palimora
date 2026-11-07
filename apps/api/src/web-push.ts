import * as webpush from "web-push";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { DB, transaction } from "./db";
import { seal, unseal, config, fail } from "./security";
import { publicAddress } from "./ao3-media";
import { retryAfter } from "./ao3-availability";
export function checkPushURL(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    fail("INVALID_INPUT", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    ((/^[0-9.]+$/.test(host) || host.includes(":")) && !publicAddress(host))
  )
    fail("INVALID_INPUT", 400);
  return url;
}
export async function validatePushEndpoint(endpoint: string) {
  const url = checkPushURL(endpoint);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
    verbatim: true,
  });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    fail("INVALID_INPUT", 400);
  return addresses[0];
}
export async function pushKeys(db: DB) {
  const row = (
    await db.query(
      "SELECT public_key,private_key FROM personal_runtime FOR UPDATE",
    )
  ).rows[0];
  if (row.public_key)
    return { publicKey: row.public_key, privateKey: unseal(row.private_key) };
  const keys = webpush.generateVAPIDKeys();
  await db.query("UPDATE personal_runtime SET public_key=$1,private_key=$2", [
    keys.publicKey,
    seal(keys.privateKey),
  ]);
  return keys;
}
export async function sendPush(
  subscription: webpush.PushSubscription,
  keys: { publicKey: string; privateKey: string },
  payload: string,
) {
  const pinned = await validatePushEndpoint(subscription.endpoint);
  const details = webpush.generateRequestDetails(subscription, payload, {
    vapidDetails: {
      ...keys,
      subject: process.env.VAPID_SUBJECT || config().origin,
    },
    TTL: 3600,
    topic: "palimora-notifications",
  });
  return new Promise<{ status: number; retry: string | undefined }>(
    (resolve, reject) => {
      const req = request(
        details.endpoint,
        {
          method: details.method,
          headers: details.headers,
          family: pinned.family,
          lookup: ((_h: any, _o: any, cb: any) =>
            cb(null, pinned.address, pinned.family)) as any,
        },
        (res) => {
          res.resume();
          resolve({
            status: res.statusCode ?? 500,
            retry:
              typeof res.headers["retry-after"] === "string"
                ? res.headers["retry-after"]
                : undefined,
          });
        },
      );
      const timer = setTimeout(() => req.destroy(Error("PUSH_TIMEOUT")), 10000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(details.body);
    },
  );
}
export async function deliverPush(send = sendPush) {
  await transaction(async (db) => {
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(70210432) AS locked"))
        .rows[0].locked
    )
      return;
    const job = (
      await db.query(
        `SELECT j.*,n.user_id,n.kind,n.read_at,d.subscription,d.session_id FROM push_deliveries j JOIN personal_notifications n ON n.id=j.notification_id JOIN push_devices d ON d.id=j.device_id WHERE NOT j.failed AND j.sent_generation<j.generation AND j.next_at<=clock_timestamp() ORDER BY j.next_at LIMIT 1 FOR UPDATE OF j,d`,
      )
    ).rows[0];
    if (!job) return;
    const session = (
      await db.query(
        `SELECT s.id,u.preferences FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled AND u.soft_deleted_at IS NULL FOR SHARE OF s,u`,
        [job.session_id, job.user_id],
      )
    ).rows[0];
    const prefs = (
      await db.query(
        "SELECT * FROM personal_settings WHERE user_id=$1 FOR SHARE",
        [job.user_id],
      )
    ).rows[0];
    if (!session) {
      await db.query("DELETE FROM push_devices WHERE id=$1", [job.device_id]);
      return;
    }
    if (
      !prefs?.push ||
      job.read_at ||
      (job.kind === "update" && !prefs.updates) ||
      (job.kind === "recommendation" && !prefs.recommendations)
    ) {
      await db.query(
        "UPDATE push_deliveries SET sent_generation=generation WHERE notification_id=$1 AND device_id=$2",
        [job.notification_id, job.device_id],
      );
      return;
    }
    let result: { status: number; retry?: string };
    try {
      result = await send(
        JSON.parse(unseal(job.subscription)),
        await pushKeys(db),
        JSON.stringify({
          language: session.preferences.language === "en" ? "en" : "it",
        }),
      );
    } catch {
      result = { status: 0 };
    }
    if ([404, 410].includes(result.status)) {
      await db.query("DELETE FROM push_devices WHERE id=$1", [job.device_id]);
      return;
    }
    if (result.status >= 200 && result.status < 300) {
      await db.query(
        "UPDATE push_deliveries SET sent_generation=generation,attempts=0 WHERE notification_id=$1 AND device_id=$2",
        [job.notification_id, job.device_id],
      );
      await db.query("UPDATE push_devices SET last_error=NULL WHERE id=$1", [
        job.device_id,
      ]);
      return;
    }
    const delay = Math.max(
      retryAfter(result.retry ?? null) ?? 0,
      Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
    );
    await db.query(
      "UPDATE push_deliveries SET attempts=attempts+1,next_at=clock_timestamp()+($3||' milliseconds')::interval,failed=$4 WHERE notification_id=$1 AND device_id=$2",
      [job.notification_id, job.device_id, String(delay), job.attempts >= 99],
    );
    await db.query("UPDATE push_devices SET last_error=$2 WHERE id=$1", [
      job.device_id,
      job.attempts >= 99 ? "delivery_failed" : "retry_pending",
    ]);
  });
}
