const {
  writeArchive,
  openChain,
  verify,
  MAX_VOLUME,
} = require("@palimora/archive-format");
const fs = require("node:fs/promises"),
  assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const root = process.env.RELEASE_VOLUME_ROOT;
if (!root?.startsWith("/benchmark/"))
  throw Error("Private benchmark storage required");
(async () => {
  const t = performance.now();
  async function* objects() {
    for (let i = 0; i < 128; i++) {
      const bytes = Buffer.alloc(16 * 1024 * 1024);
      bytes.writeUInt32LE(i);
      yield { kind: "boundary-fixture", bytes };
    }
    yield { kind: "boundary-fixture", bytes: Buffer.from("boundary") };
  }
  await writeArchive({
    root,
    objects: objects(),
    origin: "release-boundary-fixture",
  });
  const chain = await openChain([root]);
  assert.deepEqual(
    chain.manifest.volumes.map((v) => v.size),
    [MAX_VOLUME, 8],
  );
  const result = await verify(chain);
  await fs.writeFile(
    "/results/volume-boundary.json",
    JSON.stringify(
      {
        ...result,
        volumes: chain.manifest.volumes.map((v) => v.size),
        seconds: (performance.now() - t) / 1000,
      },
      null,
      2,
    ),
  );
  await fs.rm(root, { recursive: true });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
