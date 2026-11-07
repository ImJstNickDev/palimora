import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const { PDFDocument, PDFArray, PDFDict, PDFName }: typeof import("pdf-lib") =
  createRequire(__filename)("pdf-lib");
import {
  cachedPdf,
  closePdf,
  pdfDocument,
  pdfPreface,
  printPdf,
} from "../apps/api/src/reader-pdf";

test("book PDF keeps source content local, preserves TOC destinations and shares immutable renders", async () => {
  let requests = 0,
    builds = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("remote");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const remote = `http://127.0.0.1:${address.port}/must-not-load`;
  const title = "Book & <source>";
  const html = pdfDocument(
    title,
    "en",
    pdfPreface(
      title,
      { creators: ["Original author"], words: 42, summary: "Source summary" },
      "en",
    ),
    [
      {
        title: "First chapter",
        body: `<section class="pdf-chapter" id="chapter-0"><h2>First chapter</h2><p>This is a sufficiently long paragraph with several sentences so that normal prose can be laid out as a book.</p><p>Three short words<br>Four more short words</p><img src="${remote}"><script>fetch('${remote}')</script></section>`,
      },
      {
        title: "Second chapter",
        body: '<section class="pdf-chapter" id="chapter-1"><h2>Second chapter</h2><p>Preserved ending.</p></section>',
      },
    ],
    "",
  );
  try {
    const build = async () => {
      builds++;
      return printPdf(html, async () => null, title, "Original author");
    };
    const first = cachedPdf("snapshot-a", build);
    const joined = cachedPdf("snapshot-a", build);
    await assert.rejects(cachedPdf("snapshot-b", build));
    const [bytes, duplicate] = await Promise.all([first, joined]);
    assert.equal(builds, 1);
    assert.deepEqual(duplicate, bytes);
    assert.deepEqual(await cachedPdf("snapshot-a", build), bytes);
    assert.equal(builds, 1);
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getTitle(), title);
    assert.equal(pdf.getAuthor(), "Original author");
    assert.equal(pdf.getPageCount(), 4);
    const refs = new Map(pdf.getPages().map((p, i) => [p.ref.toString(), i]));
    const annotations = pdf.getPage(1).node.Annots()!;
    const destinations = Array.from({ length: annotations.size() }, (_, i) => {
      const annotation = annotations.lookup(i, PDFDict);
      const name = annotation.lookup(PDFName.of("Dest"), PDFName);
      const destination = pdf.catalog
        .lookup(PDFName.of("Dests"), PDFDict)
        .lookup(name, PDFArray);
      return refs.get(destination.get(0).toString());
    });
    assert.deepEqual(destinations, [2, 3]);
    assert.equal(requests, 0);
    await assert.rejects(
      cachedPdf("failed", async () => {
        throw Error("render failed");
      }),
    );
    assert.deepEqual(await cachedPdf("failed", async () => bytes), bytes);
  } finally {
    await closePdf();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native book composition keeps links, Unicode and local images, and declines unsupported skins", async () => {
  const { typesetPdf } = await import("../apps/api/src/reader-typeset");
  const token = "palimora-asset-" + "a".repeat(64);
  const title = '#panic("must remain text") · à';
  const chapters = [
    {
      title: "Start",
      body: `<section id="chapter-0"><h2 class="pdf-chapter-heading">Start</h2><aside><p>Original opening note.</p></aside><p>Dialogue<br>Another short line</p><p><em>two</em> <strong>words</strong>, café.</p><p><a href="#chapter-1">Next chapter</a></p><img src="${token}" alt="Local image"><ul><li>One</li><li>Two</li></ul></section>`,
    },
    {
      title: "End",
      body: '<section id="chapter-1"><h2 class="pdf-chapter-heading">End</h2><p>A final paragraph.</p><p><a href="https://archiveofourown.org/works/1">Original</a></p><aside><p>Original closing note.</p></aside></section>',
    },
  ];
  let resources = 0;
  const resource = async (requested: string) => {
    assert.equal(requested, token);
    resources++;
    return {
      mime: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
      ),
    };
  };
  const preface = pdfPreface(title, { creators: ["Author"], words: 42 }, "en");
  const bytes = await typesetPdf(
    title,
    "Author",
    "en",
    preface,
    chapters,
    "h2{text-align:center}",
    resource,
  );
  assert.ok(bytes);
  assert.equal(resources, 1);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getTitle(), title);
  assert.equal(pdf.getAuthor(), "Author");
  assert.equal(pdf.getPageCount(), 4);
  const refs = new Map(pdf.getPages().map((p, i) => [p.ref.toString(), i]));
  const annotations = pdf.getPage(1).node.Annots()!;
  const targets = new Set<number | undefined>();
  for (let i = 0; i < annotations.size(); i++) {
    const a = annotations.lookup(i, PDFDict);
    const destination = a.lookup(PDFName.of("Dest"), PDFArray);
    targets.add(refs.get(destination.get(0).toString()));
  }
  assert.deepEqual([...targets], [2, 3]);
  assert.equal(
    await typesetPdf(
      title,
      "Author",
      "en",
      preface,
      chapters,
      ".chat{display:grid;grid-template-columns:1fr 1fr}",
      resource,
    ),
    null,
  );
  assert.equal(
    await typesetPdf(
      title,
      "Author",
      "en",
      preface,
      [
        {
          title: "Table",
          body: "<table><tr><td>Preserve layout</td></tr></table>",
        },
      ],
      "",
      resource,
    ),
    null,
  );
  assert.equal(
    resources,
    1,
    "unsupported layouts are declined before any asset reads",
  );
});
