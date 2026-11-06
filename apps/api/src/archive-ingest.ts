import { hydrateWorks, findObjects } from "./archive-catalog";
import { randomUUID } from "node:crypto";
import { DB } from "./db";
import { canonical, contentHash, rememberPrepared } from "./pack";
import { objectBytes, preserve, afterArchiveSeal } from "./archive";
import { compileManifest, prepareDocuments } from "./archive-native";
import {
  insertStageSQL,
  stageRows,
  stageTable,
  catalogPrelude,
  selectionSQL,
  entryJoin,
  originJoin,
} from "./archive-bulk";
import { commitProgress } from "./ingest-progress";

const key = (...parts: any[]) => JSON.stringify(parts);
/** One ordered state machine per group, followed by set-based catalog writes.
 * The surrounding archive transaction seals and verifies packs before COMMIT. */
export async function prepareIngest(
  db: DB,
  source: any,
  envelopes: any[],
  events: any[],
) {
  const groups: Record<string, any[]> = {};
  const progress: any[] = [];
  const observationDocuments: any[] = [];
  const add = (kind: string, row: any) => (groups[kind] ??= []).push(row);
  const input = envelopes;
  const prior = new Map(
    (
      await db.query(
        `SELECT $1::text AS source_path,$2::text AS fingerprint,a.work_id,a.snapshot_id,i.locator,i.parser,i.result_hash
        FROM jsonb_to_recordset($3::jsonb) i(locator text,parser text,result_hash text)
        ${entryJoin("$1", "i.locator")} ${originJoin("$1", "$2")}
        JOIN archive_parsers p ON p.name=i.parser
        JOIN LATERAL (SELECT work_id,snapshot_id FROM archive_record_data
          WHERE origin_id=o.id AND entry_id=e.id AND parser_id=p.id AND result_hash=decode(i.result_hash,'hex') OFFSET 0) a ON true`,
        [
          source.path,
          source.fingerprint,
          JSON.stringify(
            input.map((e) => ({
              locator: e.locator,
              parser: e.parser,
              result_hash: e.result_hash,
            })),
          ),
        ],
      )
    ).rows.map((r) => [key(r.locator, r.parser, r.result_hash), r]),
  );
  const works = await hydrateWorks(
    db,
    (
      await db.query(
        "SELECT v.* FROM archive_work_heads w JOIN archive_works v ON v.id=w.id WHERE w.external_id=ANY($1::text[]) OR w.provisional_entry_id IN(SELECT e.id FROM archive_entries e JOIN archive_paths p ON p.id=e.path_id WHERE p.path=$3 AND e.locator=ANY($2::text[])) ORDER BY w.id FOR UPDATE OF w",
        [
          input.map((e) => e.record.external_id).filter(Boolean),
          input.map((e) => e.record.source_entry || e.locator),
          source.path,
        ],
      )
    ).rows,
  );
  const aliases = new Map(
    (
      await db.query(
        "SELECT * FROM archive_identity_links WHERE work_id=ANY($1::uuid[])",
        [works.map((w) => w.id)],
      )
    ).rows.map((r) => [r.work_id, r.canonical_work_id]),
  );
  if (aliases.size)
    works.push(
      ...(await hydrateWorks(
        db,
        (
          await db.query(
            "SELECT v.* FROM archive_work_heads w JOIN archive_works v ON v.id=w.id WHERE w.id=ANY($1::uuid[]) ORDER BY w.id FOR UPDATE OF w",
            [[...aliases.values()]],
          )
        ).rows,
      )),
    );
  const byId = new Map(works.map((w) => [w.id, w]));
  const byExternal = new Map(
    works.filter((w) => w.external_id).map((w) => [w.external_id, w]),
  );
  const byProvisional = new Map(
    works.filter((w) => w.provisional_key).map((w) => [w.provisional_key, w]),
  );
  const ids = [...byId.keys()];
  const selections = new Map(
    (
      await db.query(
        "SELECT * FROM archive_selection_docs WHERE work_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows.map((r) => [r.work_id, r.fields]),
  );
  const chapters = new Map(
    (
      await db.query(
        "SELECT * FROM archive_chapters WHERE work_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows.map((r) => [key(r.work_id, r.source_key), r.id]),
  );
  const revisions = new Map(
    (
      await db.query(
        "SELECT r.* FROM archive_chapter_revisions r JOIN archive_chapters c ON c.id=r.chapter_id WHERE c.work_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows.map((r) => [key(r.chapter_id, r.object_hash), r.id]),
  );
  const latest = new Map(
    (
      await db.query(
        "SELECT DISTINCT ON(work_id,state) * FROM archive_snapshots WHERE work_id=ANY($1::uuid[]) ORDER BY work_id,state,imported_at DESC,id DESC",
        [ids],
      )
    ).rows.map((r) => [key(r.work_id, r.state), r]),
  );
  const acquisition = new Set(
    (
      await db.query(
        "SELECT snapshot_id,encode(source_hash,'hex') AS hash FROM archive_record_data WHERE snapshot_id=ANY($1::uuid[])",
        [works.map((w) => w.current_snapshot_id).filter(Boolean)],
      )
    ).rows.map((r) => key(r.snapshot_id, r.hash)),
  );
  const reconciliation = new Set(
    (
      await db.query(
        "SELECT work_id,kind,detail FROM archive_reconciliations WHERE work_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows.map((r) => key(r.work_id, r.kind, canonical(r.detail).toString())),
  );
  const reconcile = (work_id: string, kind: string, detail: any) => {
    const k = key(work_id, kind, canonical(detail).toString());
    if (!reconciliation.has(k)) {
      reconciliation.add(k);
      add("reconciliations", { id: randomUUID(), work_id, kind, detail });
    }
  };
  const observations = new Map(
    (
      await db.query(
        "SELECT id,work_id,locator,parser,fingerprint FROM archive_observations WHERE source_path=$1 AND work_id=ANY($2::uuid[])",
        [source.path, ids],
      )
    ).rows.map((r) => [
      key(r.work_id, r.locator, r.parser, r.fingerprint),
      r.id,
    ]),
  );
  const cachedHashes = input.flatMap((e) =>
    e.record.objects.filter((o: any) => o.cached).map((o: any) => o.hash),
  );
  if (cachedHashes.length) {
    const found = new Set(
      (await findObjects(db, cachedHashes)).map((r) => r.hash),
    );
    if (cachedHashes.some((h) => !found.has(h)))
      throw Error("CACHE_OBJECT_MISSING");
  }
  const changed = new Map<string, any>(),
    newWorks = new Map<string, any>(),
    evidence = new Map<string, any>(),
    caches = new Set<string>();
  let duplicates = 0,
    bytes = 0;
  for (const e of input) {
    try {
      const r = e.record,
        recordKey = key(e.locator, e.parser, e.result_hash);
      bytes += e.bytes ?? 0;
      if (e.missing_dependency)
        add("dependencies", {
          id: randomUUID(),
          batch_id: source.batch_id,
          path: e.missing_dependency,
          fingerprint: "missing",
          state: "missing_source",
          gaps: 1,
          error: { index: source.path, locator: e.locator },
        });
      let record = prior.get(recordKey);
      progress.push({
        previous: e.previous,
        cursor: e.cursor,
        detail: e.checkpoint_detail ?? {},
        duplicates: record ? 1 : 0,
        bytes: e.bytes ?? 0,
        gaps: r.state === "partial" ? 1 : 0,
      });
      if (record) duplicates++;
      else {
        const provisional = source.path + ":" + (r.source_entry || e.locator);
        let w = byExternal.get(r.external_id) ?? byProvisional.get(provisional);
        const p = byProvisional.get(provisional);
        if (w && p && w.id !== p.id)
          reconcile(w.id, "identity", {
            candidates: [w.id, p.id],
            locator: e.locator,
          });
        if (
          !w ||
          (w.external_id && r.external_id && w.external_id !== r.external_id)
        ) {
          const previous = w?.id;
          w = {
            id: randomUUID(),
            external_id: r.external_id ?? null,
            provisional_key: previous ? null : provisional,
            metadata: {},
            current_snapshot_id: null,
            head_reason: "no_valid_snapshot",
          };
          newWorks.set(w.id, {
            ...w,
            provisional_path: previous ? null : source.path,
            provisional_locator: previous ? null : r.source_entry || e.locator,
          });
          byId.set(w.id, w);
          if (w.provisional_key) byProvisional.set(w.provisional_key, w);
          if (w.external_id) byExternal.set(w.external_id, w);
          if (previous)
            reconcile(w.id, "identity", {
              candidates: [previous, w.id],
              source: source.path,
              locator: e.locator,
            });
        } else if (!w.external_id && r.external_id) {
          w.external_id = r.external_id;
          byExternal.set(w.external_id, w);
          changed.set(w.id, w);
        }
        if (aliases.has(w.id)) w = byId.get(aliases.get(w.id))!;
        const refs: { name: string; kind: string; hash: string }[] = [];
        for (const o of r.objects) {
          if (o.cached) {
            refs.push({ name: o.name, kind: o.kind, hash: o.hash });
            continue;
          }
          const b = await objectBytes(o, db);
          const hash = contentHash(b);
          refs.push({ name: o.name, kind: o.kind, hash });
          await preserve(db, [{ kind: o.kind, bytes: b }]);
        }
        const normalized = e.normalized,
          confidence = r.state === "metadata_only" ? "index" : "document";
        const selected = selections.get(w.id) ?? {};
        selections.set(w.id, selected);
        const ok = key(w.id, e.locator, e.parser, e.result_hash),
          existingObservation = observations.get(ok),
          observationId = existingObservation ?? randomUUID();
        observations.set(ok, observationId);
        if (!existingObservation)
          add("observations", {
            id: observationId,
            work_id: w.id,
            source_path: source.path,
            locator: e.locator,
            parser: e.parser,
            fingerprint: e.result_hash,
            fields: normalized,
          });
        const ek = key(w.id, e.locator),
          er = evidence.get(ek) ?? {
            work_id: w.id,
            source_path: source.path,
            locator: e.locator,
            fields: {},
          };
        evidence.set(ek, er);
        const metadata = { ...normalized, ...w.metadata };
        for (const [field, value] of Object.entries(normalized)) {
          er.fields[field] ??= { observation: observationId, confidence };
          if (
            field in w.metadata &&
            !canonical(w.metadata[field]).equals(canonical(value))
          )
            reconcile(w.id, "metadata", {
              field,
              current: w.metadata[field],
              alternative: value,
              source: source.path,
              locator: e.locator,
            });
          if (
            !selected[field] ||
            (selected[field].confidence === "index" &&
              confidence === "document")
          ) {
            selected[field] = {
              confidence,
              source_path: source.path,
              locator: e.locator,
              reason: selected[field]
                ? "document_over_index"
                : "first_evidence",
            };
            metadata[field] = value;
          }
          if (metadata[field] === null || metadata[field] === "")
            metadata[field] = value;
        }
        for (const url of r.media_urls ?? [])
          add("media", { work_id: w.id, url });
        const refsByName = new Map(refs.map((o) => [o.name, o]));
        const chapterRefs = r.chapters.map((c: any) => {
          const object = refsByName.get(c.name);
          if (!object) throw Error("CHAPTER_OBJECT_MISSING");
          const ao3 = c.source_url?.match(/\/chapters\/(\d+)/)?.[1];
          const source_key =
            (ao3 ? "ao3:" + ao3 : c.source_url) ??
            "document:" + source.path + ":" + e.locator + ":" + c.name;
          const ck = key(w.id, source_key);
          let chapter_id = chapters.get(ck);
          if (!chapter_id) {
            chapter_id = randomUUID();
            chapters.set(ck, chapter_id);
            add("chapters", { id: chapter_id, work_id: w.id, source_key });
          }
          const rk = key(chapter_id, object.hash);
          let revision_id = revisions.get(rk);
          if (!revision_id) {
            revision_id = randomUUID();
            revisions.set(rk, revision_id);
            add("revisions", {
              id: revision_id,
              chapter_id,
              object_hash: object.hash,
            });
          }
          return { ...c, chapter_id, revision_id, hash: object.hash };
        });
        const manifest = {
          schema: "palimora-canonical-v1",
          work_id: w.id,
          external_id: r.external_id,
          metadata,
          chapters: chapterRefs,
          ...(r.document ? { document: r.document } : {}),
          objects: refs,
          state: r.state,
        };
        const [metadataDocument, manifestDocument] = compileManifest(manifest);
        rememberPrepared(metadataDocument);
        rememberPrepared(manifestDocument);
        const metadataHash = metadataDocument.hash,
          hash = manifestDocument.hash;
        await preserve(db, [
          { kind: "metadata", bytes: metadataDocument.bytes },
          { kind: "manifest", bytes: manifestDocument.bytes },
        ]);
        add("metadata", { hash: metadataHash });
        const lk = key(w.id, r.state),
          last = latest.get(lk);
        let snapshot = last?.manifest_hash === hash ? last.id : null;
        if (!snapshot) {
          snapshot = randomUUID();
          const s = {
            id: snapshot,
            work_id: w.id,
            manifest_hash: hash,
            state: r.state,
            observed_at: r.observed_at,
            metadata_hash: metadataHash,
            ordinal: groups.snapshots?.length ?? 0,
          };
          add("snapshots", s);
          latest.set(lk, s);
          chapterRefs.forEach((c: any, position: number) =>
            add("snapshot_chapters", {
              snapshot_id: snapshot,
              position,
              revision_id: c.revision_id,
            }),
          );
          events.push({
            event: "work.snapshot.preserved",
            payload: { work_id: w.id, snapshot_id: snapshot },
          });
        }
        const same =
          !!r.source_hash &&
          !!w.current_snapshot_id &&
          acquisition.has(key(w.current_snapshot_id, r.source_hash));
        const publish = r.state === "valid" && (!w.current_snapshot_id || same);
        if (same && r.state === "partial") {
          events.push({
            event: "work.snapshot.validation_changed",
            payload: {
              work_id: w.id,
              snapshot_id: w.current_snapshot_id,
              parser: e.parser,
              state: r.state,
            },
          });
          w.current_snapshot_id = null;
          w.head_reason = "parser_revalidation_incomplete";
        }
        if (
          r.state === "valid" &&
          w.current_snapshot_id &&
          snapshot !== w.current_snapshot_id
        )
          reconcile(w.id, "chronology", {
            current: w.current_snapshot_id,
            alternative: snapshot,
          });
        if (publish) {
          w.current_snapshot_id = snapshot;
          w.head_reason = same
            ? "parser_revalidation"
            : "first_verified_copy; chronology_unknown";
          events.push({
            event: "work.snapshot.published",
            payload: { work_id: w.id, snapshot_id: snapshot },
          });
        }
        w.metadata = metadata;
        changed.set(w.id, w);
        const rawEvidence = {
          metadata: r.metadata,
          source_hash: r.source_hash ?? null,
          observed_at: r.observed_at,
        };
        observationDocuments.push({
          schema: "palimora-observation-v1",
          work_id: w.id,
          snapshot_id: snapshot,
          manifest_hash: hash,
          source: {
            file: source.path,
            fingerprint: source.fingerprint,
            locator: e.locator,
            parser: e.parser,
          },
          evidence: rawEvidence,
        });

        record = {
          source_path: source.path,
          fingerprint: source.fingerprint,
          locator: e.locator,
          parser: e.parser,
          result_hash: e.result_hash,
          work_id: w.id,
          snapshot_id: snapshot,
          evidence: rawEvidence,
        };
        add("records", record);
        prior.set(recordKey, record);
        acquisition.add(key(snapshot, r.source_hash));
        if (r.source_hash && !caches.has(key(r.source_hash, e.parser))) {
          caches.add(key(r.source_hash, e.parser));
          add("cache", {
            source_hash: r.source_hash,
            parser: e.parser,
            record: {
              ...r,
              objects: r.objects.map((o: any, i: number) => ({
                name: o.name,
                kind: o.kind,
                hash: refs[i].hash,
                size: o.size ?? Buffer.from(o.data ?? "", "base64").length,
                cached: true,
              })),
            },
          });
        }
      }
      add("results", { source_id: source.id, ...record });
      if (r.state === "partial")
        add("issues", {
          source_id: source.id,
          locator: e.locator,
          code: "partial_content",
          detail: { issues: r.issues ?? [], parser: e.parser },
          fingerprint: source.fingerprint,
        });
    } catch (error: any) {
      error.ingestLocator = e.locator;
      throw error;
    }
  }
  groups.new_works = [...newWorks.values()];
  groups.works = [...changed.values()];
  groups.evidence = [...evidence.values()];
  groups.selections = [...changed.keys()].map((work_id) => ({
    work_id,
    fields: selections.get(work_id) ?? {},
  }));
  const observationsPrepared = await prepareDocuments(observationDocuments);
  for (const document of observationsPrepared) rememberPrepared(document);
  await preserve(
    db,
    observationsPrepared.map((d) => ({ kind: "observation", bytes: d.bytes })),
  );
  await stageRows(db, groups);
  const statements = catalogPrelude();
  const insert = (...args: Parameters<typeof insertStageSQL>) =>
    statements.push(insertStageSQL(...args));
  insert(
    "dependencies",
    "ingest_sources",
    "id uuid,batch_id uuid,path text,fingerprint text,state text,gaps bigint,error jsonb",
    "ON CONFLICT(batch_id,path) DO NOTHING",
  );
  statements.push(`INSERT INTO archive_work_heads(id,external_id,provisional_entry_id)
    SELECT r.id,r.external_id,e.id FROM ${stageTable("new_works")} r ${entryJoin("r.provisional_path", "r.provisional_locator", true)}`);
  insert(
    "metadata",
    "archive_metadata_data",
    "hash text",
    "ORDER BY hash ON CONFLICT DO NOTHING",
  );
  insert(
    "chapters",
    "archive_chapters",
    "id uuid,work_id uuid,source_key text",
  );
  insert(
    "revisions",
    "archive_revision_data",
    "id uuid,chapter_id uuid,object_hash text",
  );
  statements.push(`INSERT INTO archive_snapshot_data(id,work_id,manifest_hash,state,observed_at,metadata_hash,imported_at)
    SELECT r.id,r.work_id,decode(r.manifest_hash,'hex'),r.state,r.observed_at,decode(r.metadata_hash,'hex'),clock_timestamp()+r.ordinal*interval '1 microsecond'
    FROM ${stageTable("snapshots")} r ORDER BY ordinal`);
  insert(
    "snapshot_chapters",
    "archive_snapshot_chapters",
    "snapshot_id uuid,position integer,revision_id uuid",
  );
  statements.push(
    `UPDATE archive_work_heads w SET external_id=r.external_id,metadata_hash=p.hash,current_snapshot_id=r.current_snapshot_id,head_reason=r.head_reason,title=(r.title::jsonb)::text FROM ${stageTable("works")} r JOIN ${stageTable("payloads")} p ON p.id=r.metadata_key WHERE w.id=r.id AND (w.external_id,w.metadata_hash,w.current_snapshot_id,w.head_reason) IS DISTINCT FROM (r.external_id,p.hash,r.current_snapshot_id,r.head_reason)`,
  );
  statements.push(`INSERT INTO archive_observation_data(id,work_id,entry_id,parser_id,result_hash,payload_hash,field_ids,evidence_ids)
    SELECT r.id,r.work_id,e.id,parser.id,decode(r.fingerprint,'hex'),p.hash,coalesce(a.fields,'{}'),coalesce(a.evidence,'{}')
    FROM ${stageTable("observations")} r JOIN ${stageTable("payloads")} p ON p.id=r.metadata_key
    ${entryJoin("r.source_path", "r.locator")} JOIN archive_parsers parser ON parser.name=r.parser
    CROSS JOIN LATERAL (SELECT array_agg(f.id ORDER BY f.id) AS fields,array_agg(nextval('archive_evidence_observations_id_seq') ORDER BY f.id) AS evidence FROM jsonb_array_elements_text(r.field_names) k(name) JOIN archive_fields f ON f.name=k.name) a`);
  statements.push(`INSERT INTO archive_evidence_data(work_id,entry_id,field_ids,observation_ids,confidences)
    SELECT r.work_id,e.id,coalesce(a.fields,'{}'),coalesce(a.observations,'{}'),coalesce(a.confidences,'{}') FROM ${stageTable("evidence")} r
    ${entryJoin("r.source_path", "r.locator")}
    CROSS JOIN LATERAL (SELECT array_agg(f.id ORDER BY f.id) AS fields,array_agg((v.value->>'observation')::uuid ORDER BY f.id) AS observations,array_agg(archive_confidence_code(v.value->>'confidence') ORDER BY f.id) AS confidences FROM jsonb_each(r.fields) v JOIN archive_fields f ON f.name=v.key) a
    ON CONFLICT(work_id,entry_id) DO UPDATE SET (field_ids,observation_ids,confidences)=(SELECT * FROM archive_merge_evidence(archive_evidence_data.field_ids,archive_evidence_data.observation_ids,archive_evidence_data.confidences,excluded.field_ids,excluded.observation_ids,excluded.confidences))`);
  statements.push(selectionSQL());
  insert(
    "media",
    "archive_media_references",
    "work_id uuid,url text",
    "ON CONFLICT DO NOTHING",
  );
  insert(
    "reconciliations",
    "archive_reconciliations",
    "id uuid,work_id uuid,kind text,detail jsonb",
  );
  statements.push(`INSERT INTO archive_record_data(entry_id,origin_id,parser_id,result_hash,work_id,snapshot_id,raw_metadata_hash,source_hash,observed_at,observed_present)
    SELECT e.id,o.id,parser.id,decode(r.result_hash,'hex'),r.work_id,r.snapshot_id,p.hash,decode(r.evidence->>'source_hash','hex'),r.evidence->>'observed_at',r.evidence?'observed_at'
    FROM ${stageTable("records")} r LEFT JOIN ${stageTable("payloads")} p ON p.id=r.metadata_key
    ${entryJoin("r.source_path", "r.locator")} ${originJoin("r.source_path", "r.fingerprint")} JOIN archive_parsers parser ON parser.name=r.parser`);
  statements.push(`INSERT INTO ingest_result_data(source_id,record_id) SELECT r.source_id,a.id FROM ${stageTable("results")} r
    ${entryJoin("r.source_path", "r.locator")} ${originJoin("r.source_path", "r.fingerprint")} JOIN archive_parsers parser ON parser.name=r.parser
    JOIN LATERAL (SELECT id FROM archive_record_data WHERE origin_id=o.id AND entry_id=e.id AND parser_id=parser.id AND result_hash=decode(r.result_hash,'hex') OFFSET 0) a ON true ON CONFLICT DO NOTHING`);
  statements.push(`INSERT INTO archive_cache_data(source_hash,parser_id,raw_metadata_hash,body_hash,codec,dictionary_id,raw_size,data)
    SELECT decode(r.source_hash,'hex'),parser.id,p.hash,r.hash,r.codec::smallint,r.dictionary_id,r.raw_size,r.data FROM ${stageTable("cache")} r LEFT JOIN ${stageTable("payloads")} p ON p.id=r.metadata_key JOIN archive_parsers parser ON parser.name=r.parser
    ORDER BY r.source_hash,parser.id ON CONFLICT DO NOTHING`);
  insert(
    "issues",
    "ingest_issues",
    "source_id uuid,locator text,code text,detail jsonb,fingerprint text",
    "ON CONFLICT DO NOTHING",
  );
  // Simple-query protocol executes these ordered statements in one exchange;
  // the surrounding transaction still rolls the entire group back on failure.
  const results = (await db.query(statements.join(";"))) as unknown as {
    rowCount: number | null;
  }[];
  const issues = results[results.length - 1];
  const last = input[input.length - 1];
  if (progress.every((r) => r.previous !== undefined)) {
    afterArchiveSeal(db, () => commitProgress(db, source, progress));
    return;
  }
  await db.query(
    "UPDATE ingest_sources SET checkpoint=$2,imported=imported+$3,duplicates=duplicates+$4,bytes=bytes+$5,checkpoint_detail=$6,gaps=gaps+$7 WHERE id=$1",
    [
      source.id,
      last.cursor,
      input.length,
      duplicates,
      bytes,
      last.checkpoint_detail ?? {},
      issues.rowCount ?? 0,
    ],
  );
}
