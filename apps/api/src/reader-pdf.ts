import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser } from "playwright-core";
import { fail } from "./security";
import { escapeHtml } from "./reader-safety";
const {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  StandardFonts,
  rgb,
}: typeof import("pdf-lib") = createRequire(__filename)("pdf-lib");

const { chromium }: typeof import("playwright-core") =
  createRequire(__filename)("playwright-core");
const css: typeof import("css-tree") = createRequire(__filename)("css-tree");
let browser: Browser | undefined;
let directory: string | undefined;
let idle: NodeJS.Timeout | undefined;
let active: { key: string; promise: Promise<Buffer> } | undefined;
const cache = new Map<string, { bytes: Buffer; expires: number }>();
const maxBytes = 32 * 1024 * 1024;
let cacheBytes = 0;

async function closeBrowser() {
  if (idle) clearTimeout(idle);
  idle = undefined;
  const old = browser,
    path = directory;
  browser = undefined;
  directory = undefined;
  await old?.close().catch(() => {});
  if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
}
export async function closePdf() {
  await active?.promise.catch(() => {});
  await closeBrowser();
  cache.clear();
  cacheBytes = 0;
}

/** Call only after authorization and resolving the immutable snapshot. */
export async function cachedPdf(key: string, build: () => Promise<Buffer>) {
  const now = Date.now();
  for (const [id, entry] of cache)
    if (entry.expires <= now) {
      cache.delete(id);
      cacheBytes -= entry.bytes.length;
    }
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.bytes;
  }
  if (active?.key === key) return active.promise;
  if (active) fail("CONFLICT", 409);
  if (idle) clearTimeout(idle);
  const promise = Promise.resolve().then(build);
  active = { key, promise };
  try {
    const bytes = await promise;
    if (bytes.length <= maxBytes) {
      while (
        cache.size &&
        (cacheBytes + bytes.length > maxBytes || cache.size >= 8)
      ) {
        const first = cache.keys().next().value!;
        cacheBytes -= cache.get(first)!.bytes.length;
        cache.delete(first);
      }
      cache.set(key, { bytes, expires: Date.now() + 10 * 60_000 });
      cacheBytes += bytes.length;
    }
    return bytes;
  } finally {
    active = undefined;
    idle = setTimeout(() => void closeBrowser(), 60_000);
    idle.unref();
  }
}

