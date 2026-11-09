import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  compileManifest,
  compileStorageManifest,
} from "../apps/api/src/archive-native";
import {
  resolveCanonical,
  textChapter,
  digest,
  writeArchive,
  openChain,
  canonicalManifest,
  objectBytes,
} from "@palimora/archive-format";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("versioned TXT recipe is byte-identical to Python html.escape and strip", () => {
  const bodies = [
    "",
    "   ",
    "\u001c\u0085\u2000é 😀 & < > \" '\u001f",
    "\ufeffBody\r\nNext\n  end",
    "é<&".repeat(300000),
  ];
  for (const body of bodies)
    for (const eol of ["\n", "\r\n"]) {
      const source = Buffer.from(
        "\ufeffTitle" +
          eol +
          "by Author" +
          eol +
          "Story URL: https://archiveofourown.org/works/123" +
          eol.repeat(4) +
          body,
      );
      const r = spawnSync(
        "python3",
        [
          "-c",
          `import sys,json,html,base64\nsys.path.insert(0,'apps/ingest-adapters')\nimport ao3\ndata=sys.stdin.buffer.read();r=ao3.text_record(data)\ntext=data.decode('utf-8-sig');url=ao3.re.search(r'^Story URL: (.+)$',text,ao3.re.M);end=text.find('\\n\\n\\n\\n',url.end());end=url.end() if end<0 else end\nprint(json.dumps(dict(record=r,expected=base64.b64encode(('<pre>'+html.escape(text[end:].strip())+'</pre>').encode()).decode())))`,
        ],
        {
          input: source,
          env: { ...process.env, PALIMORA_HTML_SCANNER: "python" },
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      assert.equal(r.status, 0, r.stderr.toString());
      const { record, expected } = JSON.parse(r.stdout.toString());
      assert.equal(record.objects.length, 1);
      assert.equal(record.objects[0].kind, "source_text");
      const chapter = { ...record.chapters[0], hash: digest(source) };
      assert.deepEqual(
        textChapter(source, chapter),
        Buffer.from(expected, "base64"),
      );
      assert.throws(
        () => textChapter(Buffer.concat([source, Buffer.from("x")]), chapter),
        /INTEGRITY/,
      );
      assert.throws(
        () =>
          textChapter(source, {
            ...chapter,
            transform: { ...chapter.transform, schema: "unknown" },
          }),
        /VERSION/,
      );
    }
});

test("v1 bytes remain stable; v2 resolves exact metadata and rejects corruption", async () => {
  const m = {
    schema: "palimora-canonical-v2",
    work_id: "fixture",
    metadata: { title: "é", empty: [], missing: null },
    chapters: [],
    objects: [],
    state: "valid",
  };
  const [md, manifest] = compileManifest(m);
  const raw = JSON.parse(manifest.bytes.toString());
  assert.equal("metadata" in raw, false);
  assert.deepEqual(
    resolveCanonical(raw, new Map([[md.hash, md.bytes]])).metadata,
    m.metadata,
  );
  assert.throws(() => resolveCanonical(raw, new Map()), /MISSING/);
  assert.throws(
    () => resolveCanonical(raw, new Map([[md.hash, Buffer.from("{}")]])),
    /HASH/,
  );
  const legacy = { ...m, schema: "palimora-canonical-v1" };
  assert.deepEqual(
    resolveCanonical(
      JSON.parse(compileManifest(legacy)[1].bytes.toString()),
      new Map(),
    ).metadata,
    m.metadata,
  );
  const unified = await compileStorageManifest({
    ...m,
    state: "metadata_only",
  });
  assert.equal(unified[0].hash, unified[1].hash);
  assert.deepEqual(
    resolveCanonical(JSON.parse(unified[1].bytes.toString()), new Map())
      .metadata,
    m.metadata,
  );
  const root = await mkdtemp(join(tmpdir(), "palimora-canonical-"));
  try {
    await writeArchive({
      root: join(root, "archive"),
      origin: "test",
      catalog: {},
      objects: [
        { kind: "metadata", bytes: md.bytes },
        { kind: "manifest", bytes: manifest.bytes },
      ],
    });
    const chain = await openChain([join(root, "archive")]);
    assert.deepEqual(
      (await canonicalManifest(chain, manifest.hash)).metadata,
      m.metadata,
    );
    assert.deepEqual(await objectBytes(chain, md.hash), md.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compact chapter table preserves identities, order, notes and offsets", async () => {
  const objects = Array.from({ length: 400 }, (_, i) => ({
    name: `chapter-${i}.html`,
    kind: "chapter_html",
    hash: digest(`chapter ${i}`),
  }));
  const chapters = objects.map((o, i) => ({
    name: o.name,
    hash: o.hash,
    chapter_id: `chapter-${i}`,
    revision_id: `revision-${i}`,
    notes: [{ name: "notes.html", offset: i + 10 }],
    source_html_sha256: o.hash,
  }));
  objects.push({
    name: "notes.html",
    kind: "notes_html",
    hash: digest("note"),
  });
  const m = {
    schema: "palimora-canonical-v2",
    metadata: { title: "Long fixture" },
    work_id: "fixture",
    external_id: "123",
    chapters,
    objects,
    state: "valid",
  };
  const [md, compiled] = await compileStorageManifest(m);
  const raw = JSON.parse(compiled.bytes.toString());
  const resolved = resolveCanonical(raw, new Map([[md.hash, md.bytes]]));
  assert.deepEqual(resolved.chapters, chapters);
  assert.deepEqual(resolved.objects, objects);
  if ("object_ref" in raw.chapters[0]) {
    raw.chapters[0].object_ref = 99999;
    assert.throws(
      () => resolveCanonical(raw, new Map([[md.hash, md.bytes]])),
      /REFERENCE/,
    );
  }
});

test("standalone CLI renders a virtual historical TXT without database or source dump", async () => {
  const root = await mkdtemp(join(tmpdir(), "palimora-standalone-txt-"));
  const source = Buffer.from("é & <body>");
  const expected = Buffer.from("<pre>é &amp; &lt;body&gt;</pre>");
  const chapter = {
    name: "work.html",
    source_object: "original.txt",
    chapter_id: "chapter",
    revision_id: "revision",
    hash: digest(source),
    source_html_sha256: digest(expected),
    transform: {
      schema: "palimora-text-html-v1",
      offset: 0,
      length: source.length,
      size: source.length,
      output_size: expected.length,
    },
  };
  const m = {
    schema: "palimora-canonical-v2",
    work_id: "work",
    metadata: { title: "Historic" },
    state: "valid",
    chapters: [chapter],
    objects: [
      { name: "original.txt", kind: "source_text", hash: digest(source) },
    ],
  };
  const [md, manifest] = await compileStorageManifest(m);
  try {
    await writeArchive({
      root: join(root, "archive"),
      origin: "test",
      catalog: {},
      objects: [
        { kind: "source_text", bytes: source },
        { kind: "metadata", bytes: md.bytes },
        { kind: "manifest", bytes: manifest.bytes },
      ],
    });
    const result = spawnSync(
      process.execPath,
      [
        "packages/archive-cli/cli.cjs",
        "chapter",
        manifest.hash,
        "chapter",
        join(root, "archive"),
      ],
      { env: { PATH: process.env.PATH } },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
