import { DB } from "./db";
import { sha } from "./pack";
import { prepareDocuments } from "./archive-native";
const codec: {
  batch(
    input: Buffer[],
    options: number | number[],
    decode: boolean,
    dictionary?: Buffer,
  ): Promise<Buffer[]>;
  train(input: Buffer[], capacity: number): Promise<Buffer[]>;
} = require("../native/build/codec.node");
// Content-keyed cache is safe across database/schema changes and dev resets.
const dictionaries = new Map<string, Buffer>();
function retainDictionary(hash: Buffer, data: Buffer) {
  const key = hash.toString("hex");
  if (sha(data) !== key) throw Error("CATALOG_DICTIONARY_HASH");
  if (dictionaries.size >= 16)
    dictionaries.delete(dictionaries.keys().next().value!);
  dictionaries.set(key, data);
  return data;
}
async function dictionary(db: DB, family: string, samples: Buffer[]) {
  let row = (
    await db.query("SELECT id,hash FROM archive_dictionaries WHERE family=$1", [
      family,
    ])
  ).rows[0];
  if (!row) {
    const chosen: Buffer[] = [];
    let total = 0;
    for (const sample of samples) {
      if (chosen.length === 256 || total + sample.length > 2 * 1024 * 1024)
        break;
      chosen.push(sample);
      total += sample.length;
    }
    if (chosen.length < 64 || total < 32768) return null;
    // Only one transaction trains a family. Other writers use ordinary Zstd
    // until that dictionary commits, avoiding a catalog-wide startup queue.
    if (
      !(
        await db.query(
          "SELECT pg_try_advisory_xact_lock(70210406,hashtext($1)) AS yes",
          [family],
        )
      ).rows[0].yes
    )
      return null;
    row = (
      await db.query(
        "SELECT id,hash FROM archive_dictionaries WHERE family=$1",
        [family],
      )
    ).rows[0];
    if (!row) {
      const trained = (
        await codec.train(chosen, Math.min(65536, Math.floor(total / 8)))
      )[0];
      if (!trained) return null;
      // The unique family resolves concurrent initial training; use the winner's
      // bytes, never compress with a losing transaction's proposed dictionary.
      await db.query(
        "INSERT INTO archive_dictionaries(family,hash,data) VALUES($1,$2,$3) ON CONFLICT(family) DO NOTHING",
        [family, Buffer.from(sha(trained), "hex"), trained],
      );
      row = (
        await db.query(
          "SELECT id,hash,data FROM archive_dictionaries WHERE family=$1",
          [family],
        )
      ).rows[0];
      retainDictionary(row.hash, row.data);
    }
  }
  let data = dictionaries.get(row.hash.toString("hex"));
  if (!data) {
    const found = (
      await db.query("SELECT data FROM archive_dictionaries WHERE id=$1", [
        row.id,
      ])
    ).rows[0];
    data = retainDictionary(row.hash, found.data);
  }
  return { id: row.id, data };
}
export async function encodeCatalog(
  db: DB,
  family: "metadata" | "cache",
  values: unknown[],
) {
  if (!values.length) return [];
  const docs = await prepareDocuments(values);
  const dict = await dictionary(
    db,
    family,
    docs.map((d) => d.bytes),
  );
  const result: {
    hash: string;
    codec: number;
    dictionary_id: number | null;
    raw_size: number;
    data: string;
  }[] = [];
  for (let start = 0; start < docs.length; start += 256) {
    const batch = docs.slice(start, start + 256);
    const input = batch.map((d) => d.bytes);
    const compressed = dict
      ? await codec.batch(input, 3, false, dict.data)
      : await codec.batch(input, 3, false);
    batch.forEach((doc, i) => {
      const use = compressed[i].length < doc.bytes.length;
      result.push({
        hash: doc.hash,
        codec: use ? 1 : 0,
        dictionary_id: use ? (dict?.id ?? null) : null,
        raw_size: doc.bytes.length,
        data: (use ? compressed[i] : doc.bytes).toString("hex"),
      });
    });
  }
  return result;
}
async function decodeCatalog(db: DB, rows: any[], hashField = "hash") {
  const ids = [
    ...new Set(rows.map((r) => r.dictionary_id).filter((x) => x != null)),
  ];
  const byId = new Map<number, Buffer>();
  if (ids.length) {
    const names = (
      await db.query(
        "SELECT id,hash FROM archive_dictionaries WHERE id=ANY($1::int[])",
        [ids],
      )
    ).rows;
    if (names.length !== ids.length) throw Error("CATALOG_DICTIONARY_MISSING");
    const missing = names.filter(
      (r) => !dictionaries.has(r.hash.toString("hex")),
    );
    if (missing.length)
      for (const d of (
        await db.query(
          "SELECT hash,data FROM archive_dictionaries WHERE id=ANY($1::int[])",
          [missing.map((r) => r.id)],
        )
      ).rows)
        retainDictionary(d.hash, d.data);
    for (const d of names)
      byId.set(d.id, dictionaries.get(d.hash.toString("hex"))!);
  }
  const values = new Map<string, any>();
  for (const group of [
    ...new Set(rows.map((r) => `${r.codec}:${r.dictionary_id ?? 0}`)),
  ]) {
    const all = rows.filter(
      (r) => `${r.codec}:${r.dictionary_id ?? 0}` === group,
    );
    for (let start = 0; start < all.length; start += 256) {
      const batch = all.slice(start, start + 256);
      const input = batch.map((r) => r.data as Buffer);
      const d = byId.get(batch[0].dictionary_id);
      const bytes =
        batch[0].codec === 0
          ? input
          : d
            ? await codec.batch(
                input,
                batch.map((r) => r.raw_size),
                true,
                d,
              )
            : await codec.batch(
                input,
                batch.map((r) => r.raw_size),
                true,
              );
      bytes.forEach((b, i) => {
        const hash = batch[i][hashField].toString("hex");
        if (b.length !== batch[i].raw_size || sha(b) !== hash)
          throw Error("CATALOG_PAYLOAD_HASH");
        values.set(hash, JSON.parse(b.toString("utf8")));
      });
    }
  }
  return values;
}
export async function readPayloads(db: DB, hashes: Buffer[]) {
  const ids = [
    ...new Map(
      hashes.filter(Boolean).map((h) => [h.toString("hex"), h]),
    ).values(),
  ];
  if (!ids.length) return new Map<string, any>();
  const rows = (
    await db.query(
      "SELECT * FROM archive_payloads WHERE hash=ANY($1::bytea[])",
      [ids],
    )
  ).rows;
  if (rows.length !== ids.length) throw Error("CATALOG_PAYLOAD_MISSING");
  return decodeCatalog(db, rows);
}
export async function hydrateWorks(db: DB, rows: any[]) {
  const values = await readPayloads(
    db,
    rows.map((r) => r.metadata_hash),
  );
  return rows.map(({ metadata_hash, title, ...row }) => ({
    ...row,
    metadata: values.get(metadata_hash.toString("hex")),
  }));
}
export async function hydrateEvidence(db: DB, rows: any[]) {
  const values = await readPayloads(
    db,
    rows.map((r) => r.payload_hash),
  );
  return rows.map(({ payload_hash, ...row }) => ({
    ...row,
    value: values.get(payload_hash.toString("hex"))[row.field],
  }));
}
export async function readParseCache(db: DB, parser: string, hashes: string[]) {
  const rows = (
    await db.query(
      "SELECT c.*,encode(c.source_hash,'hex') AS source_key FROM archive_cache_data c JOIN archive_parsers p ON p.id=c.parser_id WHERE p.name=$1 AND c.source_hash=ANY($2::bytea[])",
      [parser, hashes.map((h) => Buffer.from(h, "hex"))],
    )
  ).rows;
  const bodies = await decodeCatalog(db, rows, "body_hash");
  const metadata = await readPayloads(
    db,
    rows.map((r) => r.raw_metadata_hash),
  );
  return rows.map((r) => ({
    source_hash: r.source_key,
    record: {
      ...bodies.get(r.body_hash.toString("hex")),
      ...(r.raw_metadata_hash
        ? { metadata: metadata.get(r.raw_metadata_hash.toString("hex")) }
        : {}),
    },
  }));
}
export async function internPayload(db: DB, value: unknown) {
  const [p] = await encodeCatalog(db, "metadata", [value]);
  await db.query(
    "INSERT INTO archive_payloads(hash,codec,dictionary_id,raw_size,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [
      Buffer.from(p.hash, "hex"),
      p.codec,
      p.dictionary_id,
      p.raw_size,
      Buffer.from(p.data, "hex"),
    ],
  );
  return Buffer.from(p.hash, "hex");
}
export const objectProjection =
  "encode(o.hash,'hex') AS hash,p.name AS pack,o.byte_offset,o.length,o.size,k.name AS kind";
export const objectFrom =
  "archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id";
export async function findObjects(db: DB, hashes: string[]) {
  return (
    await db.query(
      `SELECT ${objectProjection} FROM ${objectFrom} WHERE o.hash=ANY($1::bytea[]) ORDER BY o.hash`,
      [hashes.map((h) => Buffer.from(h, "hex"))],
    )
  ).rows;
}
