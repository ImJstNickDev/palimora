import { createHash, randomUUID } from "node:crypto";
import { opendir, open, mkdir, rm, rename, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pool, transaction, DB } from "./db";
import { PackStore, Locator, scanPackRecords, sha } from "./pack";
import { jobAudit } from "./admin-audit";
import { readPayloads, objectProjection, objectFrom } from "./archive-catalog";
import { processingPolicy } from "./maintenance";
import { destination } from "./backup-config";
import { openBackupTarget } from "./backup-target";
import { exportChain } from "./backup-worker";
import {
  openChain,
  readObject,
  verify,
  fileDigest,
  ArchiveChain,
} from "@palimora/archive-format";
const store = new PackStore();
const locator = (r: any): Locator => ({
  ...r,
  offset: Number(r.byte_offset),
  size: Number(r.size),
  length: Number(r.length),
});
async function issue(
  db: Pick<DB, "query">,
  job: string,
  identity: string,
  code: string,
  hash: string | null = null,
  pack: string | null = null,
  detail: object = {},
) {
  await db.query(
    "INSERT INTO integrity_issues(job_id,identity,code,object_hash,pack,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,identity,code) DO NOTHING",
    [job, identity, code, hash, pack, detail],
  );
}
function errorCode(e: any) {
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message)
    ? e.message
    : ((
        {
          ENOENT: "PACK_MISSING",
          EACCES: "STORAGE_PERMISSION",
          ENOSPC: "STORAGE_SPACE_INSUFFICIENT",
        } as any
      )[e?.code] ?? "INTEGRITY_CHECK_FAILED");
}
async function controlled(job: string, shutdown: () => boolean) {
  if (shutdown()) throw Error("INTEGRITY_INTERRUPTED");
  const r = (
    await pool.query("SELECT state FROM archive_jobs WHERE id=$1", [job])
  ).rows[0];
  if (!r || ["paused", "pause_requested"].includes(r.state))
    throw Error("INTEGRITY_INTERRUPTED");
}
async function checkpoint(job: any, cp: any, progress: any) {
  await pool.query(
    "UPDATE archive_jobs SET checkpoint=$2,progress=$3,updated_at=now() WHERE id=$1",
    [job.id, cp, progress],
  );
  job.checkpoint = cp;
  job.progress = progress;
}
async function verified(
  r: Locator,
  root = store.root,
  check: () => Promise<void> = async () => {},
) {
  const reader = new PackStore(root);
  if (r.size <= 16 * 1024 * 1024 && r.length <= 20 * 1024 * 1024)
    return reader.read(r);
  for await (const _ of reader.stream(r)) await check();
  return null;
}
async function references(
  db: DB,
  job: any,
  r: any,
  bytes: Buffer,
  check: () => Promise<void>,
) {
  if (!["manifest", "chunk_manifest"].includes(r.kind)) return;
  let doc: any;
  try {
    doc = JSON.parse(bytes.toString());
  } catch {
    await issue(db, job.id, r.hash, "MANIFEST_INVALID", r.hash, r.pack);
    return;
  }
  const refs = [
    ...(doc.objects ?? []),
    ...(doc.chunks ?? []),
    ...(doc.metadata_hash ? [{ hash: doc.metadata_hash }] : []),
  ];
  for (let start = 0; start < refs.length; start += 256) {
    await check();
    const part = refs.slice(start, start + 256);
    if (
      part.some(
        (v: any) =>
          typeof v.hash !== "string" || !/^[a-f0-9]{64}$/.test(v.hash),
      )
    ) {
      await issue(db, job.id, r.hash, "REFERENCE_INVALID", r.hash, r.pack);
      return;
    }
    const found = new Map(
      (
        await db.query(
          "SELECT encode(hash,'hex') AS hash,size FROM archive_object_data WHERE hash=ANY($1::bytea[])",
          [part.map((v: any) => Buffer.from(v.hash, "hex"))],
        )
      ).rows.map((v) => [v.hash, Number(v.size)]),
    );
    for (const ref of part) {
      if (!found.has(ref.hash))
        await issue(
          db,
          job.id,
          r.hash + ":" + ref.hash,
          "REFERENCE_MISSING",
          ref.hash,
          null,
          { referenced_by: r.hash },
        );
      else if (ref.size != null && ref.size !== found.get(ref.hash))
        await issue(
          db,
          job.id,
          r.hash + ":" + ref.hash,
          "REFERENCE_SIZE",
          ref.hash,
          null,
          { referenced_by: r.hash },
        );
    }
  }
  if (r.kind === "chunk_manifest") {
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (const c of doc.chunks ?? []) {
        const row = (
          await db.query(
            `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash=decode($1,'hex')`,
            [c.hash],
          )
        ).rows[0];
        if (!row) throw Error("REFERENCE_MISSING");
        for await (const b of store.stream(locator(row))) {
          await check();
          hash.update(b);
          size += b.length;
        }
      }
      if (size !== doc.size || hash.digest("hex") !== doc.sha256)
        throw Error("MEDIA_REASSEMBLY");
    } catch (e: any) {
      if (e.message === "INTEGRITY_INTERRUPTED") throw e;
      await issue(db, job.id, r.hash, errorCode(e), r.hash, r.pack);
    }
  }
}
async function scrubStep(job: any, shutdown: () => boolean) {
  let lastCheck = 0;
  const check = async () => {
    if (shutdown()) throw Error("INTEGRITY_INTERRUPTED");
    if (Date.now() - lastCheck < 250) return;
    await controlled(job.id, shutdown);
    lastCheck = Date.now();
  };
  const limit = (await processingPolicy()).accelerated ? 128 : 32;
  let cp = job.checkpoint,
    progress = job.progress;
  if (!cp.phase) {
    const upper =
      (
        await pool.query(
          "SELECT encode(hash,'hex') AS hash FROM archive_object_data ORDER BY hash DESC LIMIT 1",
        )
      ).rows[0]?.hash ?? "";
    const total = Number(
      (await pool.query("SELECT count(*) FROM archive_object_data")).rows[0]
        .count,
    );
    cp = { phase: "inventory", upper };
    progress = { phase: "inventory", completed: 0, total };
    await checkpoint(job, cp, progress);
  }
  if (cp.phase === "inventory") {
    try {
      for await (const entry of await opendir(join(store.root, "packs"))) {
        await check();
        if (!/^[a-f0-9-]+\.pmpack$/.test(entry.name)) continue;
        if (!entry.isFile()) {
          await issue(
            pool,
            job.id,
            entry.name,
            "PACK_NOT_REGULAR",
            null,
            entry.name,
          );
          continue;
        }
        await pool.query(
          "INSERT INTO integrity_packs(job_id,pack) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [job.id, entry.name],
        );
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    cp = { ...cp, phase: "packs" };
    await checkpoint(job, cp, { ...progress, phase: "packs" });
    return;
  }
  if (cp.phase === "packs") {
    const next = (
      await pool.query(
        "SELECT pack FROM integrity_packs WHERE job_id=$1 AND state='pending' ORDER BY pack LIMIT 1",
        [job.id],
      )
    ).rows[0];
    if (!next) {
      await checkpoint(
        job,
        { ...cp, phase: "objects", cursor: "" },
        { ...progress, phase: "objects" },
      );
      return;
    }
    const pack = next.pack;
    let offset = cp.pack === pack ? (cp.offset ?? 8) : 8,
      n = 0,
      ended = false;
    // A bounded shared locator lock prevents collection/publication races during this chunk.
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
      try {
        for await (const r of scanPackRecords(store.root, pack, offset)) {
          await check();
          const registered = (
            await db.query(
              `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash=decode($1,'hex')`,
              [r.hash],
            )
          ).rows[0];
          if (registered?.pack === pack) {
            if (
              Number(registered.byte_offset) !== r.offset ||
              Number(registered.length) !== r.length ||
              Number(registered.size) !== r.size ||
              registered.kind !== r.kind
            )
              await issue(db, job.id, r.hash, "LOCATOR_MISMATCH", r.hash, pack);
          } else {
            try {
              await verified(r, store.root, check);
            } catch (e: any) {
              if (e.message === "INTEGRITY_INTERRUPTED") throw e;
              await issue(
                db,
                job.id,
                pack + ":" + r.offset,
                "UNREFERENCED_CORRUPT",
                r.hash,
                pack,
                { code: errorCode(e), current_pack: registered?.pack ?? null },
              );
            }
          }
          offset = r.offset + r.length;
          n++;
          if (n >= limit) break;
        }
        ended = n < limit;
      } catch (e: any) {
        if (e.message === "INTEGRITY_INTERRUPTED") throw e;
        if (
          e.code !== "ENOENT" ||
          (
            await db.query(
              "SELECT 1 FROM archive_objects WHERE pack=$1 LIMIT 1",
              [pack],
            )
          ).rowCount
        )
          await issue(db, job.id, pack, errorCode(e), null, pack);
        ended = true;
      }
      if (ended)
        await db.query(
          "UPDATE integrity_packs SET state='completed' WHERE job_id=$1 AND pack=$2",
          [job.id, pack],
        );
      cp = { ...cp, pack, offset };
      progress = {
        ...progress,
        phase: "packs",
        pack,
        records: Number(progress.records ?? 0) + n,
      };
      await db.query(
        "UPDATE archive_jobs SET checkpoint=$2,progress=$3,updated_at=now() WHERE id=$1",
        [job.id, cp, progress],
      );
    });
    return;
  }
  if (cp.phase === "objects") {
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
      const rows = (
        await db.query(
          `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash>decode($1,'hex') AND o.hash<=decode($2,'hex') ORDER BY o.hash LIMIT $3`,
          [cp.cursor ?? "", cp.upper, limit],
        )
      ).rows;
      for (const r of rows) {
        await check();
        try {
          const bytes = await verified(locator(r), store.root, check);
          if (["manifest", "chunk_manifest"].includes(r.kind))
            await references(
              db,
              job,
              r,
              bytes ?? (await store.read(locator(r))),
              check,
            );
        } catch (e: any) {
          if (e.message === "INTEGRITY_INTERRUPTED") throw e;
          await issue(db, job.id, r.hash, errorCode(e), r.hash, r.pack);
        }
      }
      cp = {
        ...cp,
        cursor: rows.at(-1)?.hash ?? cp.cursor,
        ...(!rows.length ? { phase: "payloads", payload: "" } : {}),
      };
      progress = {
        ...progress,
        phase: cp.phase,
        completed: Number(progress.completed ?? 0) + rows.length,
      };
      await db.query(
        "UPDATE archive_jobs SET checkpoint=$2,progress=$3,updated_at=now() WHERE id=$1",
        [job.id, cp, progress],
      );
    });
    return;
  }
  if (cp.phase === "payloads") {
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
      const rows = (
        await db.query(
          "SELECT hash FROM archive_payloads WHERE hash>decode($1,'hex') ORDER BY hash LIMIT $2",
          [cp.payload, limit],
        )
      ).rows;
      for (const row of rows) {
        await check();
        try {
          await readPayloads(db, [row.hash]);
        } catch (e) {
          await issue(
            db,
            job.id,
            row.hash.toString("hex"),
            "CATALOG_PAYLOAD_INVALID",
            null,
            null,
            { hash: row.hash.toString("hex"), code: errorCode(e) },
          );
        }
      }
      await db.query(
        "UPDATE archive_jobs SET checkpoint=$2,progress=progress||$3::jsonb,updated_at=now() WHERE id=$1",
        [
          job.id,
          {
            ...cp,
            payload: rows.at(-1)?.hash.toString("hex") ?? cp.payload,
            ...(!rows.length ? { phase: "dictionaries", dictionary: 0 } : {}),
          },
          { phase: rows.length ? "payloads" : "dictionaries" },
        ],
      );
    });
    return;
  }
  if (cp.phase === "dictionaries") {
    const rows = (
      await pool.query(
        "SELECT id,hash,data FROM archive_dictionaries WHERE id>$1 ORDER BY id LIMIT $2",
        [cp.dictionary, limit],
      )
    ).rows;
    for (const row of rows) {
      await check();
      if (sha(row.data) !== row.hash.toString("hex"))
        await issue(
          pool,
          job.id,
          "dictionary:" + row.id,
          "CATALOG_DICTIONARY_INVALID",
          null,
          null,
          { dictionary: row.id },
        );
    }
    await checkpoint(
      job,
      {
        ...cp,
        dictionary: rows.at(-1)?.id ?? cp.dictionary,
        ...(!rows.length ? { phase: "relations", relation: 0 } : {}),
      },
      { ...progress, phase: rows.length ? "dictionaries" : "relations" },
    );
    return;
  }
  if (cp.phase === "relations") {
    const constraints = (
      await pool.query(`SELECT c.conname,c.conrelid::regclass::text AS source,c.confrelid::regclass::text AS target,
 ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.i) AS keys,
 ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.i) AS refs
 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE c.contype='f' AND t.relnamespace='public'::regnamespace AND (t.relname LIKE 'archive_%' OR t.relname IN('ao3_media','ao3_media_revisions')) ORDER BY c.conname,c.conrelid`)
    ).rows;
    const c = constraints[cp.relation];
    if (c) {
      await check();
      const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
      const condition = c.keys
          .map((k: string, i: number) => `t.${quote(k)}=s.${quote(c.refs[i])}`)
          .join(" AND "),
        notnull = c.keys
          .map((k: string) => `t.${quote(k)} IS NOT NULL`)
          .join(" AND ");
      const count = Number(
        (
          await pool.query(
            `SELECT count(*) FROM ${c.source} t WHERE ${notnull} AND NOT EXISTS(SELECT 1 FROM ${c.target} s WHERE ${condition})`,
          )
        ).rows[0].count,
      );
      if (count)
        await issue(
          pool,
          job.id,
          c.source + "." + c.conname,
          "RELATION_MISSING",
          null,
          null,
          { table: c.source, constraint: c.conname, count },
        );
      await checkpoint(
        job,
        { ...cp, relation: cp.relation + 1 },
        { ...progress, phase: "relations", relations: cp.relation + 1 },
      );
      return;
    }
    // Cross-work heads must not refer to another work's historical snapshot.
    const wrong = Number(
      (
        await pool.query(
          "SELECT count(*) FROM archive_work_heads w JOIN archive_snapshot_data s ON s.id=w.current_snapshot_id WHERE s.work_id<>w.id AND NOT EXISTS(SELECT 1 FROM archive_identity_links l WHERE l.work_id=s.work_id AND l.canonical_work_id=w.id)",
        )
      ).rows[0].count,
    );
    if (wrong)
      await issue(pool, job.id, "heads", "HEAD_REFERENCE", null, null, {
        count: wrong,
      });
    await transaction(async (db) => {
      await db.query(
        "UPDATE archive_jobs SET state='completed',finished_at=now(),updated_at=now(),progress=progress||'{\"phase\":\"completed\"}'::jsonb,result=jsonb_build_object('issues',(SELECT count(*) FROM integrity_issues WHERE job_id=$1)) WHERE id=$1",
        [job.id],
      );
      await jobAudit(db, job, "integrity.completed", {
        before: { state: "running" },
        after: {
          state: "completed",
          issues: Number(
            (
              await db.query(
                "SELECT count(*) FROM integrity_issues WHERE job_id=$1",
                [job.id],
              )
            ).rows[0].count,
          ),
        },
      });
    });
  }
}
async function materialize(
  chain: ArchiveChain,
  file: any,
  root: string,
  check: () => Promise<void>,
) {
  if (!/^[a-f0-9-]+\.pmpack$/.test(file.name) || !Array.isArray(file.chunks))
    throw Error("BACKUP_FILE");
  await mkdir(join(root, "packs"), { recursive: true, mode: 0o700 });
  const dest = join(root, "packs", file.name);
  try {
    const ready = await fileDigest(join(root, "packs"), file.name);
    if (ready.size === file.size && ready.sha256 === file.sha256) return;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const disk = await statfs(root);
  if (
    disk.bavail * disk.bsize <
    file.size + Number(process.env.ARCHIVE_RESERVE_BYTES ?? 268435456)
  )
    throw Error("STORAGE_SPACE_INSUFFICIENT");
  const f = await open(dest + ".partial", "w", 0o600),
    hash = createHash("sha256");
  let size = 0;
  try {
    for (const chunk of file.chunks)
      for await (const b of readObject(chain, chunk)) {
        await check();
        hash.update(b);
        size += b.length;
        if (size > file.size) throw Error("BACKUP_FILE_SIZE");
        await f.writeFile(b);
      }
    if (size !== file.size || hash.digest("hex") !== file.sha256)
      throw Error("BACKUP_FILE_CHECKSUM");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(dest + ".partial", dest);
}
async function repair(job: any, shutdown: () => boolean) {
  const check = () => controlled(job.id, shutdown),
    cp = job.checkpoint;
  const problem = (
    await pool.query("SELECT * FROM integrity_issues WHERE id=$1", [cp.issue])
  ).rows[0];
  if (!problem?.object_hash) throw Error("REPAIR_REFERENCE_REQUIRED");
  const backup = (
    await pool.query(
      "SELECT * FROM backup_runs WHERE id=$1 AND state='completed' AND kind IN('full','export')",
      [cp.backup],
    )
  ).rows[0];
  if (!backup) throw Error("BACKUP_SOURCE_UNAVAILABLE");
  const original = (
    await pool.query(
      `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash=decode($1,'hex')`,
      [problem.object_hash],
    )
  ).rows[0];
  let handle: Awaited<ReturnType<typeof openBackupTarget>> | undefined,
    chainHandles: Awaited<ReturnType<typeof exportChain>> | undefined;
  const stage = join(store.root, "staging", "repair-" + job.id);
  try {
    let chain: ArchiveChain;
    if (backup.kind === "export") {
      chainHandles = await exportChain(backup.id);
      chain = await openChain(chainHandles.paths);
    } else {
      handle = await openBackupTarget(await destination(backup.destination), {
        readOnly: true,
      });
      chain = await openChain([join(handle.path, backup.id, "archive")]);
    }
    let lastCheck = 0;
    const checked = async () => {
      if (shutdown()) throw Error("INTEGRITY_INTERRUPTED");
      if (Date.now() - lastCheck < 250) return;
      await check();
      await handle?.check();
      await chainHandles?.check();
      lastCheck = Date.now();
    };
    // Volume verification is shared with standalone export; no application data is restored.
    await checkpoint(job, { ...cp, phase: "verify" }, { phase: "verify" });
    await verify(chain, checked);
    await checked();
    let record: Pick<Locator, "hash" | "kind" | "size"> | undefined,
      source: AsyncIterable<Buffer> | undefined;
    if (backup.kind === "export") {
      const found = chain.objects.get(problem.object_hash);
      if (found) {
        record = found.object;
        source = readObject(chain, record.hash);
      }
    } else {
      const plan: any = chain.manifest.catalog;
      if (
        chain.manifest.format !== "palimora-backup-v1" ||
        plan.schema !== "palimora-backup-catalog-v1" ||
        plan.kind !== "full" ||
        !Array.isArray(plan.files)
      )
        throw Error("BACKUP_FORMAT");
      const files = plan.files
        .filter(
          (f: any) => typeof f.name === "string" && f.name.endsWith(".pmpack"),
        )
        .sort(
          (a: any, b: any) =>
            Number(b.name === problem.pack) - Number(a.name === problem.pack),
        );
      for (const file of files) {
        await checked();
        await checkpoint(
          job,
          { ...cp, phase: "search", pack: file.name },
          { phase: "search", pack: file.name },
        );
        await materialize(chain, file, stage, checked);
        for await (const r of scanPackRecords(stage, file.name)) {
          if (r.hash === problem.object_hash) {
            record = r;
            source = new PackStore(stage).stream(r);
            break;
          }
        }
        if (record) break;
        await rm(join(stage, "packs", file.name));
      }
    }
    if (!record || !source) {
      await pool.query(
        "UPDATE integrity_issues SET state='unrecoverable',detail=detail||jsonb_build_object('recovery_error','BACKUP_OBJECT_MISSING'),updated_at=now() WHERE id=$1",
        [problem.id],
      );
      throw Error("BACKUP_OBJECT_MISSING");
    }
    if (
      original &&
      (Number(original.size) !== record.size || original.kind !== record.kind)
    )
      throw Error("REPAIR_IDENTITY_MISMATCH");
    await checkpoint(job, { ...cp, phase: "repair" }, { phase: "repair" });
    // Both publication and issue resolution commit together. Existing sealed files are retained.
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(70210402)");
      const restored = await store.restoreStream(record!, source!, checked);
      await db.query("SELECT pg_advisory_xact_lock(70210402)");
      if (
        !(
          await db.query(
            "SELECT 1 FROM users WHERE id=$1 AND role='Owner' AND NOT disabled AND soft_deleted_at IS NULL",
            [job.actor_id],
          )
        ).rowCount
      )
        throw Error("OPERATOR_AUTHORITY_REVOKED");
      await check();
      const current = (
        await db.query(
          `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash=decode($1,'hex')`,
          [record!.hash],
        )
      ).rows[0];
      if (
        original &&
        (!current ||
          current.pack !== original.pack ||
          String(current.byte_offset) !== String(original.byte_offset) ||
          String(current.length) !== String(original.length))
      )
        throw Error("REPAIR_CONCURRENT_CHANGE");
      if (!original && current) throw Error("REPAIR_CONCURRENT_CHANGE");
      await db.query(
        "INSERT INTO archive_packs(name) VALUES($1) ON CONFLICT DO NOTHING",
        [restored.pack],
      );
      await db.query(
        "INSERT INTO archive_kinds(name) VALUES($1) ON CONFLICT DO NOTHING",
        [restored.kind],
      );
      await db.query(
        `INSERT INTO archive_object_data(hash,pack_id,byte_offset,length,size,kind_id) SELECT decode($1,'hex'),p.id,$3,$4,$5,k.id FROM archive_packs p,archive_kinds k WHERE p.name=$2 AND k.name=$6 ON CONFLICT(hash) DO UPDATE SET pack_id=excluded.pack_id,byte_offset=excluded.byte_offset,length=excluded.length`,
        [
          restored.hash,
          restored.pack,
          restored.offset,
          restored.length,
          restored.size,
          restored.kind,
        ],
      );
      await db.query(
        "UPDATE integrity_issues SET state='repaired',repair_job_id=$2,detail=detail-'recovery_error',updated_at=now() WHERE object_hash=$1 AND code IN('PACK_MISSING','PACK_CORRUPT','PACK_VERSION','PACK_HEADER','PACK_TRUNCATED','OBJECT_CORRUPT','LOCATOR_MISMATCH','PACK_LOCATOR','REFERENCE_MISSING')",
        [restored.hash, job.id],
      );
      await db.query(
        "UPDATE archive_jobs SET state='completed',finished_at=now(),updated_at=now(),progress=$2,result=$3 WHERE id=$1",
        [
          job.id,
          { phase: "completed", completed: 1, total: 1 },
          { hash: restored.hash, pack: restored.pack },
        ],
      );
      await jobAudit(
        db,
        job,
        "integrity.repaired",
        {
          backup: backup.id,
          before: original
            ? {
                pack: original.pack,
                offset: original.byte_offset,
                length: original.length,
              }
            : null,
          after: {
            pack: restored.pack,
            offset: restored.offset,
            length: restored.length,
          },
        },
        "success",
        restored.hash,
      );
    });
    await rm(stage, { recursive: true, force: true });
  } finally {
    await handle?.close();
    await chainHandles?.close();
  }
}
/** Called under the existing maintenance worker's leader lock, not a second queue. */
export async function integrityTick(shutdown: () => boolean) {
  await transaction(async (db) => {
    const s = (await db.query("SELECT * FROM integrity_schedule FOR UPDATE"))
      .rows[0];
    if (
      s.enabled &&
      new Date(s.next_at).getTime() <= Date.now() &&
      !(
        await db.query(
          "SELECT 1 FROM archive_jobs WHERE kind='scrub' AND state IN('pending','running','paused','pause_requested')",
        )
      ).rowCount
    ) {
      const actor = (
        await db.query(
          "SELECT id FROM users WHERE id=$1 AND role IN('Owner','Admin') AND NOT disabled AND soft_deleted_at IS NULL",
          [s.actor_id],
        )
      ).rows[0];
      if (actor) {
        await db.query(
          "INSERT INTO archive_jobs(id,kind,actor_id) VALUES($1,'scrub',$2)",
          [randomUUID(), actor.id],
        );
        await db.query(
          "UPDATE integrity_schedule SET next_at=now()+every_days*interval '1 day'",
        );
      } else await db.query("UPDATE integrity_schedule SET enabled=false");
    }
  });
  const job = (
    await pool.query(
      "SELECT * FROM archive_jobs WHERE kind IN('scrub','repair') AND state IN('pending','running','pause_requested') ORDER BY created_at LIMIT 1",
    )
  ).rows[0];
  if (!job) return false;
  try {
    if (job.state === "pause_requested") throw Error("INTEGRITY_INTERRUPTED");
    const actor = (
      await pool.query(
        "SELECT role,disabled,soft_deleted_at FROM users WHERE id=$1",
        [job.actor_id],
      )
    ).rows[0];
    if (
      !actor ||
      actor.disabled ||
      actor.soft_deleted_at ||
      actor.role === "User" ||
      (job.kind === "repair" && actor.role !== "Owner")
    )
      throw Error("OPERATOR_AUTHORITY_REVOKED");
    if (
      !(
        await pool.query(
          "UPDATE archive_jobs SET state='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1 AND state IN('pending','running') RETURNING id",
          [job.id],
        )
      ).rowCount
    )
      return true;
    if (job.kind === "scrub") await scrubStep(job, shutdown);
    else await repair(job, shutdown);
  } catch (e: any) {
    const interrupted = e.message === "INTEGRITY_INTERRUPTED" || shutdown();
    await transaction(async (db) => {
      const state = interrupted ? "paused" : "failed",
        result = interrupted ? null : { code: errorCode(e) };
      await db.query(
        "UPDATE archive_jobs SET state=$2,result=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",
        [job.id, state, result],
      );
      await jobAudit(
        db,
        job,
        "integrity." + state,
        { before: { state: job.state }, after: { state, ...result } },
        interrupted ? "success" : "failure",
      );
      if (!interrupted && job.kind === "repair")
        await db.query(
          "UPDATE integrity_issues SET detail=detail||jsonb_build_object('recovery_error',$2::text),updated_at=now() WHERE id=$1",
          [job.checkpoint.issue, errorCode(e)],
        );
    });
  }
  return true;
}
