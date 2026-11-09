import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PackStore } from "../apps/api/src/pack";
import { textChapter } from "@palimora/archive-format";
async function main() {
  const [root] = process.argv.slice(2);
  async function index(variant: string) {
    const directory = join(root, variant, "packs"),
      reader = new PackStore(join(root, variant)),
      locators = new Map<string, any>(),
      manifests = new Map<string, any>();
    for (const pack of await readdir(directory)) {
      const bytes = await readFile(join(directory, pack));
      let offset = 8;
      while (offset < bytes.length) {
        const n = bytes.readUInt32LE(offset),
          h = JSON.parse(bytes.subarray(offset + 4, offset + 4 + n).toString()),
          length = 4 + n + h.length;
        locators.set(h.hash, { ...h, pack, offset, length });
        offset += length;
      }
    }
    for (const r of locators.values())
      if (r.kind === "manifest") {
        const m = JSON.parse((await reader.read(r)).toString());
        if (m.objects.some((o: any) => o.kind === "source_text"))
          manifests.set(m.work_id, m);
      }
    return { reader, locators, manifests };
  }
  const a = await index("A"),
    d = await index("D");
  const cases = [...d.manifests.values()].sort(
    (a, b) => b.chapters[0].transform.size - a.chapters[0].transform.size,
  );
  const result: any = {
    scope:
      "warm verified PackStore read plus shared TXT transform, no HTTP or sanitization",
    cases: cases.length,
    longest_source_bytes: cases[0].chapters[0].transform.size,
    baseline: [],
    candidate: [],
    longest_baseline: [],
    longest_candidate: [],
  };
  for (let i = 0; i < 40; i++) {
    const m = i < 20 ? cases[i % cases.length] : cases[0],
      old = a.manifests.get(m.work_id).chapters[0],
      c = m.chapters[0];
    const t = performance.now(),
      before = await a.reader.read(a.locators.get(old.hash)),
      oldMs = performance.now() - t;
    const now = performance.now(),
      after = textChapter(await d.reader.read(d.locators.get(c.hash)), c),
      newMs = performance.now() - now;
    if (!before.equals(after)) throw Error("READER_MISMATCH");
    result[i < 20 ? "baseline" : "longest_baseline"].push(oldMs);
    result[i < 20 ? "candidate" : "longest_candidate"].push(newMs);
  }
  for (const key of [
    "baseline",
    "candidate",
    "longest_baseline",
    "longest_candidate",
  ]) {
    const values = result[key].sort((a: number, b: number) => a - b);
    result[key] = {
      requests: values.length,
      p50_ms: values[Math.floor(values.length * 0.5)],
      p95_ms: values[Math.ceil(values.length * 0.95) - 1],
      max_ms: values.at(-1),
    };
  }
  await writeFile(join(root, "reader.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
