"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const MAX_VOLUME = 2147483648;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const safeInteger = (n) => Number.isSafeInteger(n) && n >= 0;
async function syncDirectory(path) {
  const f = await fs.open(path, "r");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function writeAll(f, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await f.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (!bytesWritten) throw Error("SHORT_WRITE");
    offset += bytesWritten;
  }
}
async function atomicFile(root, name, bytes) {
  const temp = join(root, "." + randomUUID());
  const f = await fs.open(temp, "wx", 0o600);
  try {
    await writeAll(f, bytes);
    await f.sync();
  } finally {
    await f.close();
  }
  await fs.rename(temp, join(root, name));
  await syncDirectory(root);
}
async function regularFile(root, name) {
  const f = await fs.open(
    join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  if (!(await f.stat()).isFile()) {
    await f.close();
    throw Error("NOT_REGULAR_FILE");
  }
  return f;
}
async function fileDigest(root, name, check = async () => {}) {
  const f = await regularFile(root, name);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const part of f.createReadStream({ autoClose: false })) {
      await check();
      hash.update(part);
      size += part.length;
    }
  } finally {
    await f.close();
  }
  return { size, sha256: hash.digest("hex") };
}
async function loadManifest(root) {
  const f = await regularFile(root, "manifest.json");
  let bytes;
  try {
    bytes = await f.readFile();
  } finally {
    await f.close();
  }
  const sidecar = (
    await fs.readFile(join(root, "manifest.sha256"), "utf8")
  ).trim();
  if (digest(bytes) !== sidecar) throw Error("MANIFEST_CHECKSUM");
  const m = JSON.parse(bytes);
  if (!["palimora-archive-v1", "palimora-backup-v1"].includes(m.format))
    throw Error("ARCHIVE_VERSION");
  if (
    typeof m.origin !== "string" ||
    !m.origin.length ||
    typeof m.created_at !== "string"
  )
    throw Error("MANIFEST_INVALID");
  if (
    !Array.isArray(m.objects) ||
    !Array.isArray(m.volumes) ||
    !Array.isArray(m.dependencies)
  )
    throw Error("MANIFEST_INVALID");
  const volumes = new Map();
  for (const v of m.volumes) {
    if (
      !/^volume-[0-9]{6,}\.pmarc$/.test(v.name) ||
      volumes.has(v.name) ||
      !safeInteger(v.size) ||
      v.size > MAX_VOLUME ||
      !hashPattern.test(v.sha256)
    )
      throw Error("VOLUME_INVALID");
    volumes.set(v.name, v);
  }
  const hashes = new Set();
  for (const o of m.objects) {
    if (
      !hashPattern.test(o.hash) ||
      hashes.has(o.hash) ||
      typeof o.kind !== "string" ||
      !safeInteger(o.size) ||
      !Array.isArray(o.parts)
    )
      throw Error("OBJECT_INVALID");
    hashes.add(o.hash);
    let size = 0;
    for (const p of o.parts) {
      const v = volumes.get(p.volume);
      if (
        !v ||
        !safeInteger(p.offset) ||
        !safeInteger(p.size) ||
        !safeInteger(p.offset + p.size) ||
        p.offset + p.size > v.size
      )
        throw Error("OBJECT_RANGE");
      size += p.size;
    }
    if (size !== o.size) throw Error("OBJECT_SIZE");
  }
  if (
    m.dependencies.length > 1 ||
    m.dependencies.some((d) => !hashPattern.test(d.manifest))
  )
    throw Error("DEPENDENCY_INVALID");
  return { manifest: m, hash: sidecar, root };
}
/** Ordered full -> incremental chain. Paths are supplied explicitly, never read
 * from untrusted manifests. All dependencies are identified by manifest digest. */
