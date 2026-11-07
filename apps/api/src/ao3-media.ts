import { cssMediaURLs } from "./ao3-media-urls";
import { Readable } from "node:stream";
import { retryAfter } from "./ao3-availability";
import { localizeMedia } from "./ao3-localize";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { archiveTransaction, preserve, readObject, store } from "./archive";
import { canonical, sha } from "./pack";
import { SyncError } from "./ao3-client";
import { pool, transaction } from "./db";
import { enqueueSync } from "./ao3-scheduler";
const ipaddr: any = require("ipaddr.js");
export function publicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && ip.isIPv4MappedAddress())
      ip = ip.toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
async function responseFor(value: string) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new SyncError("MEDIA_URL_BLOCKED", 86400000);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "archiveofourown.org" || host.endsWith(".archiveofourown.org"))
    throw new SyncError("MEDIA_AO3_BUDGET_REQUIRED", 86400000);
  const budget = (
    await pool.query(
      `INSERT INTO ao3_media_hosts(host) VALUES($1) ON CONFLICT(host) DO UPDATE SET host=excluded.host RETURNING next_request_at`,
      [host],
    )
  ).rows[0];
  if (budget.next_request_at.getTime() > Date.now())
    throw new SyncError(
      "MEDIA_HOST_COOLDOWN",
      budget.next_request_at.getTime() - Date.now(),
    );
  await pool.query(
    "UPDATE ao3_media_hosts SET next_request_at=now()+interval '10 seconds' WHERE host=$1",
    [host],
  );
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new SyncError("MEDIA_ADDRESS_BLOCKED", 86400000);
  const pinned = records[0];
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        family: pinned.family,
        lookup: ((_h: any, _o: any, cb: any) =>
          cb(null, pinned.address, pinned.family)) as any,
        headers: {
          "User-Agent": "Palimora/1.0 (media preservation)",
          "Accept-Encoding": "identity",
        },
        timeout: 25000,
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error("MEDIA_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
export async function acquireMedia(url: string, stopped: () => boolean) {
  let target = url,
    res: import("node:http").IncomingMessage | undefined;
  for (let hop = 0; hop < 6; hop++) {
    try {
      res = await responseFor(target);
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError("MEDIA_NETWORK", 3600000);
    }
    const retry = retryAfter(
      typeof res.headers["retry-after"] === "string"
        ? res.headers["retry-after"]
        : null,
    );
    if (res.statusCode === 429 || res.statusCode === 503 || retry !== null) {
      const delay = Math.max(retry ?? 0, 300000);
      res.destroy();
      await pool.query(
        "UPDATE ao3_media_hosts SET next_request_at=greatest(next_request_at,now()+$2*interval '1 millisecond') WHERE host=$1",
        [new URL(target).hostname, delay],
      );
      throw new SyncError("MEDIA_RATE_LIMIT", delay);
    }
    if (
      [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
      res.headers.location
    ) {
      res.destroy();
      target = new URL(res.headers.location, target).href;
      continue;
    }
    break;
  }
  if (!res) throw new SyncError("MEDIA_RESPONSE");
  if (res.statusCode !== 200) {
    const status = res.statusCode;
    res.destroy();
    throw new SyncError(
      status === 404 || status === 410 ? "MEDIA_UNRECOVERABLE" : "MEDIA_HTTP",
      status === 404 || status === 410 ? 30 * 86400000 : 3600000,
    );
  }
  const mime = String(
    res.headers["content-type"] ?? "application/octet-stream",
  ).split(";")[0];
  // A link to an HTML page is not a downloadable media attachment.
  if (mime === "text/html") {
    res.destroy();
    throw new SyncError("MEDIA_NOT_ATTACHMENT", 30 * 86400000);
  }
  return preserveMediaStream(
    url,
    res,
    mime,
    stopped,
    res.headers["content-length"]
      ? Number(res.headers["content-length"])
      : undefined,
  );
}
export async function preserveMediaStream(
  url: string,
  res: Readable,
  mime: string,
  stopped: () => boolean,
  declared?: number,
) {
  const hash = createHash("sha256"),
    chunks: { hash: string; size: number }[] = [];
  let size = 0,
    buffer = Buffer.alloc(0);
  const save = async (bytes: Buffer) => {
    const disk = await statfs(store.root);
    if (
      disk.bavail * disk.bsize <
      bytes.length * 2 + Number(process.env.ARCHIVE_RESERVE_BYTES ?? 268435456)
    )
      throw new SyncError("MEDIA_STORAGE_RESERVE", 3600000);
    await archiveTransaction(
      (db) => preserve(db, [{ kind: "asset", bytes }]),
      ["media:" + url],
    );
    chunks.push({ hash: sha(bytes), size: bytes.length });
  };
  try {
    for await (const part of res) {
      if (stopped()) throw new SyncError("STOPPED", 60000);
      const b = Buffer.from(part);
      hash.update(b);
      size += b.length;
      buffer = Buffer.concat([buffer, b]);
      while (buffer.length >= 8 * 1024 * 1024) {
        await save(buffer.subarray(0, 8 * 1024 * 1024));
        buffer = buffer.subarray(8 * 1024 * 1024);
      }
    }
    if (buffer.length || !chunks.length) await save(buffer);
  } finally {
    res.destroy();
  }
  if (declared !== undefined && declared !== size)
    throw new SyncError("MEDIA_TRUNCATED");
  let objectHash = chunks[0].hash,
    kind = "asset";
  await archiveTransaction(
    async (db) => {
      if (chunks.length > 1) {
        const bytes = canonical({
          schema: "palimora-chunks-v1",
          size,
          sha256: hash.digest("hex"),
          chunks,
        });
        objectHash = sha(bytes);
        kind = "chunk_manifest";
        await preserve(db, [{ kind, bytes }]);
      }
      const previous = (
        await db.query(
          "SELECT object_hash FROM ao3_media WHERE url=$1 FOR UPDATE",
          [url],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO ao3_media(url,object_hash,object_kind,mime,checked_at) VALUES($1,$2,$3,$4,now())
      ON CONFLICT(url) DO UPDATE SET object_hash=$2,object_kind=$3,mime=$4,checked_at=now(),failures=0`,
        [url, objectHash, kind, mime],
      );
      if (previous?.object_hash !== objectHash) {
        await db.query(
          "INSERT INTO ao3_media_revisions(url,hash,kind,mime) VALUES($1,$2,$3,$4)",
          [url, objectHash, kind, mime],
        );
        await db.query(
          "INSERT INTO archive_outbox(event,payload) VALUES('media.revision.acquired',$1)",
          [{ url, hash: objectHash }],
        );
      }
    },
    ["media:" + url],
  );
  if (mime === "text/css") {
    if (size > 64 * 1024 * 1024)
      throw new SyncError("MEDIA_CSS_PARSE_BUDGET", 86400000);
    const text = await transaction(async (db) => {
      const parts: Buffer[] = [];
      for (const chunk of chunks) parts.push(await readObject(db, chunk.hash));
      return Buffer.concat(parts).toString();
    });
    await transaction(async (db) => {
      for (const dependency of cssMediaURLs(text, url)) {
        if (dependency === url) continue;
        await db.query(
          "INSERT INTO archive_media_references(work_id,url) SELECT work_id,$2 FROM archive_media_references WHERE url=$1 ON CONFLICT DO NOTHING",
          [url, dependency],
        );
        await db.query(
          "INSERT INTO ao3_jobs(kind,target,priority) VALUES('media',$1,50) ON CONFLICT DO NOTHING",
          [dependency],
        );
      }
    });
  }
  await localizeMedia(url);
  return { hash: objectHash, size, kind };
}
export async function attachAvailableMedia(record: any) {
  const rows = (
    await pool.query(
      `SELECT * FROM ao3_media WHERE (url=ANY($1::text[]) OR url IN (
        SELECT r.url FROM archive_media_references r JOIN archive_work_heads h ON h.id=r.work_id WHERE h.external_id=$2
      )) AND object_hash IS NOT NULL`,
      [record.media_urls ?? [], record.external_id],
    )
  ).rows;
  record.metadata.ao3.media = rows.map((r: any) => ({
    url: r.url,
    object: r.url,
  }));
  for (const r of rows)
    record.objects.push({
      name: r.url,
      kind: r.object_kind,
      hash: r.object_hash,
      cached: true,
    });
}

export async function acquireUploadedMedia(id: string, stopped: () => boolean) {
  const upload = (
    await pool.query(
      "SELECT * FROM ao3_uploads WHERE id=$1 AND state IN ('queued','completed')",
      [id],
    )
  ).rows[0];
  if (!upload) throw new SyncError("MEDIA_UPLOAD_MISSING");
  if (upload.state === "completed")
    return {
      hash: (
        await pool.query("SELECT object_hash FROM ao3_media WHERE url=$1", [
          upload.url,
        ])
      ).rows[0]?.object_hash,
      size: Number(upload.size),
    };
  const source = Readable.from(
    (async function* () {
      let offset = 0;
      while (offset < Number(upload.size)) {
        const part = (
          await pool.query(
            "SELECT data FROM ao3_upload_chunks WHERE upload_id=$1 AND byte_offset=$2",
            [id, offset],
          )
        ).rows[0];
        if (!part) throw new SyncError("MEDIA_UPLOAD_GAP");
        offset += part.data.length;
        yield part.data;
      }
    })(),
  );
  const result = await preserveMediaStream(
    upload.url,
    source,
    upload.mime,
    stopped,
    Number(upload.size),
  );
  await pool.query("UPDATE ao3_uploads SET state='completed' WHERE id=$1", [
    id,
  ]);
  await pool.query("DELETE FROM ao3_upload_chunks WHERE upload_id=$1", [id]);
  return result;
}
