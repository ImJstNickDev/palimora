import { DB, transaction } from "./db";
import { readObject } from "./archive";
import { findObjects } from "./archive-catalog";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fail } from "./security";
const sanitize: typeof import("sanitize-html") =
  createRequire(__filename)("sanitize-html");
export function resourceRef(manifest: any, base: string, url: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split("#")[0]);
  } catch {
    return null;
  }
  let absolute = url;
  try {
    absolute = new URL(
      url,
      /^https?:\/\//.test(base) ? base : "https://archiveofourown.org",
    ).href;
  } catch {}
  const mapped = manifest.metadata?.ao3?.media?.find(
    (r: any) => r.url === url || r.url === absolute,
  )?.object;
  const name = posix.normalize(posix.join(posix.dirname(base), decoded));
  return (
    manifest.objects.find(
      (o: any) =>
        ["asset", "chunk_manifest", "css"].includes(o.kind) &&
        (o.name === mapped || o.name === url || o.name === name),
    ) ?? null
  );
}
export function assetMime(bytes: Buffer, name: string) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  const first = bytes.subarray(0, 16).toString("latin1");
  if (first.startsWith("RIFF") && first.slice(8, 12) === "WEBP")
    return "image/webp";
  if (first.startsWith("RIFF") && first.slice(8, 12) === "WAVE")
    return "audio/wav";
  if (first.startsWith("OggS"))
    return /\.(ogv|oggvideo)$/i.test(name) ? "video/ogg" : "audio/ogg";
  if (first.startsWith("fLaC")) return "audio/flac";
  if (bytes[0] === 255 && (bytes[1] & 246) === 240) return "audio/aac";
  if (first.startsWith("ID3") || (bytes[0] === 255 && (bytes[1] & 224) === 224))
    return "audio/mpeg";
  if (first.slice(4, 8) === "ftyp" && /avif|avis/.test(first.slice(8)))
    return "image/avif";
  if (first.slice(4, 8) === "ftyp")
    return /\.m4a$/i.test(name) ? "audio/mp4" : "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return /\.weba$/i.test(name) ? "audio/webm" : "video/webm";
  if (first.startsWith("wOFF")) return "font/woff";
  if (first.startsWith("wOF2")) return "font/woff2";
  if (first.startsWith("OTTO")) return "font/otf";
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) return "font/ttf";
  if (first.startsWith("%PDF-")) return "application/pdf";
  if (bytes.subarray(0, 6).toString() === "WEBVTT") return "text/vtt";
  if (
    /\.svg$/i.test(name) &&
    /<svg[\s>]/i.test(bytes.subarray(0, 8192).toString())
  )
    return "image/svg+xml";
  return "application/octet-stream";
}
export function safeSvg(bytes: Buffer) {
  return Buffer.from(
    sanitize(bytes.toString(), {
      allowedTags: [
        "svg",
        "g",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "defs",
        "linearGradient",
        "radialGradient",
        "stop",
        "clipPath",
        "mask",
        "pattern",
        "use",
        "title",
        "desc",
      ],
      allowedAttributes: {
        "*": [
          "id",
          "fill",
          "fill-opacity",
          "stroke",
          "stroke-width",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-opacity",
          "opacity",
          "transform",
          "d",
          "x",
          "y",
          "x1",
          "x2",
          "y1",
          "y2",
          "cx",
          "cy",
          "r",
          "rx",
          "ry",
          "width",
          "height",
          "points",
          "viewBox",
          "preserveAspectRatio",
          "xmlns",
          "offset",
          "stop-color",
          "stop-opacity",
          "gradientUnits",
          "gradientTransform",
          "clip-path",
          "mask",
          "font-size",
          "text-anchor",
          "href",
          "xlink:href",
        ],
      },
      parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
      transformTags: {
        "*": (tag, a) => ({
          tagName: tag,
          attribs: Object.fromEntries(
            Object.entries(a).filter(
              ([k, v]) =>
                !(/href$/i.test(k) && !v.startsWith("#")) &&
                !(/url\(/i.test(v) && !/^url\(#[\w.-]+\)$/.test(v)),
            ),
          ),
        }),
      },
      allowedSchemes: [],
      allowProtocolRelative: false,
    }),
  );
}
export async function mediaDescriptor(db: DB, manifest: any, hash: string) {
  const ref = manifest.objects.find(
    (o: any) => o.hash === hash && ["asset", "chunk_manifest"].includes(o.kind),
  );
  if (!ref) fail("NOT_FOUND", 404);
  const bytes = await readObject(db, hash);
  if (ref.kind !== "chunk_manifest")
    return {
      hash,
      name: ref.name,
      size: bytes.length,
      mime: assetMime(bytes, ref.name),
      ...(assetMime(bytes, ref.name) === "image/svg+xml"
        ? { svg: safeSvg(bytes).toString("base64") }
        : {}),
    };
  const m = JSON.parse(bytes.toString());
  if (m.schema !== "palimora-chunks-v1" || !Array.isArray(m.chunks))
    throw Error("CHUNK_SCHEMA");
  let size = 0;
  for (const c of m.chunks) {
    if (
      !Number.isSafeInteger(c.size) ||
      c.size < 0 ||
      !/^[a-f0-9]{64}$/.test(c.hash)
    )
      throw Error("CHUNK_SCHEMA");
    size += c.size;
  }
  if (size !== m.size) throw Error("CHUNK_SIZE");
  const first = m.chunks.length
    ? await readObject(db, m.chunks[0].hash)
    : Buffer.alloc(0);
  let svg: string | undefined;
  if (assetMime(first, ref.name) === "image/svg+xml") {
    const chunks: Buffer[] = [];
    for (const c of m.chunks) chunks.push(await readObject(db, c.hash));
    const combined = Buffer.concat(chunks);
    if (
      combined.length !== m.size ||
      createHash("sha256").update(combined).digest("hex") !== m.sha256
    )
      throw Error("CHUNK_HASH");
    svg = safeSvg(combined).toString("base64");
  }
  return {
    hash,
    svg,
    name: ref.name,
    size: m.size,
    mime: assetMime(first, ref.name),
    chunks: m.chunks,
    sha256: m.sha256,
  };
}
export function byteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1]
      ? m[2]
        ? Math.min(size - 1, Number(m[2]))
        : size - 1
      : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end, partial: true };
}
export async function* streamMedia(d: any, start: number, end: number) {
  if (d.svg) {
    yield Buffer.from(d.svg, "base64").subarray(start, end + 1);
    return;
  }
  const chunks = d.chunks ?? [{ hash: d.hash, size: d.size }];
  let offset = 0;
  const whole = start === 0 && end === d.size - 1;
  const checksum = createHash("sha256");
  for (const chunk of chunks) {
    if (offset + chunk.size > start && offset <= end) {
      const b = await transaction((db) => readObject(db, chunk.hash));
      if (b.length !== chunk.size) throw Error("CHUNK_SIZE");
      if (whole) checksum.update(b);
      yield b.subarray(
        Math.max(0, start - offset),
        Math.min(b.length, end - offset + 1),
      );
    }
    offset += chunk.size;
  }
  if (whole && d.sha256 && checksum.digest("hex") !== d.sha256)
    throw Error("CHUNK_HASH");
}
export async function assetBytes(db: DB, m: any, hash: string) {
  const d: any = await mediaDescriptor(db, m, hash);
  if (d.svg) return Buffer.from(d.svg, "base64");
  const chunks: Buffer[] = [];
  if (d.chunks) {
    for (const c of d.chunks) chunks.push(await readObject(db, c.hash));
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== d.size ||
      createHash("sha256").update(bytes).digest("hex") !== d.sha256
    )
      throw Error("CHUNK_HASH");
    return bytes;
  }
  return readObject(db, hash);
}

