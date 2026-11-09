// Offline physical recompression probe, never writes a canonical pack.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const codec = require("/app/apps/api/native/build/codec.node");
async function main() {
  const result = {
    levels: {},
    objects: 0,
    unique: 0,
    physical_bytes: 0,
    header_bytes: 0,
    by_kind: {},
  };
  const seen = new Set();
  for (const level of [3, 6, 9]) {
    const begin = performance.now(),
      cpu = process.cpuUsage();
    let bytes = 0,
      raw = 0;
    const kinds = {};
    for (const file of fs
      .readdirSync("/packs", { recursive: true })
      .filter((x) => x.endsWith(".pmpack"))) {
      const f = fs.openSync(path.join("/packs", file), "r");
      const size = fs.fstatSync(f).size;
      let offset = 8;
      const magic = Buffer.alloc(8);
      fs.readSync(f, magic, 0, 8, 0);
      assert.equal(magic.toString(), "PMPACK01");
      if (level === 3) result.physical_bytes += size;
      while (offset < size) {
        const prefix = Buffer.alloc(4);
        fs.readSync(f, prefix, 0, 4, offset);
        const n = prefix.readUInt32LE();
        assert(n <= 65536);
        const hb = Buffer.alloc(n);
        fs.readSync(f, hb, 0, n, offset + 4);
        const h = JSON.parse(hb);
        const b = Buffer.alloc(h.length);
        fs.readSync(f, b, 0, h.length, offset + 4 + n);
        offset += 4 + n + h.length;
        assert.equal(
          crypto.createHash("sha256").update(b).digest("hex"),
          h.checksum,
        );
        const decoded =
          h.codec === "raw" ? b : (await codec.batch([b], [h.size], true))[0];
        assert.equal(
          crypto.createHash("sha256").update(decoded).digest("hex"),
          h.hash,
        );
        const encoded =
          h.codec === "raw"
            ? b
            : (await codec.batch([decoded], level, false))[0];
        const length = Math.min(decoded.length, encoded.length);
        bytes += length;
        raw += decoded.length;
        const k = (kinds[h.kind] ??= { objects: 0, raw: 0, payload: 0 });
        k.objects++;
        k.raw += decoded.length;
        k.payload += length;
        if (level === 3) {
          result.objects++;
          seen.add(h.hash);
          result.header_bytes += n + 4;
        }
      }
      fs.closeSync(f);
    }
    result.levels[level] = {
      payload_bytes: bytes,
      raw_bytes: raw,
      seconds: (performance.now() - begin) / 1000,
      cpu: process.cpuUsage(cpu),
      by_kind: kinds,
    };
    console.log(level, bytes);
    fs.writeFileSync("/output/pack.json", JSON.stringify(result, null, 2));
  }
  result.unique = seen.size;
  fs.writeFileSync("/output/pack.json", JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