export async function printPdf(
  html: string,
  resource: (token: string) => Promise<{ mime: string; bytes: Buffer } | null>,
  title: string,
  author: string,
) {
  if (!browser?.isConnected()) {
    await closeBrowser();
    directory = await mkdtemp(join(tmpdir(), "palimora-print-"));
    browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      headless: true,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
    });
  }
  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    viewport: { width: 507, height: 805 },
  });
  const timeout = setTimeout(
    () => void context.close().catch(() => {}),
    60_000,
  );
  timeout.unref();
  try {
    const origin = "https://palimora.invalid/";
    let resourceError: unknown;
    await context.route("**/*", async (route) => {
      try {
        const url = route.request().url();
        if (url === origin)
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: html,
          });
        const token = url.startsWith(origin) ? url.slice(origin.length) : "";
        if (/^palimora-asset-[a-f0-9]{64}$/.test(token)) {
          const asset = await resource(token);
          if (asset && /^(image|font)\//.test(asset.mime))
            return route.fulfill({
              contentType: asset.mime,
              body: asset.bytes,
            });
        }
        return route.abort();
      } catch (error) {
        resourceError = error;
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    await page.emulateMedia({ media: "print" });
    await page.goto(origin, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    if (resourceError) throw resourceError;
    // Printed prose is opt-in. Preserve short dialogue, verse, explicit alignment
    // and narrow work-skin columns rather than stretching a handful of words.
    await page.evaluate(() => {
      const prose: HTMLElement[] = [];
      for (const paragraph of document.querySelectorAll<HTMLElement>(
        ".pdf-story p",
      )) {
        const style = getComputedStyle(paragraph);
        const words = (paragraph.textContent ?? "").trim().split(/\s+/).length;
        if (
          words < 18 ||
          paragraph.querySelector("br,img,svg,code") ||
          paragraph.closest(
            "blockquote,pre,table,aside,.notes,.fff_chapter_notes",
          ) ||
          !["start", "left", "justify"].includes(style.textAlign) ||
          !["normal", "nowrap"].includes(style.whiteSpace)
        )
          continue;
        if (
          paragraph.getBoundingClientRect().width / parseFloat(style.fontSize) <
          22
        )
          continue;
        prose.push(paragraph);
      }
      for (const paragraph of prose) paragraph.classList.add("pdf-prose");
    });
    const bytes = await page.pdf({
      width: "170mm",
      height: "250mm",
      margin: { top: "18mm", bottom: "19mm", left: "18mm", right: "18mm" },
      printBackground: true,
    });
    return await finishPdf(bytes, title, author);
  } finally {
    clearTimeout(timeout);
    await context.close().catch(() => {});
  }
}

export function pdfDocument(
  title: string,
  language: string,
  preface: string,
  chapters: { title: string; body: string }[],
  style: string,
) {
  // Source print rules cannot change the book's page geometry.
  const sheet = css.parse(style);
  css.walk(sheet, {
    visit: "Atrule",
    enter(node, item, list) {
      if (node.name.toLowerCase() === "page") list.remove(item);
    },
  });
  style = css.generate(sheet);
  const contents = language === "it" ? "Indice" : "Contents";
  const head = `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
    @layer book;
    @page { size:170mm 250mm; margin:18mm 18mm 19mm; }
    *{box-sizing:border-box}html{color-scheme:light}body{margin:0;color:#222;background:white;font:11pt/1.4 'Noto Serif',Georgia,serif;overflow-wrap:break-word}a{color:inherit;text-decoration:none}p{margin:0;orphans:2;widows:2}h1,h2,h3,h4{line-height:1.25;break-after:avoid}img{max-width:100%;height:auto;max-height:185mm;object-fit:contain}pre{white-space:pre-wrap}table{max-width:100%;border-collapse:collapse}hr{border:0;border-top:.5pt solid #bbb;margin:1.5em auto;width:30%}blockquote{margin:1em 1.5em}audio,video{display:none}aside,.notes,.fff_chapter_notes{font-size:9.5pt;line-height:1.5;text-align:start}
    ${style}
    @layer book {
      html,body{margin:0!important;padding:0!important;width:auto!important;max-width:none!important;background:white!important;color:#222!important;font:11pt/1.4 'Noto Serif',Georgia,serif!important;text-align:start!important}
      .pdf-front{break-after:page!important;padding-top:12mm!important}
      .pdf-front h1{text-align:center!important;font-size:25pt!important;font-weight:500!important;margin:0 0 5mm!important;overflow-wrap:anywhere!important}
      .pdf-authors{text-align:center!important;font-size:13pt!important;margin:0 0 8mm!important}
      .pdf-front dl{display:grid!important;grid-template-columns:27mm minmax(0,1fr)!important;gap:2mm 4mm!important;font:9pt/1.5 'Noto Sans',sans-serif!important;margin:8mm 0 0!important}
      .pdf-front dt{font-weight:bold!important;margin:0!important;break-after:avoid!important}
      .pdf-front dd{margin:0!important;overflow-wrap:anywhere!important}
      .pdf-summary{font-size:10pt!important;white-space:pre-line!important;text-align:start!important;margin:10mm 0!important}
      .pdf-toc{break-after:page!important}
      .pdf-toc h2{text-align:center!important;font-size:18pt!important;margin:8mm 0 12mm!important}
      .pdf-toc ol{list-style:none!important;padding:0!important;margin:0!important}
      .pdf-toc li{padding-right:12mm!important;font-size:10pt!important;line-height:1.4!important;margin:0 0 1.5mm!important;break-inside:avoid!important;text-align:start!important}
      .pdf-chapter+.pdf-chapter{break-before:page!important}
      .pdf-chapter-heading{text-align:center!important;font-size:18pt!important;margin:8mm 0 12mm!important;font-weight:500!important}
      .pdf-prose{text-indent:1.15em!important;text-align:justify!important;text-align-last:start!important;hyphens:auto!important}
      .pdf-story p:not(.pdf-prose){text-align-last:auto!important}
    }
    </style></head><body>`;
  const toc = `<nav class="pdf-toc" aria-label="${contents}"><h2>${contents}</h2><ol>${chapters.map((c, i) => `<li><a href="#chapter-${i}">${escapeHtml(c.title)}</a></li>`).join("")}</ol></nav>`;
  return (
    head +
    preface +
    toc +
    `<main id="workskin" class="pdf-story">${chapters.map((c) => c.body).join("")}</main></body></html>`
  );
}

export function pdfPreface(
  title: string,
  metadata: Record<string, any>,
  language: string,
) {
  const it = language === "it";
  const value = (v: any) => (Array.isArray(v) ? v.join(", ") : String(v));
  const labels: Record<string, [string, string]> = {
    fandom: ["Fandom", "Fandom"],
    rating: ["Rating", "Rating"],
    warnings: ["Avvertenze", "Archive warnings"],
    category: ["Categorie", "Categories"],
    relationships: ["Relazioni", "Relationships"],
    characters: ["Personaggi", "Characters"],
    freeform: ["Altri tag", "Additional tags"],
    language: ["Lingua", "Language"],
    published: ["Pubblicazione", "Published"],
    updated: ["Aggiornamento", "Updated"],
    words: ["Parole", "Words"],
    chapter_count: ["Capitoli", "Chapters"],
    series: ["Serie", "Series"],
    collections: ["Collezioni", "Collections"],
    kudos: ["Kudos", "Kudos"],
    comments: ["Commenti", "Comments"],
    hits: ["Visite", "Hits"],
    bookmarks: ["Bookmark", "Bookmarks"],
  };
  const authors = metadata.creators ? value(metadata.creators) : "";
  return `<header class="pdf-front"><h1>${escapeHtml(title)}</h1>${authors ? `<p class="pdf-authors">${escapeHtml(authors)}</p>` : ""}${metadata.summary ? `<div class="pdf-summary">${escapeHtml(String(metadata.summary))}</div>` : ""}<dl>${Object.entries(
    labels,
  )
    .filter(
      ([k]) =>
        metadata[k] !== undefined &&
        metadata[k] !== null &&
        value(metadata[k]) !== "",
    )
    .map(
      ([k, label]) =>
        `<dt>${label[it ? 0 : 1]}</dt><dd>${escapeHtml(value(metadata[k]))}</dd>`,
    )
    .join("")}</dl></header>`;
}

/** Add folios and TOC page numbers without a second browser pagination pass. */
async function finishPdf(bytes: Buffer, title: string, author: string) {
  const book = await PDFDocument.load(bytes);
  book.setTitle(title);
  if (author) book.setAuthor(author);
  book.setCreator("Palimora");
  const pages = book.getPages();
  const refs = new Map(pages.map((page, i) => [page.ref.toString(), i]));
  const font = await book.embedFont(StandardFonts.TimesRoman);
  let storyStart = Infinity;
  for (const [index, page] of pages.entries()) {
    if (index > 0) {
      const number = String(index + 1);
      page.drawText(number, {
        x: (page.getWidth() - font.widthOfTextAtSize(number, 8)) / 2,
        y: 25,
        size: 8,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
    if (index >= storyStart) continue;
    const annotations = page.node.Annots();
    const numbers = new Map<number, number>();
    for (let i = 0; annotations && i < annotations.size(); i++) {
      const annotation = annotations.lookup(i, PDFDict);
      const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
      let destination =
        annotation.lookup(PDFName.of("Dest")) ??
        action?.lookup(PDFName.of("D"));
      if (destination instanceof PDFName)
        destination = book.catalog
          .lookupMaybe(PDFName.of("Dests"), PDFDict)
          ?.lookup(destination);
      if (destination instanceof PDFDict)
        destination = destination.lookup(PDFName.of("D"));
      const target =
        destination instanceof PDFArray
          ? refs.get(destination.get(0).toString())
          : undefined;
      if (target === undefined || target <= index) continue;
      storyStart = Math.min(storyStart, target);
      const rect = annotation
        .lookup(PDFName.of("Rect"), PDFArray)
        .asRectangle();
      numbers.set(
        target + 1,
        Math.min(numbers.get(target + 1) ?? Infinity, rect.y),
      );
    }
    for (const [number, y] of numbers) {
      const label = String(number);
      page.drawText(label, {
        x:
          page.getWidth() -
          (18 * 72) / 25.4 -
          font.widthOfTextAtSize(label, 10),
        y: y + 2,
        size: 10,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
  }
  return Buffer.from(await book.save());
}
