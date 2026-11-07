import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const localRequire = createRequire(__filename);
const { parseDocument }: typeof import("htmlparser2") =
  localRequire("htmlparser2");
const css: typeof import("css-tree") = localRequire("css-tree");
const execute = promisify(execFile);

type Node = {
  kind: string;
  text?: string;
  children?: Node[];
  id?: string;
  href?: string;
  src?: string;
  align?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  smallcaps?: boolean;
  start?: number;
  justify?: boolean;
};
type Resource = (
  token: string,
) => Promise<{ mime: string; bytes: Buffer } | null>;
// Only the conventional download stylesheet has a native equivalent. Anything
// else uses the HTML renderer, including selectors whose cascade we cannot model.
const conventional: Record<string, string> = {
  body: "background-color:#ffffff;text-align:justify;margin:2%",
  pre: "font-size:x-small",
  sml: "font-size:small",
  h1: "text-align:center",
  h2: "text-align:center",
  h3: "text-align:center",
  h4: "text-align:center",
  h5: "text-align:center",
  h6: "text-align:center",
  ".CI": "text-align:center;margin-top:0px;margin-bottom:0px;padding:0px",
  ".center": "text-align:center",
  ".cover": "text-align:center",
  ".full": "width:100%",
  ".quarter": "width:25%",
  ".smcap": "font-variant:small-caps",
  ".u": "text-decoration:underline",
  ".bold": "font-weight:bold",
};
function supportedCss(source: string) {
  try {
    const ast = css.parse(source);
    return (
      ast.type === "StyleSheet" &&
      ast.children
        .toArray()
        .every(
          (rule) =>
            rule.type === "Rule" &&
            rule.prelude &&
            conventional[css.generate(rule.prelude)] ===
              css.generate(rule.block).slice(1, -1),
        )
    );
  } catch {
    return false;
  }
}
class Unsupported extends Error {}
const textOf = (n: any): string =>
  n.type === "text" ? n.data : (n.children ?? []).map(textOf).join("");

/** Returns null before rendering when the source requires browser layout.
 * Text is JSON data, never Typst code; the fixed template has no eval/import.
 */
