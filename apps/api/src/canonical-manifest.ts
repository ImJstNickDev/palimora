import { resolveCanonical } from "@palimora/archive-format";
import { readObjectBatches } from "./archive";
import { DB } from "./db";

/** One batched dependency lookup; historical metadata never falls back to the head. */
export async function resolveManifests(db: DB, manifests: Map<string, any>) {
  const hashes = [
    ...new Set(
      [...manifests.values()]
        .filter(
          (m) => !(m instanceof Error) && m?.schema === "palimora-canonical-v2",
        )
        .map((m) => m.metadata_hash),
    ),
  ];
  const objects = new Map<string, Buffer>();
  for await (const { hash, bytes } of readObjectBatches(db, hashes))
    objects.set(hash, bytes);
  for (const [hash, manifest] of manifests) {
    if (!(manifest instanceof Error))
      manifests.set(hash, resolveCanonical(manifest, objects));
  }
  return manifests;
}
export async function readManifest(db: DB, hash: string) {
  const manifests = new Map<string, any>();
  for await (const item of readObjectBatches(db, [hash]))
    manifests.set(item.hash, JSON.parse(item.bytes.toString()));
  if (!manifests.has(hash)) throw Error("MANIFEST_MISSING");
  return (await resolveManifests(db, manifests)).get(hash);
}
