/** JSON-domain only: inputs are plain parser/catalog documents, not classes with
 * toJSON hooks. Native code preserves JSON.stringify's scalar representation. */
const native: {
  prepare(input: Buffer, mode: number): Promise<any[]>;
  compile(input: Buffer): PreparedDocument[];
} = require("../native/build/codec.node");
export interface PreparedDocument {
  bytes: Buffer;
  hash: string;
}
function encode(value: unknown) {
  // Keep V8's fast serializer; a replacer disables its fast path for every field.
  const validate = (v: any, depth: number): void => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw Error("CANONICAL_NUMBER");
    if (v && typeof v === "object") {
      if (depth > 256) throw Error("CATALOG_JSON_DEPTH");
      if (typeof v.toJSON === "function") throw Error("CATALOG_JSON_DOMAIN");
      if (Array.isArray(v)) {
        for (const item of v) validate(item, depth + 1);
      } else {
        for (const key of Object.keys(v)) validate(v[key], depth + 1);
      }
    }
  };
  validate(value, 0);
  return Buffer.from(JSON.stringify(value));
}
export function prepareDocuments(
  values: unknown[],
): Promise<PreparedDocument[]> {
  return native.prepare(encode(values), 1);
}
export async function documentHashes(values: unknown[]): Promise<string[]> {
  return (await native.prepare(encode(values), 0)).map((d) => d.hash);
}
export function compileManifest(
  value: unknown,
): [PreparedDocument, PreparedDocument] {
  return native.compile(encode(value)) as [PreparedDocument, PreparedDocument];
}
export function prepareCopy(
  tables: { columns: string[][]; rows: any[] }[],
): Promise<Buffer[]> {
  return native.prepare(encode(tables), 2);
}

/** Select compact encoding only when it saves physical payload bytes at level 3. */
export async function compileStorageManifest(
  value: any,
): Promise<[PreparedDocument, PreparedDocument]> {
  const docs = compileManifest(value);
  if (
    value.state === "metadata_only" &&
    !value.chapters.length &&
    !value.objects.length &&
    !value.document
  ) {
    const [unified] = await prepareDocuments([
      { ...value, schema: "palimora-canonical-metadata-v1" },
    ]);
    // One immutable object is both metadata revision and snapshot manifest.
    return [unified, unified];
  }
  const compact = JSON.parse(docs[1].bytes.toString());
  const references = new Map<string, number>(
    compact.objects.map((o: any, i: number) => [o.name + ":" + o.hash, i]),
  );
  compact.chapters = compact.chapters.map((c: any) => {
    const index =
      references.get((c.source_object ?? c.name) + ":" + c.hash) ?? -1;
    if (index < 0 || c.source_object) return c;
    const { hash, name, ...rest } = c;
    return { ...rest, object_ref: index };
  });
  const [candidate] = await prepareDocuments([compact]);
  const codec = require("../native/build/codec.node");
  const compressed = await codec.batch(
    [docs[1].bytes, candidate.bytes],
    Number(process.env.ARCHIVE_ZSTD_LEVEL ?? 3),
    false,
  );
  if (compressed[1].length + 32 < compressed[0].length) docs[1] = candidate;
  return docs;
}
