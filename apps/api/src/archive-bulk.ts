import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DB } from "./db";
import { encodeCatalog } from "./archive-catalog";
import { prepareCopy } from "./archive-native";

// Logical row schemas are projected onto a compact typed transport relation.
const definitions: Record<string, string> = {
  payloads:
    "id integer,hash bytea,codec integer,dictionary_id integer,raw_size integer,data bytea",
  paths: "path text",
  entries: "path text,locator text",
  origins: "path text,fingerprint text",
  parsers: "name text",
  fields: "name text",
  reasons: "name text",
  dependencies:
    "id uuid,batch_id uuid,path text,fingerprint text,state text,gaps bigint,error jsonb",
  new_works:
    "id uuid,external_id text,provisional_path text,provisional_locator text",
  works:
    "id uuid,external_id text,metadata_key integer,current_snapshot_id uuid,head_reason text,title text",
  metadata: "hash text",
  chapters: "id uuid,work_id uuid,source_key text",
  revisions: "id uuid,chapter_id uuid,object_hash text",
  snapshots:
    "id uuid,work_id uuid,manifest_hash text,state text,observed_at timestamptz,metadata_hash text,ordinal integer",
  snapshot_chapters: "snapshot_id uuid,position integer,revision_id uuid",
  observations:
    "id uuid,work_id uuid,source_path text,locator text,parser text,fingerprint text,metadata_key integer,field_names jsonb",
  evidence: "work_id uuid,source_path text,locator text,fields jsonb",
  selections: "work_id uuid,fields jsonb",
  media: "work_id uuid,url text",
  reconciliations: "id uuid,work_id uuid,kind text,detail jsonb",
  records:
    "source_path text,fingerprint text,locator text,parser text,result_hash text,work_id uuid,snapshot_id uuid,evidence jsonb,metadata_key integer",
  results:
    "source_id uuid,source_path text,fingerprint text,locator text,parser text,result_hash text,work_id uuid,snapshot_id uuid",
  cache:
    "source_hash text,parser text,metadata_key integer,hash bytea,codec integer,dictionary_id integer,raw_size integer,data bytea",
  issues: "source_id uuid,locator text,code text,detail jsonb,fingerprint text",
};
const schemas = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => [
    name,
    definition.split(",").map((column) => column.split(" ")),
  ]),
);
// Reuse slots of the same PostgreSQL type across row kinds: one COPY stream,
// compact typed columns instead of a wide sparse relation.
const prefixes: Record<string, string> = {
  uuid: "u",
  text: "t",
  integer: "i",
  bigint: "b",
  timestamptz: "d",
  jsonb: "j",
  bytea: "x",
};
const slots: Record<string, string> = { _group: "text" };
const projections = Object.fromEntries(
  Object.entries(schemas).map(([kind, columns]) => {
    const count: Record<string, number> = {};
    return [
      kind,
      columns.map(([name, type]) => {
        const slot = prefixes[type] + (count[type] ?? 0);
        count[type] = (count[type] ?? 0) + 1;
        slots[slot] = type;
        return { name, type, slot };
      }),
    ];
  }),
);
export function stageTable(kind: string) {
  if (!(kind in definitions)) throw Error("STAGE_KIND");
  return `(SELECT ${projections[kind].map(({ name, slot }) => slot + " AS " + name).join(",")} FROM palimora_ingest_stage WHERE _group='${kind}')`;
}
// Parser timestamps are ISO-8601; keep all six PostgreSQL fractional digits.
export function timestampMicros(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw Error("COPY_TIMESTAMP");
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    !year ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    throw Error("COPY_TIMESTAMP");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw Error("COPY_TIMESTAMP");
  const fraction = (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  return (
    BigInt(ms - 946684800000) * 1000n +
    BigInt(fraction.slice(3))
  ).toString();
}
export async function stageRows(db: DB, input: Record<string, any[]>) {
  const rows: any[] = [];
  const payloads: { id: number; value: unknown }[] = [];
  const byObject = new WeakMap<object, number>(),
    byValue = new Map<string, number>();
  function intern(value: unknown) {
    if (value === undefined) return null;
    if (value && typeof value === "object") {
      const known = byObject.get(value);
      if (known !== undefined) return known;
    }
    const serialized = JSON.stringify(value);
    let id = byValue.get(serialized);
    if (id === undefined) {
      id = payloads.length;
      payloads.push({ id, value });
      byValue.set(serialized, id);
    }
    if (value && typeof value === "object") byObject.set(value, id);
    return id;
  }
  const projectedGroups: Record<string, any[]> = {};
  const entries = new Map<string, { path: string; locator: string }>(),
    paths = new Set<string>(),
    parsers = new Set<string>(),
    fields = new Set<string>(),
    reasons = new Set<string>();
  const origins = new Map<string, { path: string; fingerprint: string }>();
  const entry = (path: string | null, locator: string | null) => {
    if (path != null && locator != null) {
      paths.add(path);
      entries.set(JSON.stringify([path, locator]), { path, locator });
    }
  };
  for (const [kind, records] of Object.entries(input)) {
    if (!(kind in schemas)) throw Error("STAGE_KIND");
    projectedGroups[kind] = records.map((original) => {
      let r = original;
      if (kind === "works") {
        const { metadata, ...body } = r;
        r = {
          ...body,
          metadata_key: intern(metadata),
          title: JSON.stringify(metadata.title ?? metadata.Title) ?? null,
        };
      }
      if (kind === "observations") {
        const { fields: values, ...body } = r;
        const names = Object.keys(values);
        names.forEach((n) => fields.add(n));
        r = { ...body, metadata_key: intern(values), field_names: names };
      }
      if (kind === "records" || kind === "cache") {
        const field = kind === "records" ? "evidence" : "record";
        const { metadata, ...body } = r[field];
        r = { ...r, [field]: body, metadata_key: intern(metadata) };
      }
      if (kind === "records") {
        paths.add(r.source_path);
        origins.set(JSON.stringify([r.source_path, r.fingerprint]), {
          path: r.source_path,
          fingerprint: r.fingerprint,
        });
      }
      if (r.parser != null) parsers.add(r.parser);
      if (r.source_path != null && r.locator != null)
        entry(r.source_path, r.locator);
      if (kind === "new_works")
        entry(r.provisional_path, r.provisional_locator);
      if (kind === "evidence")
        Object.keys(r.fields).forEach((f) => fields.add(f));
      if (kind === "selections")
        for (const [name, v] of Object.entries(r.fields) as [string, any][]) {
          fields.add(name);
          entry(v.source_path, v.locator);
          reasons.add(v.reason);
        }
      return r;
    });
  }
  const encoded = await encodeCatalog(
    db,
    "metadata",
    payloads.map((p) => p.value),
  );
  projectedGroups.payloads = encoded.map((p, i) => ({ id: i, ...p }));
  const caches = projectedGroups.cache ?? [];
  const encodedCache = await encodeCatalog(
    db,
    "cache",
    caches.map((r) => r.record),
  );
  projectedGroups.cache = caches.map((r, i) => ({ ...r, ...encodedCache[i] }));
  projectedGroups.paths = [...paths].map((path) => ({ path }));
  projectedGroups.entries = [...entries.values()];
  projectedGroups.origins = [...origins.values()];
  for (const [kind, values] of [
    ["parsers", parsers],
    ["fields", fields],
    ["reasons", reasons],
  ] as const)
    projectedGroups[kind] = [...values].map((name) => ({ name }));
  for (const [kind, records] of Object.entries(projectedGroups))
    for (const r of records) {
      const projected: Record<string, unknown> = { _group: kind };
      for (const { name, type, slot } of projections[kind])
        if (r[name] != null)
          projected[slot] =
            type === "timestamptz" ? timestampMicros(r[name]) : r[name];
      rows.push(projected);
    }
  const [buffer] = await prepareCopy([
    {
      columns: Object.entries(slots).map(([name, type]) => [
        name,
        type === "jsonb" ? "jsonb_value" : type,
      ]),
      rows,
    },
  ]);
  await db.query(
    `CREATE TEMP TABLE IF NOT EXISTS palimora_ingest_stage(${Object.entries(
      slots,
    )
      .map(([name, type]) => name + " " + type)
      .join(
        ",",
      )}) ON COMMIT DELETE ROWS; CREATE INDEX IF NOT EXISTS palimora_stage_payload_id ON palimora_ingest_stage(i0) WHERE _group='payloads'`,
  );
  const { from } = require("pg-copy-streams");
  await pipeline(
    Readable.from([buffer]),
    db.query(
      from(
        `COPY palimora_ingest_stage(${Object.keys(slots).join(",")}) FROM STDIN (FORMAT binary)`,
      ),
    ) as any,
  );
  // TEMP relations are invisible to autovacuum. Fresh row-kind statistics keep
  // dictionary/provenance joins proportional to this group rather than the corpus.
  await db.query("ANALYZE palimora_ingest_stage (_group,i0)");
}
export function insertStageSQL(
  kind: string,
  table: string,
  definition: string,
  suffix = "",
) {
  const names = definition
    .split(",")
    .map((column) => column.trim().split(/\s+/)[0])
    .join(",");
  const binary =
    table === "archive_metadata_data"
      ? new Set(["hash"])
      : table === "archive_revision_data"
        ? new Set(["object_hash"])
        : new Set<string>();
  const selected = names
    .split(",")
    .map((name) => (binary.has(name) ? `decode(${name},'hex')` : name))
    .join(",");
  return `INSERT INTO ${table}(${names}) SELECT ${selected} FROM ${stageTable(kind)} ${suffix}`;
}
export function catalogPrelude() {
  return [
    `INSERT INTO archive_paths(path) SELECT path FROM ${stageTable("paths")} ORDER BY path ON CONFLICT DO NOTHING`,
    `INSERT INTO archive_origins(path_id,fingerprint) SELECT p.id,r.fingerprint FROM ${stageTable("origins")} r JOIN archive_paths p ON p.path=r.path ORDER BY p.id,r.fingerprint ON CONFLICT DO NOTHING`,
    `INSERT INTO archive_entries(path_id,locator) SELECT p.id,r.locator FROM ${stageTable("entries")} r JOIN archive_paths p ON p.path=r.path ORDER BY p.id,r.locator ON CONFLICT DO NOTHING`,
    ...["parsers", "fields", "reasons"].map(
      (kind) =>
        `INSERT INTO archive_${kind}(name) SELECT name FROM ${stageTable(kind)} ORDER BY name ON CONFLICT DO NOTHING`,
    ),
    `INSERT INTO archive_payloads(hash,codec,dictionary_id,raw_size,data) SELECT DISTINCT ON(hash) hash,codec::smallint,dictionary_id,raw_size,data FROM ${stageTable("payloads")} ORDER BY hash ON CONFLICT DO NOTHING`,
  ];
}
// These bounded correlated lookups prevent empty-catalog estimates from choosing
// scans of every entry/acquisition in a source for each incoming record.
export function entryJoin(path: string, locator: string, left = false) {
  return `${left ? "LEFT" : "INNER"} JOIN LATERAL (SELECT id FROM archive_entries WHERE path_id=(SELECT id FROM archive_paths WHERE path=${path}) AND locator=${locator} OFFSET 0) e ON true`;
}
export function originJoin(path: string, fingerprint: string) {
  return `JOIN LATERAL (SELECT id FROM archive_origins WHERE path_id=(SELECT id FROM archive_paths WHERE path=${path}) AND fingerprint=${fingerprint} OFFSET 0) o ON true`;
}
export function selectionSQL() {
  return `INSERT INTO archive_selection_data(work_id,field_ids,entry_ids,confidences,reason_ids)
  SELECT r.work_id,coalesce(a.fields,'{}'),coalesce(a.entries,'{}'),coalesce(a.confidences,'{}'),coalesce(a.reasons,'{}')
  FROM ${stageTable("selections")} r CROSS JOIN LATERAL (
    SELECT array_agg(f.id ORDER BY f.id) AS fields,array_agg(e.id ORDER BY f.id) AS entries,
    array_agg(archive_confidence_code(v.value->>'confidence') ORDER BY f.id) AS confidences,array_agg(reason.id ORDER BY f.id) AS reasons
    FROM jsonb_each(r.fields) v JOIN archive_fields f ON f.name=v.key ${entryJoin("v.value->>'source_path'", "v.value->>'locator'")} JOIN archive_reasons reason ON reason.name=v.value->>'reason'
  ) a ON CONFLICT(work_id) DO UPDATE SET field_ids=excluded.field_ids,entry_ids=excluded.entry_ids,confidences=excluded.confidences,reason_ids=excluded.reason_ids
  WHERE (archive_selection_data.field_ids,archive_selection_data.entry_ids,archive_selection_data.confidences,archive_selection_data.reason_ids) IS DISTINCT FROM (excluded.field_ids,excluded.entry_ids,excluded.confidences,excluded.reason_ids)`;
}