async function openChain(roots) {
  if (!roots.length) throw Error("CHAIN_REQUIRED");
  const archives = [];
  const objects = new Map();
  let previous;
  for (const root of roots) {
    const archive = await loadManifest(root);
    const deps = archive.manifest.dependencies;
    if (
      (!previous && deps.length) ||
      (previous &&
        (deps.length !== 1 ||
          deps[0].manifest !== previous.hash ||
          archive.manifest.origin !== previous.manifest.origin ||
          archive.manifest.format !== previous.manifest.format))
    )
      throw Error("DEPENDENCY_MISSING");
    for (const o of archive.manifest.objects) {
      const known = objects.get(o.hash);
      if (
        known &&
        (known.object.size !== o.size || known.object.kind !== o.kind)
      )
        throw Error("OBJECT_CONFLICT");
      objects.set(o.hash, { object: o, root });
    }
    archives.push(archive);
    previous = archive;
  }
  return {
    archives,
    objects,
    manifest: previous.manifest,
    hash: previous.hash,
  };
}
async function* readObject(chain, hash) {
  const entry = chain.objects.get(hash);
  if (!entry) throw Error("OBJECT_MISSING");
  const checksum = createHash("sha256");
  for (const p of entry.object.parts) {
    if (!p.size) continue;
    const f = await regularFile(entry.root, p.volume);
    let remaining = p.size,
      position = p.offset;
    try {
      while (remaining) {
        const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
        const { bytesRead } = await f.read(bytes, 0, bytes.length, position);
        if (!bytesRead) throw Error("VOLUME_TRUNCATED");
        const part = bytes.subarray(0, bytesRead);
        checksum.update(part);
        remaining -= bytesRead;
        position += bytesRead;
        yield part;
      }
    } finally {
      await f.close();
    }
  }
  if (checksum.digest("hex") !== hash) throw Error("OBJECT_CHECKSUM");
}
async function objectBytes(chain, hash) {
  const parts = [];
  for await (const bytes of readObject(chain, hash)) parts.push(bytes);
  return Buffer.concat(parts);
}
async function verify(chain, check = async () => {}) {
  for (const a of chain.archives)
    for (const v of a.manifest.volumes) {
      const actual = await fileDigest(a.root, v.name, check);
      if (actual.size !== v.size || actual.sha256 !== v.sha256)
        throw Error("VOLUME_CHECKSUM");
    }
  for (const hash of chain.objects.keys())
    for await (const _ of readObject(chain, hash)) {
      await check();
    }
  return { archives: chain.archives.length, objects: chain.objects.size };
}
/** Payloads are unchanged canonical bytes. Large objects may cross volume
 * boundaries. The manifest is the commit marker, published only after fsync. */
