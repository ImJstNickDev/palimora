/** Bounded offline recoding of a sealed fixture. Never opens a database or dump. */
import {
  open,
  readdir,
  mkdir,
  writeFile,
  stat,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, sha, PackStore } from "../apps/api/src/pack";
import { compileStorageManifest } from "../apps/api/src/archive-native";
import { resolveCanonical, textChapter } from "@palimora/archive-format";
const codec = require("../apps/api/native/build/codec.node");
async function main() {
  const [source, destination, txtFixture] = process.argv.slice(2);
  if (
    !source ||
    !destination ||
    !txtFixture ||
    resolve(source) === resolve(destination)
  )
    throw Error("ARGUMENTS");
  await mkdir(destination, { recursive: false });
  const parsed = spawnSync(
    "python3",
    [
      "-c",
      `import sys,zipfile,json,hashlib\nsys.path.insert(0,'apps/ingest-adapters')\nimport ao3\nout={}\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for n in z.namelist():\n  if n.lower().endswith('.txt'):\n   b=z.read(n);r=ao3.text_record(b);out[hashlib.sha256(b).hexdigest()]=r['chapters'][0]\nprint(json.dumps(out))`,
      txtFixture,
    ],
    {
      env: { ...process.env, PALIMORA_HTML_SCANNER: "python" },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (parsed.status) throw Error(parsed.stderr.toString());
  const recipes = JSON.parse(parsed.stdout.toString());
  const objects = new Map<string, { kind: string; bytes: Buffer }>();
  let baselinePhysical = 0,
    baselineRecords = 0;
  for (const name of await readdir(source, { recursive: true })) {
    if (!name.endsWith(".pmpack")) continue;
    const f = await open(join(source, name), "r");
    try {
      const size = (await f.stat()).size;
      baselinePhysical += size;
      let offset = 8;
      while (offset < size) {
        const prefix = Buffer.alloc(4);
        await f.read(prefix, 0, 4, offset);
        const length = prefix.readUInt32LE();
        if (length > 65536) throw Error("HEADER");
        const header = Buffer.alloc(length);
        await f.read(header, 0, length, offset + 4);
        const h = JSON.parse(header.toString());
        const payload = Buffer.alloc(h.length);
        await f.read(payload, 0, h.length, offset + 4 + length);
        offset += 4 + length + h.length;
        if (sha(payload) !== h.checksum) throw Error("CHECKSUM");
        const bytes =
          h.codec === "raw"
            ? payload
            : (await codec.batch([payload], [h.size], true))[0];
        if (bytes.length !== h.size || sha(bytes) !== h.hash)
          throw Error("HASH");
        baselineRecords++;
        objects.set(h.hash, { kind: h.kind, bytes });
      }
    } finally {
      await f.close();
    }
  }
  const report: any = {
    protocol:
      "offline fixture recoding, same Zstd 3; production PackStore writer and seal per variant, no SQL/ingest timing claim",
    baseline_source_physical_bytes: baselinePhysical,
    baseline_records: baselineRecords,
    baseline_duplicate_records: baselineRecords - objects.size,
    variants: {},
  };
  for (const variant of ["A", "B", "C", "D"]) {
    const started = performance.now(),
      cpu = process.cpuUsage();
    const output = new Map(objects),
      replacements = new Map<string, string>(),
      removedMetadata = new Set<string>(),
      keptMetadata = new Set<string>();
    for (const [hash, o] of objects) {
      if (o.kind !== "manifest") continue;
      const m = JSON.parse(o.bytes.toString());
      if (m.schema !== "palimora-canonical-v1") continue;
      if (variant !== "A") {
        const sourceRef = m.objects.find((r: any) => r.kind === "source_text");
        if (sourceRef && recipes[sourceRef.hash]) {
          const recipe = recipes[sourceRef.hash];
          for (const c of m.chapters) {
            const old = objects.get(c.hash);
            if (!old) throw Error("MISSING");
            const updated = { ...c, ...recipe, hash: sourceRef.hash };
            const rebuilt = textChapter(
              objects.get(sourceRef.hash)!.bytes,
              updated,
            );
            if (!rebuilt.equals(old.bytes)) throw Error("TXT_MISMATCH");
            output.delete(c.hash);
            Object.assign(c, updated);
          }
          m.objects = m.objects.filter((r: any) => r.kind !== "chapter_html");
        }
      }
      let bytes: Buffer;
      if (variant === "C" || variant === "D") {
        const metadataHash = m.metadata_hash;
        delete m.metadata_hash;
        m.schema = "palimora-canonical-v2";
        if (variant === "D") {
          const [md, manifest] = await compileStorageManifest(m);
          bytes = manifest.bytes;
          output.set(md.hash, { kind: "metadata", bytes: md.bytes });
          if (md.hash === manifest.hash) removedMetadata.add(metadataHash);
          else keptMetadata.add(metadataHash);
          const logical = resolveCanonical(
            JSON.parse(bytes.toString()),
            new Map([[md.hash, md.bytes]]),
          );
          if (JSON.stringify(logical.metadata) !== JSON.stringify(m.metadata))
            throw Error("METADATA");
        } else {
          delete m.metadata;
          m.metadata_hash = metadataHash;
          bytes = canonical(m);
        }
      } else bytes = canonical(m);
      const newHash = sha(bytes);
      replacements.set(hash, newHash);
      output.delete(hash);
      output.set(newHash, {
        kind:
          variant === "D" && m.state === "metadata_only"
            ? "metadata"
            : "manifest",
        bytes,
      });
    }
    for (const hash of removedMetadata)
      if (!keptMetadata.has(hash)) output.delete(hash);
    for (const [hash, o] of objects) {
      if (o.kind !== "observation") continue;
      const doc = JSON.parse(o.bytes.toString());
      if (!replacements.has(doc.manifest_hash)) continue;
      doc.manifest_hash = replacements.get(doc.manifest_hash);
      const bytes = canonical(doc);
      output.delete(hash);
      output.set(sha(bytes), { kind: o.kind, bytes });
    }
    const kinds: any = {},
      metrics = new Map<string, any>();
    let physical = 0,
      payloadBytes = 0,
      raw = 0,
      allocated = 0;
    const writer = new PackStore(join(destination, variant));
    await writer.write([...output.values()]);
    for (const name of await readdir(join(destination, variant, "packs"))) {
      const path = join(destination, variant, "packs", name);
      const bytes = await readFile(path),
        st = await stat(path);
      physical += st.size;
      allocated += st.blocks * 512;
      let offset = 8;
      while (offset < bytes.length) {
        const n = bytes.readUInt32LE(offset),
          h = JSON.parse(bytes.subarray(offset + 4, offset + 4 + n).toString());
        const metric = {
          kind: h.kind,
          raw: h.size,
          payload: h.length,
          physical: 4 + n + h.length,
        };
        metrics.set(h.hash, metric);
        raw += h.size;
        payloadBytes += h.length;
        const k = (kinds[h.kind] ??= {
          objects: 0,
          raw: 0,
          payload: 0,
          physical: 0,
        });
        k.objects++;
        k.raw += h.size;
        k.payload += h.length;
        k.physical += metric.physical;
        offset += metric.physical;
      }
      if (offset !== bytes.length) throw Error("SIZE");
    }
    const categories: any = {};
    for (const [hash, o] of output) {
      if (o.kind !== "observation") continue;
      const observation = JSON.parse(o.bytes.toString());
      const category = String(observation.source.file).split("/").pop();
      const group = (categories[category] ??= {
        hashes: new Set<string>(),
        works: new Set<string>(),
        snapshots: new Set<string>(),
        acquisitions: 0,
      });
      group.acquisitions++;
      group.works.add(observation.work_id);
      group.snapshots.add(observation.snapshot_id);
      group.hashes.add(hash);
      group.hashes.add(observation.manifest_hash);
      const manifest = JSON.parse(
        output.get(observation.manifest_hash)!.bytes.toString(),
      );
      if (manifest.metadata_hash) group.hashes.add(manifest.metadata_hash);
      for (const ref of manifest.objects ?? []) group.hashes.add(ref.hash);
      for (const h of group.hashes) {
        const obj = output.get(h);
        if (obj?.kind === "chunk_manifest")
          for (const chunk of JSON.parse(obj.bytes.toString()).chunks)
            group.hashes.add(chunk.hash);
      }
    }
    for (const [key, group] of Object.entries(categories) as any) {
      const kinds: any = {};
      let physical = 0,
        raw = 0,
        payload = 0;
      for (const hash of group.hashes) {
        const metric = metrics.get(hash);
        if (!metric) throw Error("CATEGORY_REFERENCE");
        physical += metric.physical;
        raw += metric.raw;
        payload += metric.payload;
        const k = (kinds[metric.kind] ??= {
          objects: 0,
          physical: 0,
          raw: 0,
          payload: 0,
        });
        k.objects++;
        k.physical += metric.physical;
        k.raw += metric.raw;
        k.payload += metric.payload;
      }
      categories[key] = {
        objects: group.hashes.size,
        works: group.works.size,
        snapshots: group.snapshots.size,
        acquisitions: group.acquisitions,
        physical,
        raw,
        payload,
        kinds,
      };
    }
    report.variants[variant] = {
      categories,
      objects: output.size,
      raw,
      payload: payloadBytes,
      header: physical - payloadBytes,
      physical,
      allocated,
      kinds,
      seconds: (performance.now() - started) / 1000,
      cpu: process.cpuUsage(cpu),
      max_rss_kib: process.resourceUsage().maxRSS,
    };
  }
  await writeFile(
    join(destination, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
