import { randomUUID } from "node:crypto";
import { DB, pool, transaction } from "./db";
import { AO3Client, SyncError } from "./ao3-client";
import { enqueueSync, syncAllowed, adaptiveHours } from "./ao3-scheduler";
import {
  listing,
  parseWork,
  parseComments,
  workAvailability,
} from "./ao3-parser";
import { ingestRecords, archiveTransaction, preserve } from "./archive";
import { canonical, sha } from "./pack";
import {
  acquireMedia,
  acquireUploadedMedia,
  attachAvailableMedia,
} from "./ao3-media";
import {
  dom,
  all,
  first,
  attr,
  has,
  clean,
  links,
  raw,
  tagPath,
  tagName,
} from "./ao3-html";

export async function executeSync(
  id: string,
  stopped: () => boolean = () => false,
) {
  const leader = await pool.connect();
  let locked = false,
    job: any,
    run: any;
  try {
    locked = (
      await leader.query("SELECT pg_try_advisory_lock(70210423) AS yes")
    ).rows[0].yes;
    if (!locked || stopped()) return;
    if (
      (
        await leader.query(
          "SELECT 1 FROM archive_jobs WHERE kind='reset_dev' AND state IN ('pending','running') LIMIT 1",
        )
      ).rowCount
    )
      return;
    job = (
      await leader.query(
        `SELECT * FROM ao3_jobs WHERE id=$1 AND due_at<=now() AND state<>'blocked' AND availability<>'deleted'
      AND (kind<>'work' OR started_at IS NULL OR started_at<=now()-interval '1 hour')`,
        [id],
      )
    ).rows[0];
    if (!job) return;
    if (!(await syncAllowed(leader))) {
      if (
        !(job.kind === "media" && job.checkpoint.upload) ||
        (await leader.query("SELECT paused FROM ao3_control")).rows[0].paused
      )
        return;
    }
    await transaction(async (db) => {
      await db.query(
        "UPDATE ao3_runs SET outcome='interrupted',finished_at=now() WHERE job_id=$1 AND finished_at IS NULL",
        [id],
      );
      run = (
        await db.query("INSERT INTO ao3_runs(job_id) VALUES($1) RETURNING id", [
          id,
        ])
      ).rows[0].id;
      await db.query(
        "UPDATE ao3_jobs SET state='running',started_at=now() WHERE id=$1",
        [id],
      );
      if (job.kind === "work")
        await db.query(
          `UPDATE ao3_watch w SET last_started_at=now(),next_due_at=now()+interval '1 hour'
        FROM archive_work_heads h WHERE h.id=w.work_id AND h.external_id=$1`,
          [job.target],
        );
    });
    const client = new AO3Client(stopped);
    if (job.kind === "discovery" || job.kind === "backfill")
      await discover(job, run, client);
    else if (job.kind === "work") await synchronizeWork(job, run, client);
    else if (job.kind === "media") {
      const result = job.checkpoint.upload
        ? await acquireUploadedMedia(job.checkpoint.upload, stopped)
        : await acquireMedia(job.target, stopped);
      await transaction((db) =>
        finish(db, job, run, 30 * 86400000, result, {}),
      );
    } else await synchronizeEntity(job, run, client);
  } catch (error) {
    if (!job || !run) throw error;
    const e =
      error instanceof SyncError ? error : new SyncError("SYNC_INTERNAL_ERROR");
    const attempts = job.attempts + 1,
      delay =
        Math.max(
          e.delay,
          Math.min(7 * 86400000, 60000 * 2 ** Math.min(attempts, 16)),
        ) *
        (1 + Math.random() * 0.1);
    await transaction(async (db) => {
      if (job.kind === "work" && e.code === "AO3_LOGIN_REQUIRED") {
        await db.query(
          "UPDATE ao3_jobs SET availability='hidden_or_restricted' WHERE id=$1",
          [id],
        );
        await db.query(
          "INSERT INTO ao3_observations(job_id,availability,detail) VALUES($1,'hidden_or_restricted',$2)",
          [id, { code: e.code }],
        );
        await db.query(
          "UPDATE ao3_watch w SET availability='hidden_or_restricted' FROM archive_work_heads h WHERE h.id=w.work_id AND h.external_id=$1",
          [job.target],
        );
      }
      await db.query(
        `UPDATE ao3_jobs SET state='retry',attempts=attempts+1,error=$2,
        due_at=now()+$3*interval '1 millisecond',generation=generation+1 WHERE id=$1`,
        [id, e.code, delay],
      );
      await db.query(
        "UPDATE ao3_runs SET finished_at=now(),outcome='retry',detail=$2 WHERE id=$1",
        [run, { code: e.code, retry_ms: Math.ceil(delay) }],
      );
    });
  } finally {
    if (locked) await leader.query("SELECT pg_advisory_unlock(70210423)");
    leader.release();
  }
}
async function finish(
  db: DB,
  job: any,
  run: string,
  delay: number,
  detail: any = {},
  checkpoint?: any,
) {
  await db.query(
    `UPDATE ao3_jobs SET state='idle',attempts=0,error=NULL,checked_at=now(),
    due_at=now()+$2*interval '1 millisecond',generation=generation+1,checkpoint=coalesce($3,checkpoint) WHERE id=$1`,
    [job.id, delay, checkpoint ?? null],
  );
  await db.query(
    "UPDATE ao3_runs SET outcome='completed',finished_at=now(),detail=$2 WHERE id=$1",
    [run, detail],
  );
}
async function discover(job: any, run: string, client: AO3Client) {
  let checkpoint = job.checkpoint;
  if (!checkpoint.from) {
    const end =
      job.kind === "backfill"
        ? new Date(Date.now() - 2 * 86400000)
        : new Date();
    checkpoint = {
      from: new Date(
        end.getTime() - (job.kind === "backfill" ? 86400000 : 2 * 86400000),
      )
        .toISOString()
        .slice(0, 10),
      to: end.toISOString().slice(0, 10),
      page: 1,
      found: 0,
    };
    if (job.kind === "discovery" && job.checkpoint.watermark)
      checkpoint.from = new Date(
        Date.parse(job.checkpoint.watermark + "T00:00:00Z") - 86400000,
      )
        .toISOString()
        .slice(0, 10);
    await pool.query("UPDATE ao3_jobs SET checkpoint=$2 WHERE id=$1", [
      job.id,
      checkpoint,
    ]);
  }
  const query = new URLSearchParams({
    "work_search[revised_at]":
      checkpoint.from === "earliest"
        ? "<" + checkpoint.to
        : checkpoint.from + " to " + checkpoint.to,
    "work_search[sort_column]": "created_at",
    "work_search[sort_direction]": "asc",
    page: String(checkpoint.page),
  });
  const r = await client.get("/works?" + query);
  if (r.status !== 200) throw new SyncError("AO3_DISCOVERY_HTTP");
  const page = listing(r.html);
  if (
    page.nextPage !== null &&
    (!Number.isInteger(page.nextPage) || page.nextPage <= checkpoint.page)
  )
    throw new SyncError("AO3_PAGINATION");
  await transaction(async (db) => {
    for (const id of page.ids)
      await enqueueSync(db, "work", id, job.kind === "discovery" ? 10 : 80);
    const total = checkpoint.found + page.ids.length;
    if (page.nextPage)
      await finish(
        db,
        job,
        run,
        10000,
        { found: page.ids.length, window: checkpoint },
        { ...checkpoint, page: page.nextPage, found: total },
      );
    else if (job.kind === "backfill") {
      const to = new Date(checkpoint.from + "T00:00:00Z");
      if (checkpoint.from === "earliest") {
        await finish(
          db,
          job,
          run,
          365 * 86400000,
          { found: total, exhausted: true },
          {},
        );
      } else if (to.getUTCFullYear() < 2008) {
        await finish(
          db,
          job,
          run,
          60000,
          { found: total, window: checkpoint },
          { from: "earliest", to: checkpoint.from, page: 1, found: 0 },
        );
      } else
        await finish(
          db,
          job,
          run,
          60000,
          { found: total, window: checkpoint },
          {
            from: new Date(to.getTime() - 86400000).toISOString().slice(0, 10),
            to: checkpoint.from,
            page: 1,
            found: 0,
          },
        );
    } else
      await finish(
        db,
        job,
        run,
        3600000,
        { found: total, window: checkpoint },
        { watermark: checkpoint.to },
      );
  });
}
export async function commitRemote(job: any, run: string, record: any) {
  const fingerprint = sha(
    canonical({
      metadata: record.metadata,
      chapters: record.chapters,
      objects: record.objects,
    }),
  );
  const batch = randomUUID(),
    source = {
      id: randomUUID(),
      batch_id: batch,
      path: "ao3://works/" + job.target,
      fingerprint: job.id + "-" + job.generation,
    };
  // Durable provenance uses the existing ingest tables and canonical commit path.
  await transaction(async (db) => {
    await db.query(
      "INSERT INTO ingest_batches(id,state,source_kind) VALUES($1,'running','ao3')",
      [batch],
    );
    await db.query(
      "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
      [source.id, batch, source.path, source.fingerprint],
    );
  });
  try {
    await ingestRecords(
      source,
      [
        {
          schema: "palimora.ingest.v1",
          parser: "ao3-live-1",
          cursor: 1,
          locator: job.target,
          record,
        },
      ],
      {
        authoritative: true,
        finalize: async (db) => {
          const w = (
            await db.query(
              "SELECT id,current_snapshot_id FROM archive_work_heads WHERE external_id=$1",
              [job.target],
            )
          ).rows[0];
          const watch =
            (
              await db.query(
                "SELECT watch_until>now() AS active FROM ao3_watch WHERE work_id=$1",
                [w.id],
              )
            ).rows[0]?.active ?? false;
          const previous = (
            await db.query(
              "SELECT result_hash FROM ao3_observations WHERE job_id=$1 ORDER BY id DESC LIMIT 1",
              [job.id],
            )
          ).rows[0]?.result_hash;
          const changed = previous !== fingerprint;
          const days = changed
            ? 0
            : (Date.now() - (job.last_changed_at?.getTime() ?? Date.now())) /
              86400000;
          await db.query(
            `INSERT INTO ao3_observations(job_id,result_hash,snapshot_id,availability,detail) VALUES($1,$2,$3,'available',$4)`,
            [
              job.id,
              fingerprint,
              w.current_snapshot_id,
              { comments: record.metadata.ao3.comments?.length ?? null },
            ],
          );
          await db.query(
            "UPDATE ao3_jobs SET availability='available',complete=$2,last_changed_at=CASE WHEN $3 THEN now() ELSE last_changed_at END WHERE id=$1",
            [job.id, record.metadata.ao3.complete ?? null, changed],
          );
          await db.query(
            "UPDATE ao3_watch SET availability='available',next_due_at=greatest(next_due_at,now()+interval '1 hour') WHERE work_id=$1",
            [w.id],
          );
          for (const url of record.media_urls ?? [])
            await db.query(
              `INSERT INTO ao3_jobs(kind,target,priority) VALUES('media',$1,50) ON CONFLICT DO NOTHING`,
              [url],
            );
          for (const tag of record.metadata.ao3.tags ?? [])
            await db.query(
              `INSERT INTO ao3_jobs(kind,target,priority) VALUES('entity',$1,40) ON CONFLICT DO NOTHING`,
              [tagPath(tag.name)],
            );
          for (const entity of [
            ...(record.metadata.ao3.authors ?? []),
            ...(record.metadata.ao3.series ?? []),
          ])
            if (entity.url)
              await db.query(
                `INSERT INTO ao3_jobs(kind,target,priority) VALUES('entity',$1,40) ON CONFLICT DO NOTHING`,
                [new URL(entity.url).pathname],
              );
          await db.query(
            "UPDATE ingest_batches SET state='completed',updated_at=now() WHERE id=$1",
            [batch],
          );
          await db.query(
            "UPDATE ingest_sources SET state='ingested' WHERE id=$1",
            [source.id],
          );
          await finish(
            db,
            job,
            run,
            adaptiveHours(record.metadata.ao3.complete ?? null, days, watch) *
              3600000,
            { snapshot_id: w.current_snapshot_id, changed },
            {},
          );
          await db.query(
            "UPDATE ao3_jobs SET priority=(SELECT (priorities->>'work')::int FROM ao3_control) WHERE id=$1",
            [job.id],
          );
        },
      },
    );
  } catch (e) {
    await pool.query(
      "UPDATE ingest_batches SET state='failed_global',error=$2 WHERE id=$1",
      [batch, { code: "SYNC_COMMIT_FAILED" }],
    );
    throw e;
  }
}
async function synchronizeWork(job: any, run: string, client: AO3Client) {
  let record: any = job.checkpoint.record,
    next: string | null = job.checkpoint.next_comments ?? null;
  let seen: string[] = job.checkpoint.seen ?? [];
  let pending: string[] = job.checkpoint.pending_comments ?? [];
  if (!record) {
    const r = await client.get(
      "/works/" +
        job.target +
        "?view_full_work=true&view_adult=true&show_comments=true",
    );
    const availability = workAvailability(r.status, r.html);
    if (availability !== "available") {
      await transaction(async (db) => {
        await db.query(
          "INSERT INTO ao3_observations(job_id,availability,detail) VALUES($1,$2,$3)",
          [job.id, availability, { http_status: r.status }],
        );
        await db.query("UPDATE ao3_jobs SET availability=$2 WHERE id=$1", [
          job.id,
          availability,
        ]);
        await db.query(
          `UPDATE ao3_watch w SET availability=$2 FROM archive_work_heads h WHERE h.id=w.work_id AND h.external_id=$1`,
          [job.target, availability],
        );
        await db.query(
          "INSERT INTO archive_outbox(event,payload) VALUES('work.availability.changed',$1)",
          [{ external_id: job.target, availability }],
        );
        await finish(
          db,
          job,
          run,
          availability === "deleted" ? 365 * 86400000 : 24 * 3600000,
          { availability },
        );
      });
      return;
    }
    if (
      new URL(r.path, "https://archiveofourown.org").pathname !==
      "/works/" + job.target
    )
      throw new SyncError("AO3_IDENTITY_REDIRECT");
    record = parseWork(job.target, r.html);
    const comments = parseComments(r.html);
    pending = comments.threads;
    next = comments.next ?? pending.shift() ?? null;
    await pool.query("UPDATE ao3_jobs SET checkpoint=$2 WHERE id=$1", [
      job.id,
      { record, next_comments: next, pending_comments: pending, seen },
    ]);
  }
  while (next) {
    if (seen.includes(next)) throw new SyncError("AO3_COMMENT_PAGINATION");
    const u = new URL(next, "https://archiveofourown.org");
    if (
      u.origin !== "https://archiveofourown.org" ||
      (u.pathname !== "/works/" + job.target &&
        !/^\/comments\/\d+$/.test(u.pathname))
    )
      throw new SyncError("AO3_COMMENT_REDIRECT");
    const response = await client.get(u.pathname + u.search);
    if (response.status !== 200) throw new SyncError("AO3_COMMENTS_HTTP");
    if (
      new URL(response.path, "https://archiveofourown.org").pathname !==
      u.pathname
    )
      throw new SyncError("AO3_COMMENT_REDIRECT");
    const page = parseComments(response.html);
    if (!page.comments.length) throw new SyncError("AO3_COMMENT_STRUCTURE");
    record.metadata.ao3.comments.push(...page.comments);
    if (
      Buffer.byteLength(JSON.stringify(record.metadata.ao3.comments)) >
      64 * 1024 * 1024
    )
      throw new SyncError("AO3_COMMENTS_MEMORY_BUDGET");
    seen.push(next);
    for (const path of [...page.threads, ...(page.next ? [page.next] : [])])
      if (!seen.includes(path) && !pending.includes(path)) pending.push(path);
    next = pending.shift() ?? null;
    record.metadata.ao3.comments = [
      ...new Map(
        record.metadata.ao3.comments.map((c: any) => [c.id, c]),
      ).values(),
    ];
    await pool.query("UPDATE ao3_jobs SET checkpoint=$2 WHERE id=$1", [
      job.id,
      { record, next_comments: next, pending_comments: pending, seen },
    ]);
  }
  if (
    record.metadata.ao3.statistics.comments ===
    record.metadata.ao3.comments.length
  )
    record.metadata.ao3.comments_coverage = "complete";
  if (record.metadata.ao3.kudos_coverage === "partial") {
    let pageNumber = 1;
    const users = new Map<string, any>();
    for (;;) {
      const response = await client.get(
        "/works/" + job.target + "/kudos?page=" + pageNumber,
      );
      if (response.status !== 200) throw new SyncError("AO3_KUDOS_HTTP");
      const root = dom(response.html),
        container = first(root, (n) => attr(n, "id") === "kudos");
      if (!container) throw new SyncError("AO3_KUDOS_STRUCTURE");
      for (const a of links(container))
        if (/^\/users\//.test(attr(a, "href")))
          users.set(attr(a, "href"), {
            name: clean(a),
            url: new URL(attr(a, "href"), "https://archiveofourown.org").href,
          });
      const nextLink = links(root).find((n) => attr(n, "rel") === "next");
      if (!nextLink) break;
      const page = Number(
        new URL(
          attr(nextLink, "href"),
          "https://archiveofourown.org",
        ).searchParams.get("page"),
      );
      if (!Number.isInteger(page) || page <= pageNumber)
        throw new SyncError("AO3_KUDOS_PAGINATION");
      pageNumber = page;
    }
    record.metadata.ao3.kudos.users = [...users.values()];
    record.metadata.ao3.kudos_coverage = "complete";
  }
  await enrich(record);
  await attachAvailableMedia(record);
  await commitRemote(job, run, record);
}
async function enrich(record: any) {
  const jobs = (
    await pool.query(
      "SELECT target,checkpoint FROM ao3_jobs WHERE kind='entity' AND target=ANY($1::text[])",
      [
        [
          ...record.metadata.ao3.tags.map((t: any) => tagPath(t.name)),
          ...record.metadata.ao3.authors.map(
            (e: any) => new URL(e.url).pathname,
          ),
          ...record.metadata.ao3.series.map(
            (e: any) => new URL(e.url).pathname,
          ),
        ],
      ],
    )
  ).rows;
  for (const j of jobs) {
    if (!j.checkpoint.entity) continue;
    if (j.target.startsWith("/tags/")) {
      const tag = record.metadata.ao3.tags.find(
        (t: any) => tagPath(t.name) === j.target,
      );
      Object.assign(tag, j.checkpoint.entity);
    } else {
      const list = j.target.startsWith("/series/")
        ? record.metadata.ao3.series
        : record.metadata.ao3.authors;
      const entity = list.find(
        (e: any) => new URL(e.url).pathname === j.target,
      );
      if (entity) Object.assign(entity, j.checkpoint.entity);
    }
  }
}
async function synchronizeEntity(job: any, run: string, client: AO3Client) {
  if (job.checkpoint.scan_page) {
    const path =
      job.target +
      (job.target.startsWith("/series/") ? "" : "/works") +
      "?page=" +
      job.checkpoint.scan_page;
    const response = await client.get(path);
    if (response.status !== 200) throw new SyncError("AO3_ENTITY_LIST_HTTP");
    const page = listing(response.html);
    if (page.nextPage !== null && page.nextPage <= job.checkpoint.scan_page)
      throw new SyncError("AO3_ENTITY_PAGINATION");
    await transaction(async (db) => {
      for (const id of page.ids) await enqueueSync(db, "work", id, 35);
      await finish(
        db,
        job,
        run,
        page.nextPage ? 10000 : 7 * 86400000,
        { works: page.ids.length },
        {
          entity: job.checkpoint.entity,
          ...(page.nextPage ? { scan_page: page.nextPage } : {}),
        },
      );
    });
    return;
  }
  const isTag = job.target.startsWith("/tags/"),
    isAuthor = job.target.startsWith("/users/");
  const path = isAuthor ? job.target + "/profile" : job.target;
  const r = await client.get(path);
  if (r.status !== 200) throw new SyncError("AO3_ENTITY_HTTP");
  const root = dom(r.html),
    main = first(root, (n) => attr(n, "id") === "main");
  if (!main) throw new SyncError("AO3_ENTITY_STRUCTURE");
  const heading = first(main, (n) => n.name === "h2" && has(n, "heading"));
  if (!heading) throw new SyncError("AO3_ENTITY_HEADING");
  let entity: any = {};
  if (isTag) {
    const body = clean(main),
      name = tagName(job.target.slice(6));
    if (!body.includes(name)) throw new SyncError("AO3_TAG_IDENTITY");
    const classes: Record<string, string> = {
      Fandom: "fandom",
      Rating: "rating",
      Warning: "warnings",
      Category: "category",
      Character: "characters",
      Relationship: "relationships",
      Freeform: "freeform",
      "Additional Tags": "freeform",
      Media: "media",
    };
    const category = body.match(/belongs to the (.+?) Category/);
    entity = {
      name,
      id: "name:" + name,
      ...(category && classes[category[1]]
        ? { kind: classes[category[1]] }
        : {}),
      synonym_of: null,
      meta_tags: [],
      parents: [],
      canonical:
        /not been marked common|not a canonical tag|made a synonym/i.test(body)
          ? false
          : /canonical tag/i.test(body)
            ? true
            : null,
    };
    const merger = first(main, (n) => has(n, "merger"));
    if (merger) {
      const a = links(merger).find((n) => attr(n, "href").startsWith("/tags/"));
      if (a)
        entity.synonym_of = "name:" + tagName(attr(a, "href").split("/")[2]);
    }
    for (const [klass, key] of [
      ["meta", "meta_tags"],
      ["parent", "parents"],
    ]) {
      const section = first(main, (n) => has(n, klass));
      if (section)
        entity[key] = links(section)
          .filter((n) => attr(n, "href").startsWith("/tags/"))
          .map((n) => "name:" + tagName(attr(n, "href").split("/")[2]));
    }
  } else {
    const description = first(main, (n) => has(n, "userstuff"));
    if (description) entity.description = raw(r.html, description);
    if (!isAuthor) {
      entity.name = clean(heading);
      const words = first(main, (n) => n.name === "dd" && has(n, "words"));
      if (words && /^[\d,]+$/.test(clean(words)))
        entity.statistics = { words: Number(clean(words).replaceAll(",", "")) };
    }
  }
  const ids = all(main, (n) => /^work_\d+$/.test(attr(n, "id"))).map((n) =>
    attr(n, "id").slice(5),
  );
  await archiveTransaction(
    async (db) => {
      const bytes = canonical({
        schema: "palimora-ao3-entity-v1",
        target: job.target,
        entity,
        source_hash: sha(r.html),
      });
      await preserve(db, [{ kind: "source_entity", bytes }]);
      await db.query(
        "INSERT INTO ao3_observations(job_id,result_hash,availability,detail) VALUES($1,$2,'available',$3)",
        [job.id, sha(bytes), { object_hash: sha(bytes) }],
      );
      if (isTag && entity.kind) {
        const prior = (
          await db.query("SELECT source_id FROM catalog_tags WHERE name=$1", [
            entity.name,
          ])
        ).rows[0]?.source_id;
        const sourceId = prior ?? entity.id;
        await db.query(
          "INSERT INTO archive_tag_observations(source_path,fingerprint,source_id,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          ["ao3:" + job.target, sha(bytes), sourceId, entity],
        );
        await db.query(
          "INSERT INTO archive_tags(source_id,evidence) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET evidence=excluded.evidence",
          [sourceId, entity],
        );
        for (const ref of [
          entity.synonym_of,
          ...entity.meta_tags,
          ...entity.parents,
        ].filter(Boolean))
          await db.query(
            "INSERT INTO ao3_jobs(kind,target,priority) VALUES('entity',$1,40) ON CONFLICT DO NOTHING",
            [tagPath(ref.slice(5))],
          );
      }
      for (const id of ids) await enqueueSync(db, "work", id, 35);
      const existing = (
        await db.query(
          `SELECT DISTINCT h.external_id FROM archive_work_heads h
      LEFT JOIN catalog_entity_works ew ON ew.work_id=h.id LEFT JOIN catalog_entities e ON e.id=ew.entity_id
      LEFT JOIN catalog_work_tags wt ON wt.work_id=h.id LEFT JOIN catalog_tags t ON t.id=wt.tag_id
      WHERE h.external_id IS NOT NULL AND (e.url=$1 OR ($2::text IS NOT NULL AND t.name=$2))`,
          [
            "https://archiveofourown.org" + job.target,
            isTag ? tagName(job.target.slice(6)) : null,
          ],
        )
      ).rows;
      for (const w of existing)
        await enqueueSync(db, "work", w.external_id, 35);
      await finish(
        db,
        job,
        run,
        10000,
        { works: ids.length },
        { entity, scan_page: 1 },
      );
    },
    ["ao3-entity:" + job.target],
  );
}