export async function typesetPdf(
  title: string,
  author: string,
  language: string,
  preface: string,
  chapters: { title: string; body: string }[],
  style: string,
  resource: Resource,
): Promise<Buffer | null> {
  if (!supportedCss(style)) return null;
  const ids = new Set<string>(),
    images = new Set<string>();
  const convert = (n: any): Node[] => {
    if (n.type === "text") {
      const block =
        /^(p|div|section|main|article|h[1-6]|aside|ul|ol|li|blockquote|pre|hr)$/;
      if (
        !/[^\t\n\f\r ]/.test(n.data) &&
        (!n.prev ||
          !n.next ||
          block.test(n.prev.name ?? "") ||
          block.test(n.next.name ?? ""))
      )
        return [];
      return [
        {
          kind: "text",
          text: n.data.replace(/[ \t\n\r\f]+/g, " "),
        },
      ];
    }
    if (n.type === "comment") return [];
    if (n.type !== "tag") throw new Unsupported();
    const a = n.attribs ?? {},
      kind = n.name;
    if (
      !/^(p|div|section|main|article|span|b|strong|i|em|u|s|strike|del|small|sml|sub|sup|br|hr|blockquote|pre|code|ul|ol|li|a|img|h[1-6]|aside)$/.test(
        kind,
      )
    )
      throw new Unsupported();
    if (kind === "pre") throw new Unsupported();
    const out: Node = { kind };
    if (a.id && a.name && a.id !== a.name) throw new Unsupported();
    const id = a.id || (kind === "a" ? a.name : undefined);
    if (id && !ids.has(id)) {
      ids.add(id);
      out.id = id;
    }
    if (/^h[1-6]$/.test(kind) && style.includes(kind + "{text-align:center}"))
      out.align = "center";
    if (
      (kind === "ul" || kind === "ol") &&
      n.children.some(
        (c: any) =>
          c.name !== "li" &&
          !(c.type === "text" && !c.data.trim()) &&
          c.type !== "comment",
      )
    )
      throw new Unsupported();
    if (a.align) {
      if (!/^(left|right|center|justify)$/.test(a.align))
        throw new Unsupported();
      out.align = a.align;
    }
    const classes = (a.class ?? "").split(/\s+/);
    if (classes.some((c: string) => ["full", "quarter"].includes(c)))
      throw new Unsupported();
    if (classes.some((c: string) => ["CI", "center", "cover"].includes(c)))
      out.align = "center";
    if (classes.includes("smcap")) out.smallcaps = true;
    if (classes.includes("u")) out.underline = true;
    if (classes.includes("bold")) out.bold = true;
    if (classes.includes("pdf-chapter-heading")) out.kind = "chapter-heading";
    if (classes.some((c: string) => ["notes", "fff_chapter_notes"].includes(c)))
      out.kind = "aside";
    if (a.style) {
      const declarations = css.parse(a.style, { context: "declarationList" });
      if (declarations.type !== "DeclarationList") throw new Unsupported();
      declarations.children.forEach((d) => {
        if (d.type !== "Declaration") throw new Unsupported();
        const value = css.generate(d.value);
        if (
          d.property === "text-align" &&
          /^(left|right|center|justify)$/.test(value)
        )
          out.align = value;
        else if (d.property === "font-weight" && /^(bold|700)$/.test(value))
          out.bold = true;
        else if (d.property === "font-style" && value === "italic")
          out.italic = true;
        else if (d.property === "text-decoration" && value === "underline")
          out.underline = true;
        else if (d.property === "text-decoration" && value === "line-through")
          out.strike = true;
        else if (d.property === "font-variant" && value === "small-caps")
          out.smallcaps = true;
        else throw new Unsupported();
      });
    }
    if (
      out.align &&
      !/^(p|div|section|main|article|aside|blockquote|h[1-6])$/.test(kind)
    )
      throw new Unsupported();
    // Geometry and list counters not represented below must retain HTML layout.
    if (
      a.width ||
      a.height ||
      a.hidden ||
      a.dir ||
      a.lang ||
      a.value ||
      a.reversed ||
      a.type
    )
      throw new Unsupported();
    if (kind === "ol" && a.start) {
      out.start = Number(a.start);
      if (!Number.isSafeInteger(out.start) || out.start! < 1)
        throw new Unsupported();
    }
    if (kind === "img") {
      if (!/^palimora-asset-[a-f0-9]{64}$/.test(a.src ?? ""))
        throw new Unsupported();
      images.add(a.src);
      out.src = a.src;
      out.text = a.alt || "";
    }
    if (kind === "a" && a.href) {
      if (!/^(#|https?:\/\/|mailto:)/i.test(a.href)) throw new Unsupported();
      out.href = a.href;
    }
    out.children = (n.children ?? []).flatMap((child: any) => convert(child));
    if (
      out.kind === "p" &&
      Object.keys(out).length === 2 &&
      out.children!.every((c) => c.kind === "text")
    ) {
      const text = out.children!.map((c) => c.text).join("");
      return [
        {
          kind: "paragraph",
          text,
          justify: text.trim().split(/\s+/).length >= 18,
        },
      ];
    }
    return [out];
  };
  let story: { title: string; nodes: Node[] }[];
  try {
    story = chapters.map((c) => ({
      title: c.title,
      nodes: parseDocument(c.body).children.flatMap((n) => convert(n)),
    }));
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
  const front: Record<string, any> = { title, author, summary: "", rows: [] };
  const header: any = parseDocument(preface).children[0];
  for (const n of header?.children ?? []) {
    if (n.attribs?.class === "pdf-summary") front.summary = textOf(n);
    if (n.name === "dl") {
      let label = "";
      for (const entry of n.children) {
        if (entry.name === "dt") label = textOf(entry);
        if (entry.name === "dd") front.rows.push([label, textOf(entry)]);
      }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "palimora-typeset-"));
  try {
    const files: Record<string, string> = {};
    for (const token of images) {
      const asset = await resource(token);
      const extension =
        asset &&
        (
          {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/svg+xml": "svg",
          } as Record<string, string>
        )[asset.mime];
      if (!asset || !extension) return null;
      files[token] = token + "." + extension;
      await writeFile(join(directory, files[token]), asset.bytes);
    }
    await writeFile(
      join(directory, "book.json"),
      JSON.stringify({ front, story, language, ids: [...ids], files }),
    );
    await writeFile(join(directory, "book.typ"), template);
    try {
      await execute(
        process.env.TYPST_PATH || "/usr/local/bin/typst",
        [
          "compile",
          "--root",
          directory,
          "--jobs",
          "2",
          "--no-pdf-tags",
          "book.typ",
          "book.pdf",
        ],
        { cwd: directory, timeout: 60_000, maxBuffer: 64 * 1024 },
      );
    } catch (error) {
      // Malformed images or unsupported native layout must not prevent export.
      // Keep source content and compiler diagnostics out of application logs.
      if ((error as { code?: unknown }).code === 1) {
        console.warn(
          JSON.stringify({ event: "pdf_native_fallback", reason: "layout" }),
        );
        return null;
      }
      throw new Error(
        `PDF_RENDER_FAILED (${(error as NodeJS.ErrnoException).code ?? "process"})`,
      );
    }
    return await readFile(join(directory, "book.pdf"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const template = String.raw`
#let book = json("book.json")
#set document(title: book.front.title, author: book.front.author)
#set page(width: 170mm, height: 250mm, margin: (top:18mm,bottom:19mm,left:18mm,right:18mm), numbering: "1", number-align: center, footer: context { if counter(page).get().first() > 1 { align(center, text(size:8pt, fill: luma(100), counter(page).display())) } })
#set text(font: ("Noto Serif", "Noto Sans", "Noto Sans CJK SC"), size:11pt, lang: book.language)
#set par(leading: .7em, spacing: .7em, first-line-indent: (amount: 1.15em, all: true), linebreaks: "simple")
#set heading(numbering: none)
#show heading.where(level: 1): it => block(above:8mm, below:12mm, width:100%)[#align(center)[#text(size:18pt, weight:"regular", it.body)]]
#let plain(nodes) = nodes.map(n => if n.kind == "text" { n.text } else { plain(n.at("children", default:())) }).join("")
#let render(nodes, prose: true) = {
  for n in nodes {
    let k = n.kind
    if k == "text" { text(n.text); continue }
    if k == "paragraph" { par(justify:prose and n.justify, text(n.text)); continue }
    let children = n.at("children", default:())
    let value = if k == "text" { text(n.text) }
    else if k == "br" { linebreak() }
    else if k == "hr" { block(above:1em, below:1em, width:100%)[#align(center)[#line(length:30%, stroke:.5pt + luma(180))]] }
    else if k == "img" { block(above:1em, below:1em)[#context {
      let path = book.files.at(n.src)
      let natural = measure(image(path))
      let scale = calc.min(1, 134mm / natural.width, 185mm / natural.height)
      image(path, width:natural.width * scale, alt:n.text)
    }] }
    else if k == "code" { raw(plain(children)) }
    else if k == "chapter-heading" { heading(level:1, render(children, prose:false)) }
    else if k in ("h1", "h2", "h3", "h4", "h5", "h6") { block(above:1em, below:1em, text(size:14pt, weight:"bold", render(children, prose:false))) }
    else if k == "ul" { list(..children.filter(c => c.kind == "li").map(c => render(c.children, prose:false))) }
    else if k == "ol" { enum(start:n.at("start", default:1), ..children.filter(c => c.kind == "li").map(c => render(c.children, prose:false))) }
    else if k == "blockquote" { block(inset:(left:1.5em, right:1.5em), above:1em, below:1em, render(children, prose:false)) }
    else if k == "aside" { block(above:1em, below:1em, text(size:9.5pt, render(children, prose:false))) }
    else if k == "p" {
      let justify = prose and plain(children).trim().split(regex("\\s+")).len() >= 18 and not children.any(c => c.kind in ("br", "img", "code")) and n.at("align", default:"left") in ("left", "justify")
      par(justify:justify, render(children, prose:prose))
    } else if k in ("div", "section", "main", "article") {
      parbreak(); render(children, prose:prose and n.at("align", default:"left") in ("left", "justify")); parbreak()
    } else { render(children, prose:prose) }
    if k in ("b", "strong") or n.at("bold", default:false) { value = strong(value) }
    if k in ("i", "em") or n.at("italic", default:false) { value = emph(value) }
    if k == "u" or n.at("underline", default:false) { value = underline(value) }
    if k in ("s", "strike", "del") or n.at("strike", default:false) { value = strike(value) }
    if n.at("smallcaps", default:false) { value = smallcaps(value) }
    if k in ("small", "sml") { value = text(size:.85em, value) }
    if k == "sub" { value = sub(value) }
    if k == "sup" { value = super(value) }
    if n.at("href", default:none) != none {
      let href = n.href
      if href.starts-with("#") { if href.slice(1) in book.ids { value = link(label(href.slice(1)), value) } }
      else { value = link(href, value) }
    }
    if n.at("align", default:none) in ("center", "right", "left") {
      value = align(("center":center, "right":right, "left":left).at(n.align), value)
    }
    if n.at("id", default:none) != none { [#metadata(n.id)#label(n.id)] }
    value
  }
}
#v(12mm)
#align(center)[#text(size:25pt, book.front.title)#v(5mm)#text(size:13pt, book.front.author)]
#v(8mm)
#set par(first-line-indent:0pt)
#text(size:10pt, book.front.summary)
#v(8mm)
#text(font:"Noto Sans", size:9pt)[#grid(columns:(27mm, 1fr), gutter:4mm, row-gutter:2mm, ..book.front.rows.map(row => (strong(row.at(0)), row.at(1))).flatten())]
#pagebreak()
#outline(title:if book.language == "it" { [Indice] } else { [Contents] }, target:heading.where(level:1))
#pagebreak()
#set par(first-line-indent:(amount:1.15em, all:true))
#for (i, chapter) in book.story.enumerate() {
  if i > 0 { pagebreak(weak:true) }
  render(chapter.nodes)
}
`;
