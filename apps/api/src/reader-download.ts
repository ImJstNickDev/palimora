import { typesetPdf } from "./reader-typeset";
import { languageCode } from "./catalog-search";
import {
  streamMedia,
  assetBytes,
  mediaDescriptor,
  resourceRef,
  workStyles,
} from "./reader-media";
import { DB } from "./db";
import { loadSnapshot, chapterBytes, strings, workNotes } from "./catalog";
import { escapeHtml, safeHtml, readerDocument } from "./reader-safety";
import { readObject } from "./archive";
import { fail } from "./security";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { bibliography } from "./catalog-bibliography";
import { ZipFile } from "yazl";
import { cachedPdf, pdfDocument, pdfPreface, printPdf } from "./reader-pdf";

import { createRequire } from "node:module";
const localRequire = createRequire(__filename);
const { parseDocument }: typeof import("htmlparser2") =
  localRequire("htmlparser2");
const render: typeof import("dom-serializer").default =
  localRequire("dom-serializer").default;
export async function downloadWork(db: DB, x: any) {
  const { manifest: m, snapshot } = await loadSnapshot(db, x.id, x.snapshot);
  if (!m) fail("NOT_FOUND", 404);
  if (x.format === "pdf") {
    const bytes = await cachedPdf(
      snapshot + ":" + x.id,
      () => buildDownload(db, x, m, snapshot) as Promise<Buffer>,
    );
    return { mime: "application/pdf", stream: Readable.from([bytes]) };
  }
  return buildDownload(db, x, m, snapshot) as Promise<{
    mime: string;
    stream: Readable;
  }>;
}
async function buildDownload(db: DB, x: any, m: any, snapshot: string) {
  const metadata = bibliography(m.metadata).metadata;
  const title = strings(metadata.title).join(" · ") || x.id;
  const assets = new Map<
    string,
    { descriptor: any; mime: string; file: string; token: string }
  >();
  for (const o of m.objects.filter((o: any) =>
    ["asset", "chunk_manifest"].includes(o.kind),
  )) {
    const descriptor = await mediaDescriptor(db, m, o.hash);
    const extension = posix
      .extname(o.name)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "");
    assets.set(o.name, {
      descriptor,
      token: `palimora-asset-${o.hash}`,
      mime: descriptor.mime,
      file: "media/" + o.hash + extension,
    });
  }
  const resolve = (base: string, url: string) => {
    const ref = resourceRef(m, base, url);
    const asset = ref ? assets.get(ref.name) : null;
    return asset ? (x.format === "epub" ? asset.file : asset.token) : "";
  };
  const style = await workStyles(db, m, (o) => resolve(o.name, o.name));
  const chapters = [];
  for (const [i, c] of m.chapters.entries()) {
    const body = safeHtml(
      (await chapterBytes(db, m, c)).toString(),
      (url) => resolve(c.name, url),
      true,
      (url) => {
        const asset = resolve(c.name, url);
        if (asset) return asset;
        if (url.startsWith("#")) return url;
        const name = posix.normalize(
          posix.join(posix.dirname(c.name), url.split("#")[0]),
        );
        const index = m.chapters.findIndex(
          (r: any) => r.name === name || r.source_url === url,
        );
        return index < 0
          ? url
          : x.format === "epub"
            ? `chapter${index}.xhtml`
            : `#chapter-${index}`;
      },
    );
    if (x.format === "pdf") {
      const dom = parseDocument(body);
      const text = (node: any): string =>
        node.type === "text"
          ? node.data
          : (node.children ?? []).map(text).join("");
      const heading = (nodes: any[]): any => {
        for (const node of nodes) {
          if (/^h[1-3]$/.test(node.name ?? "")) return node;
          const found = heading(node.children ?? []);
          if (found) return found;
        }
      };
      const first = heading(dom.children);
      const chapterTitle =
        c.title || (first ? text(first).trim() : "") || String(i + 1);
      if (first)
        first.attribs.class =
          (first.attribs.class ?? "") + " pdf-chapter-heading";
      chapters.push({
        title: chapterTitle,
        body: `<section class="pdf-chapter" id="chapter-${i}">${first ? "" : `<h2 class="pdf-chapter-heading">${escapeHtml(chapterTitle)}</h2>`}${render(dom)}</section>`,
      });
    } else
      chapters.push({
        title: c.title || String(i + 1),
        body: `<section id="chapter-${i}">${body}</section>`,
      });
  }
  const notes = workNotes(m);
  const renderNote = async (note: any) =>
    `<aside class="notes">${safeHtml((await readObject(db, note.hash)).toString(), (url) => resolve(note.name, url), true)}</aside>`;
  if (chapters.length) {
    for (const note of [...notes.before].reverse()) {
      const html = await renderNote(note);
      chapters[0].body =
        x.format === "pdf"
          ? chapters[0].body.replace(
              /^(<section[^>]*>)/,
              (start) => start + html,
            )
          : html + chapters[0].body;
    }
    for (const note of notes.after)
      chapters[chapters.length - 1].body += await renderNote(note);
  }
  const preface = `<header><h1>${escapeHtml(title)}</h1>${strings(metadata.creators).length ? `<p>${strings(metadata.creators).map(escapeHtml).join(", ")}</p>` : ""}${metadata.summary ? `<blockquote>${escapeHtml(metadata.summary)}</blockquote>` : ""}<dl>${[
    "fandom",
    "rating",
    "warnings",
    "category",
    "relationships",
    "characters",
    "freeform",
    "language",
    "published",
    "updated",
    "words",
  ]
    .filter((k) => metadata[k] !== undefined && String(metadata[k]))
    .map(
      (k) =>
        `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(Array.isArray(metadata[k]) ? metadata[k].join(", ") : String(metadata[k]))}</dd>`,
    )
    .join("")}</dl></header>`;
  if (x.format === "pdf") {
    const byToken = new Map([...assets.values()].map((a) => [a.token, a]));
    const loaded = new Map<
      string,
      Promise<{ mime: string; bytes: Buffer } | null>
    >();
    const resource = (token: string) => {
      if (!loaded.has(token))
        loaded.set(
          token,
          (async () => {
            const a = byToken.get(token);
            if (!a || !/^(image|font)\//.test(a.mime)) return null;
            const d = a.descriptor;
            const bytes = d.svg
              ? Buffer.from(d.svg, "base64")
              : await assetBytes(db, m, d.hash);
            return { mime: a.mime, bytes };
          })(),
        );
      return loaded.get(token)!;
    };
    const language = languageCode(strings(metadata.language)[0] || "und");
    const front = pdfPreface(title, metadata, language);
    const author = strings(metadata.creators).join(", ");
    const native = await typesetPdf(
      title,
      author,
      language,
      front,
      chapters,
      style,
      resource,
    );
    if (native) return native;
    return printPdf(
      pdfDocument(title, language, front, chapters, style),
      resource,
      title,
      strings(metadata.creators).join(", "),
    );
  }
  const html = readerDocument(
    preface + chapters.map((c) => c.body).join("<hr>"),
    style,
  );
  const byToken = new Map([...assets.values()].map((a) => [a.token, a]));
  async function* htmlStream() {
    let offset = 0;
    for (const match of html.matchAll(/palimora-asset-[a-f0-9]{64}/g)) {
      yield html.slice(offset, match.index);
      offset = match.index! + match[0].length;
      const asset = byToken.get(match[0]);
      if (!asset) continue;
      yield `data:${asset.mime};base64,`;
      let remainder = Buffer.alloc(0);
      const d = asset.descriptor;
      for await (const chunk of streamMedia(
        d,
        0,
        (d.svg ? Buffer.from(d.svg, "base64").length : d.size) - 1,
      )) {
        const bytes = Buffer.concat([remainder, chunk]);
        const end = bytes.length - (bytes.length % 3);
        yield bytes.subarray(0, end).toString("base64");
        remainder = bytes.subarray(end);
      }
      if (remainder.length) yield remainder.toString("base64");
    }
    yield html.slice(offset);
  }
  if (x.format === "html")
    return { mime: "text/html", stream: Readable.from(htmlStream()) };
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", {
    compress: false,
  });
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "META-INF/container.xml",
  );
  const xml = (body: string) =>
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
    escapeHtml(title) +
    "</title><style>" +
    escapeHtml(style) +
    '</style></head><body><div id="workskin">' +
    render(parseDocument(body), { xmlMode: true }) +
    "</div></body></html>";
  for (const [i, c] of chapters.entries())
    zip.addBuffer(Buffer.from(xml(c.body)), `chapter${i}.xhtml`);
  zip.addBuffer(Buffer.from(xml(preface)), "preface.xhtml");
  for (const a of assets.values())
    zip.addReadStreamLazy(a.file, (cb) => {
      const d = a.descriptor;
      cb(
        null,
        Readable.from(
          streamMedia(
            d,
            0,
            (d.svg ? Buffer.from(d.svg, "base64").length : d.size) - 1,
          ),
        ),
      );
    });
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>' +
        chapters
          .map(
            (c, i) =>
              `<li><a href="chapter${i}.xhtml">${escapeHtml(c.title)}</a></li>`,
          )
          .join("") +
        "</ol></nav></body></html>",
    ),
    "nav.xhtml",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="work"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="work">urn:uuid:' +
        snapshot +
        "</dc:identifier><dc:title>" +
        escapeHtml(title) +
        "</dc:title><dc:language>" +
        escapeHtml(languageCode(strings(metadata.language)[0] || "und")) +
        "</dc:language>" +
        strings(metadata.creators)
          .map((a) => "<dc:creator>" + escapeHtml(a) + "</dc:creator>")
          .join("") +
        '<meta property="dcterms:modified">' +
        new Date().toISOString().replace(/\.\d+Z$/, "Z") +
        '</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="preface" href="preface.xhtml" media-type="application/xhtml+xml"/>' +
        chapters
          .map(
            (_, i) =>
              `<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`,
          )
          .join("") +
        [...assets.values()]
          .map(
            (a, i) =>
              `<item id="a${i}" href="${a.file}" media-type="${a.mime}"/>`,
          )
          .join("") +
        '</manifest><spine><itemref idref="preface"/>' +
        chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("") +
        "</spine></package>",
    ),
    "package.opf",
  );
  zip.end();
  return { mime: "application/epub+zip", stream: zip.outputStream };
}