export async function workStyles(
  db: DB,
  manifest: any,
  resolve: (object: any) => string,
) {
  const css: typeof import("css-tree") = createRequire(__filename)("css-tree");
  const { safeCss } = await import("./reader-safety");
  const seen = new Set<string>();
  const sheet = async (o: any): Promise<string> => {
    if (seen.has(o.hash)) return "";
    seen.add(o.hash);
    const text = (
      await (o.kind === "css"
        ? readObject(db, o.hash)
        : assetBytes(db, manifest, o.hash))
    ).toString();
    let imports = "";
    try {
      const ast = css.parse(text);
      const refs: { url: string; media: string }[] = [];
      css.walk(ast, {
        visit: "Atrule",
        enter(n) {
          if (n.name.toLowerCase() !== "import" || !n.prelude) return;
          let url = "";
          css.walk(n.prelude, (v) => {
            if (!url && (v.type === "Url" || v.type === "String"))
              url = v.value;
          });
          if (url) {
            const prelude = css.generate(n.prelude),
              tail = prelude.replace(
                /^(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*/,
                "",
              );
            refs.push({ url, media: tail });
          }
        },
      });
      for (const ref of refs) {
        const local = resourceRef(manifest, o.name, ref.url);
        if (local) {
          const nested = await sheet(local);
          imports += ref.media ? `@media ${ref.media}{${nested}}` : nested;
        }
      }
    } catch {}
    return (
      imports +
      safeCss(text, (url) => {
        const asset = resourceRef(manifest, o.name, url);
        return asset && asset.kind !== "css" ? resolve(asset) : "";
      })
    );
  };
  let result = "";
  for (const o of manifest.objects.filter((o: any) => o.kind === "css"))
    result += await sheet(o);
  return result;
}
