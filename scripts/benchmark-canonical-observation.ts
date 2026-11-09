import { readdir, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PackStore, canonical, sha } from "../apps/api/src/pack";
async function main() {
  const [source, dest] = process.argv.slice(2);
  await mkdir(dest, { recursive: false });
  const reader = new PackStore(source),
    output = new Map<string, { kind: string; bytes: Buffer }>();
  let original = 0,
    observations = 0;
  for (const name of await readdir(source, { recursive: true })) {
    if (!name.endsWith(".pmpack")) continue;
    const file = await readFile(join(source, name));
    let offset = 8;
    while (offset < file.length) {
      const length = file.readUInt32LE(offset),
        h = JSON.parse(
          file.subarray(offset + 4, offset + 4 + length).toString(),
        ),
        frame = 4 + length + h.length;
      if (h.kind === "observation") {
        const bytes = await reader.read(
            { ...h, pack: name, offset, length: frame },
            source,
          ),
          doc = JSON.parse(bytes.toString());
        if (String(doc.source?.file).endsWith(".sqlite3")) {
          original += frame;
          observations++;
          const raw = canonical({
              schema: "palimora-source-metadata-v1",
              metadata: doc.evidence.metadata,
            }),
            hash = sha(raw);
          delete doc.evidence.metadata;
          doc.evidence.metadata_hash = hash;
          output.set(hash, { kind: "source_metadata", bytes: raw });
          const observation = canonical(doc);
          output.set(sha(observation), {
            kind: "observation",
            bytes: observation,
          });
        }
      }
      offset += frame;
    }
  }
  const store = new PackStore(dest);
  await store.write([...output.values()]);
  let physical = 0;
  for (const file of await readdir(join(dest, "packs")))
    physical += (await stat(join(dest, "packs", file))).size;
  const report = {
    observations,
    original_observation_physical: original,
    shared_payload_alternative_objects: output.size,
    shared_payload_alternative_physical: physical,
    delta: physical - original,
    adopted: false,
  };
  await writeFile(join(dest, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
