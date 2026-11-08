import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openBackupTarget } from "../apps/api/src/backup-target";
const {
  writeArchive,
  openChain,
  verify,
  extract,
  objectBytes,
  digest,
  MAX_VOLUME,
} = require("../packages/archive-format/index.cjs");

test("portable archive: historical bytes, exact volume bound, incremental dependencies and idempotent standalone import", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-export-"));
  try {
    const first = {
      kind: "chapter_html",
      bytes: Buffer.from("<p>Prima versione</p>"),
    };
    const second = {
      kind: "chapter_html",
      bytes: Buffer.from("<p>Seconda versione</p>"),
    };
    const media = { kind: "asset", bytes: randomBytes(8000) };
    const catalog = {
      works: [{ id: "work-1", snapshots: [digest(first.bytes)] }],
    };
    const base = join(root, "base"),
      delta = join(root, "delta");
    await writeArchive({
      root: base,
      origin: "test",
      catalog,
      objects: [first, media],
      volumeBytes: 1024,
    });
    const chain = await openChain([base]);
    assert.equal(chain.manifest.volumes.length, 8);
    for (const v of chain.manifest.volumes)
      assert.ok((await stat(join(base, v.name))).size <= 1024);
    await writeArchive({
      root: delta,
      origin: "test",
      catalog: {
        works: [
          {
            id: "work-1",
            snapshots: [digest(first.bytes), digest(second.bytes)],
          },
        ],
      },
      objects: [first, second, media],
      base: chain,
      volumeBytes: 1024,
    });
    const complete = await openChain([base, delta]);
    assert.equal(complete.manifest.objects.length, 1);
    assert.deepEqual(await verify(complete), { archives: 2, objects: 3 });
    assert.deepEqual(
      await objectBytes(complete, digest(first.bytes)),
      first.bytes,
    );
    assert.deepEqual(
      await objectBytes(complete, digest(second.bytes)),
      second.bytes,
    );
    await assert.rejects(openChain([delta]), /DEPENDENCY_MISSING/);
    await assert.rejects(openChain([delta, base]), /DEPENDENCY_MISSING/);
    const imported = join(root, "import");
    await extract(complete, imported);
    await extract(complete, imported);
    assert.deepEqual(
      await readFile(join(imported, digest(media.bytes))),
      media.bytes,
    );
    const cli = join(process.cwd(), "packages/archive-cli/cli.cjs");
    assert.deepEqual(
      JSON.parse(
        execFileSync(process.execPath, [cli, "verify", base, delta], {
          encoding: "utf8",
        }),
      ),
      { archives: 2, objects: 3 },
    );
    execFileSync(process.execPath, [
      cli,
      "import",
      join(root, "cli-import"),
      base,
      delta,
    ]);
    assert.deepEqual(
      execFileSync(process.execPath, [
        cli,
        "read",
        digest(first.bytes),
        base,
        delta,
      ]),
      first.bytes,
    );
    await assert.rejects(
      writeArchive({ root: base, origin: "test", catalog, objects: [] }),
      { code: "EEXIST" },
    );
    await assert.rejects(
      writeArchive({
        root: join(root, "oversize"),
        volumeBytes: MAX_VOLUME + 1,
      }),
      /VOLUME_LIMIT/,
    );
    await writeFile(join(base, chain.manifest.volumes[0].name), "corrupt");
    await assert.rejects(verify(complete), /VOLUME_CHECKSUM/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive rejects tampering, unsafe volume paths and interruption before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-export-fault-"));
  try {
    const destination = join(root, "interrupted");
    let checks = 0;
    await assert.rejects(
      writeArchive({
        root: destination,
        origin: "test",
        catalog: {},
        objects: [{ kind: "asset", bytes: randomBytes(3000) }],
        volumeBytes: 1024,
        check: async () => {
          if (++checks === 5) throw Error("ENOSPC");
        },
      }),
      /ENOSPC/,
    );
    assert.ok(!(await readdir(destination)).includes("manifest.json"));
    await assert.rejects(openChain([destination]));
    const valid = join(root, "valid");
    await writeArchive({
      root: valid,
      origin: "test",
      catalog: {},
      objects: [{ kind: "asset", bytes: Buffer.from("bytes") }],
    });
    const original = await readFile(join(valid, "manifest.json"));
    await writeFile(
      join(valid, "manifest.json"),
      Buffer.concat([original, Buffer.from(" ")]),
    );
    await assert.rejects(openChain([valid]), /MANIFEST_CHECKSUM/);
    const m = JSON.parse(original.toString());
    m.volumes[0].name = "../secret";
    const unsafe = Buffer.from(JSON.stringify(m));
    await writeFile(join(valid, "manifest.json"), unsafe);
    await writeFile(join(valid, "manifest.sha256"), digest(unsafe));
    await assert.rejects(openChain([valid]), /VOLUME_INVALID/);
    await writeFile(join(valid, "manifest.json"), original);
    await writeFile(join(valid, "manifest.sha256"), digest(original));
    const chain = await openChain([valid]);
    const volume = join(valid, chain.manifest.volumes[0].name);
    await rm(volume);
    await symlink(join(root, "secret"), volume);
    await assert.rejects(verify(chain), { code: "ELOOP" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external target fails closed for unavailable mount, mismatched marker and insufficient space", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-target-"));
  try {
    await writeFile(join(root, ".palimora-backup-target"), "fixture-identity");
    const config = {
      name: "fixture",
      path: root,
      marker: "fixture-identity",
      device: "9999:9999",
      reserveBytes: 0,
    };
    await assert.rejects(openBackupTarget(config), /BACKUP_MOUNT_UNAVAILABLE/);
    assert.deepEqual(await readdir(root), [".palimora-backup-target"]);
    const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .map((line) => line.split(" "));
    const mount = mounts
      .filter((parts) => root.startsWith(parts[4] + "/") || parts[4] === "/")
      .sort((a, b) => b[4].length - a[4].length)[0];
    config.device = mount[2];
    const target = await openBackupTarget(config);
    try {
      await target.check();
      await assert.rejects(target.check(Number.MAX_SAFE_INTEGER), {
        code: "ENOSPC",
      });
      await writeFile(
        join(root, ".palimora-backup-target"),
        "replacement-disk",
      );
      await assert.rejects(target.check(), /BACKUP_TARGET_IDENTITY/);
    } finally {
      await target.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational sealed packs round-trip through portable volumes into a new PackStore", async () => {
  const { PackStore, canonical, sha } = await import("../apps/api/src/pack");
  const root = await mkdtemp(join(tmpdir(), "palimora-pack-export-"));
  try {
    const original = new PackStore(join(root, "original"));
    const old = Buffer.from("<p>Capitolo storico</p>"),
      current = Buffer.from("<p>Capitolo aggiornato</p>");
    const asset = randomBytes(4000);
    const manifest = (chapter: Buffer) =>
      canonical({
        schema: "palimora-canonical-v1",
        work_id: "fixture",
        external_id: "123",
        metadata: { title: "Opera di verifica" },
        chapters: [{ hash: sha(chapter) }],
        objects: [{ hash: sha(asset), kind: "asset", name: "image" }],
        state: "complete",
      });
    const objects = [
      { kind: "chapter_html", bytes: old },
      { kind: "chapter_html", bytes: current },
      { kind: "asset", bytes: asset },
      { kind: "manifest", bytes: manifest(old) },
      { kind: "manifest", bytes: manifest(current) },
    ];
    const locators = await original.write(objects);
    async function* source() {
      for (const r of locators)
        yield { hash: r.hash, kind: r.kind, bytes: await original.read(r) };
    }
    const output = join(root, "export");
    await writeArchive({
      root: output,
      origin: "fixture",
      catalog: {
        works: [
          { id: "fixture", snapshots: locators.slice(3).map((r) => r.hash) },
        ],
      },
      objects: source(),
      volumeBytes: 1024,
    });
    // Remove the original pack store: all subsequent reads must be autonomous.
    await rm(original.root, { recursive: true });
    const chain = await openChain([output]);
    await verify(chain);
    const restored = new PackStore(join(root, "restored"));
    const records = await restored.write(
      await Promise.all(
        objects.map(async (o) => ({
          kind: o.kind,
          bytes: await objectBytes(chain, sha(o.bytes)),
        })),
      ),
    );
    assert.equal(records.length, objects.length);
    for (let i = 0; i < records.length; i++)
      assert.deepEqual(await restored.read(records[i]), objects[i].bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