async function writeArchive({
  format = "palimora-archive-v1",
  root,
  objects,
  origin,
  catalog,
  base,
  volumeBytes = MAX_VOLUME,
  check = async () => {},
  stopped = () => false,
}) {
  if (
    !Number.isSafeInteger(volumeBytes) ||
    volumeBytes < 1 ||
    volumeBytes > MAX_VOLUME
  )
    throw Error("VOLUME_LIMIT");
  if (typeof origin !== "string" || !origin.length)
    throw Error("ORIGIN_REQUIRED");
  if (base && base.manifest.origin !== origin) throw Error("ORIGIN_MISMATCH");
  await check();
  await fs.mkdir(root, { mode: 0o700 }); // never overwrite a committed export
  const volumes = [],
    entries = [],
    seen = new Map();
  let current;
  async function seal() {
    if (!current) return;
    await current.file.sync();
    await current.file.close();
    current.file = undefined;
    await fs.rename(
      join(root, current.name + ".partial"),
      join(root, current.name),
    );
    const checksum = current.checksum.digest("hex");
    const stored = await fileDigest(root, current.name);
    if (stored.size !== current.size || stored.sha256 !== checksum)
      throw Error("VOLUME_CHECKSUM");
    volumes.push({ name: current.name, size: current.size, sha256: checksum });
    current = undefined;
    await syncDirectory(root);
  }
  try {
    for await (const object of objects) {
      if (stopped()) throw Error("INTERRUPTED");
      await check();
      const hash = digest(object.bytes);
      if (object.hash && object.hash !== hash) throw Error("SOURCE_CHECKSUM");
      if (typeof object.kind !== "string" || !object.kind.length)
        throw Error("OBJECT_KIND");
      if (seen.has(hash)) {
        if (seen.get(hash) !== object.kind) throw Error("OBJECT_CONFLICT");
        continue;
      }
      seen.set(hash, object.kind);
      if (base?.objects.has(hash)) {
        const known = base.objects.get(hash).object;
        if (known.size !== object.bytes.length || known.kind !== object.kind)
          throw Error("OBJECT_CONFLICT");
        continue;
      }
      const entry = {
        hash,
        kind: object.kind,
        size: object.bytes.length,
        parts: [],
      };
      let offset = 0;
      while (offset < object.bytes.length) {
        if (stopped()) throw Error("INTERRUPTED");
        await check();
        if (!current) {
          const name =
            "volume-" + String(volumes.length + 1).padStart(6, "0") + ".pmarc";
          current = {
            name,
            size: 0,
            checksum: createHash("sha256"),
            file: await fs.open(join(root, name + ".partial"), "wx", 0o600),
          };
        }
        const part = object.bytes.subarray(
          offset,
          offset + Math.min(1024 * 1024, volumeBytes - current.size),
        );
        await writeAll(current.file, part);
        const previous = entry.parts.at(-1);
        if (previous?.volume === current.name) previous.size += part.length;
        else
          entry.parts.push({
            volume: current.name,
            offset: current.size,
            size: part.length,
          });
        current.checksum.update(part);
        current.size += part.length;
        offset += part.length;
        if (current.size === volumeBytes) await seal();
      }
      entries.push(entry);
    }
    await seal();
    const manifest = {
      format,
      origin,
      created_at: new Date().toISOString(),
      dependencies: base ? [{ manifest: base.hash }] : [],
      catalog,
      volumes,
      objects: entries,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await check();
    await atomicFile(
      root,
      "manifest.sha256",
      Buffer.from(digest(bytes) + "\n"),
    );
    await atomicFile(root, "manifest.json", bytes);
    return loadManifest(root);
  } finally {
    if (current?.file) await current.file.close();
  }
}
/** Import a chain into a standalone content-addressed directory. Each object is
 * verified before atomic publication; replay verifies existing objects. */
async function extract(chain, destination) {
  await verify(chain);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [hash] of chain.objects) {
    try {
      const existing = await fileDigest(destination, hash);
      if (existing.sha256 !== hash) throw Error("EXISTING_OBJECT_CORRUPT");
      continue;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const temp = "." + randomUUID();
    const f = await fs.open(join(destination, temp), "wx", 0o600);
    try {
      for await (const part of readObject(chain, hash)) await writeAll(f, part);
      await f.sync();
    } finally {
      await f.close();
    }
    // link is atomic and never replaces an existing object, even on concurrent imports.
    try {
      await fs.link(join(destination, temp), join(destination, hash));
    } catch (e) {
      if (
        e.code !== "EEXIST" ||
        (await fileDigest(destination, hash)).sha256 !== hash
      )
        throw e;
    }
    await fs.unlink(join(destination, temp));
  }
  await syncDirectory(destination);
  await atomicFile(
    destination,
    "catalog-" + chain.hash + ".json",
    Buffer.from(JSON.stringify(chain.manifest.catalog)),
  );
}
module.exports = {
  MAX_VOLUME,
  digest,
  loadManifest,
  openChain,
  readObject,
  objectBytes,
  verify,
  writeArchive,
  extract,
  fileDigest,
};

// Resolve immutable metadata using the digest of the actual stored bytes.
function resolveCanonical(manifest, objects) {
  if (manifest.schema === "palimora-canonical-v1") return manifest;
  if (manifest.schema === "palimora-canonical-metadata-v1") {
    if (
      manifest.state !== "metadata_only" ||
      manifest.chapters?.length ||
      manifest.objects?.length ||
      !("metadata" in manifest)
    )
      throw Error("CANONICAL_METADATA_STATE");
    return manifest;
  }
  if (manifest.schema !== "palimora-canonical-v2")
    throw Error("CANONICAL_VERSION");
  if (!hashPattern.test(manifest.metadata_hash) || "metadata" in manifest)
    throw Error("CANONICAL_METADATA_REFERENCE");
  const bytes = objects.get(manifest.metadata_hash);
  if (!Buffer.isBuffer(bytes)) throw Error("METADATA_MISSING");
  if (digest(bytes) !== manifest.metadata_hash) throw Error("METADATA_HASH");
  const document = JSON.parse(bytes.toString("utf8"));
  if (document.schema !== "palimora-metadata-v1" || !("metadata" in document))
    throw Error("METADATA_SCHEMA");
  const chapters = manifest.chapters.map((c) => {
    if (!("object_ref" in c)) return c;
    if (
      !safeInteger(c.object_ref) ||
      c.object_ref >= manifest.objects.length ||
      "hash" in c ||
      "name" in c
    )
      throw Error("CHAPTER_OBJECT_REFERENCE");
    const { object_ref, ...rest } = c;
    const ref = manifest.objects[object_ref];
    return { ...rest, hash: ref.hash, name: ref.name };
  });
  return { ...manifest, chapters, metadata: document.metadata };
}
async function canonicalManifest(chain, hash) {
  const manifest = JSON.parse(
    (await objectBytes(chain, hash)).toString("utf8"),
  );
  const objects = new Map();
  if (manifest.schema === "palimora-canonical-v2")
    objects.set(
      manifest.metadata_hash,
      await objectBytes(chain, manifest.metadata_hash),
    );
  return resolveCanonical(manifest, objects);
}
module.exports.resolveCanonical = resolveCanonical;
module.exports.canonicalManifest = canonicalManifest;

function textChapter(source, chapter) {
  const r = chapter.transform;
  if (!r || r.schema !== "palimora-text-html-v1")
    throw Error("TEXT_RECIPE_VERSION");
  if (
    !safeInteger(r.offset) ||
    !safeInteger(r.length) ||
    r.size !== source.length ||
    r.offset + r.length > source.length ||
    digest(source) !== chapter.hash
  )
    throw Error("TEXT_SOURCE_INTEGRITY");
  // Fatal UTF-8 decoding; preserve an embedded BOM in the body.
  const body = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(source.subarray(r.offset, r.offset + r.length));
  const escaped = body.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[c],
  );
  const bytes = Buffer.from("<pre>" + escaped + "</pre>");
  if (
    bytes.length !== r.output_size ||
    digest(bytes) !== chapter.source_html_sha256
  )
    throw Error("CHAPTER_RECONSTRUCTION");
  return bytes;
}
module.exports.textChapter = textChapter;

function reconstructChapter(m, c, objects) {
  let bytes = objects.get(c.hash);
  if (!bytes) throw Error("OBJECT_MISSING");
  if (c.transform) bytes = textChapter(bytes, c);
  for (const note of [...(c.notes ?? [])].sort((a, b) => a.offset - b.offset)) {
    const ref = m.objects.find((o) => o.name === note.name);
    if (!ref) throw Error("NOTE_MISSING");
    const fragment = objects.get(ref.hash);
    if (!fragment) throw Error("OBJECT_MISSING");
    bytes = Buffer.concat([
      bytes.subarray(0, note.offset),
      fragment,
      bytes.subarray(note.offset),
    ]);
  }
  if (c.source_html_sha256 && digest(bytes) !== c.source_html_sha256)
    throw Error("CHAPTER_RECONSTRUCTION");
  return bytes;
}

module.exports.reconstructChapter = reconstructChapter;
