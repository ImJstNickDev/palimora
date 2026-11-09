import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeCss, safeHtml } from "../apps/api/src/reader-safety";

// Storage modules are loaded only after the isolated connection is configured.
test("work skins remove executable content without removing local styling", () => {
  assert.match(safeCss("@media(max-width:500px){p{color:red}}"), /@media/);
  assert.match(
    safeCss("p{background:url(image.png)}", () => "/api/v1/works/w/media/h"),
    /\/api\/v1/,
  );
  assert.doesNotMatch(
    safeCss(
      "p{background:url(https://bad.test);position:fixed;behavior:url(x)}",
    ),
    /bad\.test|fixed|behavior/,
  );
  assert.doesNotMatch(
    safeCss('p{background:image-set("/api/private" 1x)}'),
    /private/,
  );
  assert.doesNotMatch(
    safeHtml(
      '<video src="https://bad.test/v" poster="https://bad.test/p"><source src="https://bad.test/s"></video>',
    ),
    /bad\.test/,
  );
});
test(
  "AO3 search, wrangling, bibliography and source interactions use canonical snapshots",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    assert.ok(
      process.env.OPENSEARCH_URL,
      "OpenSearch is required for this integration",
    );
    const root = await mkdtemp(join(tmpdir(), "palimora-ao3-")),
      url = new URL(process.env.TEST_DATABASE_URL!),
      schema = "test_ao3_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = url.toString();
    process.env.ARCHIVE_ROOT = root;
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { ingestRecord } = await import("../apps/api/src/archive");
    const { projectCatalog, catalogOperation } = await import(
      "../apps/api/src/catalog"
    );
    const search = await import("../apps/api/src/catalog-search");
    try {
      const { byteRange, safeSvg } = await import(
        "../apps/api/src/reader-media"
      );
      assert.equal(byteRange("bytes=25-", 20), null);
      assert.deepEqual(byteRange("bytes=-3", 20), {
        start: 17,
        end: 19,
        partial: true,
      });
      assert.doesNotMatch(
        safeSvg(
          Buffer.from(
            '<svg><script>bad()</script><use href="https://bad.test/a"/><path d="M0 0L1 1"/></svg>',
          ),
        ).toString(),
        /script|https:/,
      );
      await migrate();
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "absent-ao3.zip",
          fingerprint: "ao3-fixture",
        };
      await pool.query(
        "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
        [batch],
      );
      await pool.query(
        "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
        [source.id, batch, source.path, source.fingerprint],
      );
      for (const e of [
        { id: 1, type: "Freeform", name: "Space", canonical: 1 },
        {
          id: 2,
          type: "Freeform",
          name: "Star travel",
          canonical: 0,
          merger_id: 1,
        },
        { id: 3, type: "Freeform", name: "Voyages", canonical: 1 },
        {
          id: 4,
          type: "Freeform",
          name: "Lunar voyages",
          canonical: 1,
          meta_tags: ["3"],
        },
        { id: 5, type: "Fandom", name: "Moon", canonical: 1 },
        {
          id: 6,
          type: "Fandom",
          name: "Moon adaptation",
          canonical: 1,
          meta_tags: ["5"],
        },
      ])
        await pool.query("INSERT INTO archive_tags VALUES($1,$2)", [
          String(e.id),
          e,
        ]);
      const wav = Buffer.alloc(128);
      wav.write("RIFF");
      wav.writeUInt32LE(120, 4);
      wav.write("WAVE", 8);
      const parts = [wav.subarray(0, 64), wav.subarray(64)],
        hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      const object = (name: string, kind: string, data: Buffer) => ({
        name,
        kind,
        data: data.toString("base64"),
      });
      const record = (n: number) => ({
        external_id: String(900000 + n),
        source_entry: "work" + n,
        metadata: {
          title: ["Moon " + n],
          creators: ["Writer"],
          language: n === 1 ? ["English"] : n === 2 ? ["Italiano"] : undefined,
          words: n * 100,
          kudos: n === 2 ? undefined : n,
          published: "2024-01-01",
          updated: "2024-02-0" + n,
          fandom: ["Moon", "Moon adaptation"],
          ao3: {
            schema: "palimora-ao3-v1",
            complete: n === 1,
            expected_chapters: n === 1 ? 1 : 3,
            tags: [
              {
                id: n === 1 ? "2" : "4",
                kind: "freeform",
                name: n === 1 ? "Star travel" : "Lunar voyages",
              },
            ],
            authors: [
              {
                id: "writer",
                name: "Writer",
                url: "https://archiveofourown.org/users/writer",
                description: "Biography",
              },
            ],
            pseuds: [
              {
                id: "writer/pen",
                name: "Pen",
                owner_id: "writer",
                url: "https://archiveofourown.org/users/writer/pseuds/pen",
              },
            ],
            series:
              n === 3
                ? undefined
                : [{ id: "12", name: "Voyage series", position: n }],
            collections: [
              {
                id: "moon_archive",
                name: "Moon archive",
                description: "Collection description",
              },
            ],
            comments:
              n === 1
                ? [
                    {
                      id: "c1",
                      author: "Reader",
                      html: "<p>Lovely <script>bad()</script></p>",
                      posted_at: "2024-02-02",
                    },
                    {
                      id: "c2",
                      parent_id: "c1",
                      author: "Writer",
                      html: "<p>Thank you</p>",
                    },
                  ]
                : undefined,
            kudos:
              n === 1 ? { users: [{ name: "Reader" }], guests: 2 } : undefined,
          },
        },
        chapters: [{ name: "chapter.xhtml" }],
        objects: [
          object(
            "preface.html",
            "document_html",
            Buffer.from(
              `<dl><dd>Part ${n} of <a href="https://archiveofourown.org/series/12">Voyage series</a>, Part ${n + 5} of <a href="https://archiveofourown.org/series/90">Other series</a></dd></dl>`,
            ),
          ),
          object(
            "chapter.xhtml",
            "chapter_html",
            Buffer.from(
              '<p>Exploring lunar oceans.</p><audio src="voice.wav" controls></audio>',
            ),
          ),
          object(
            "skin.css",
            "css",
            Buffer.from("@media(min-width:10px){p{color:blue}}"),
          ),
          object(
            "voice.wav",
            "chunk_manifest",
            Buffer.from(
              JSON.stringify({
                schema: "palimora-chunks-v1",
                size: wav.length,
                sha256: hash(wav),
                chunks: parts.map((b) => ({ hash: hash(b), size: b.length })),
              }),
            ),
          ),
          ...parts.map((b, i) => object("part" + i, "asset", b)),
        ],
        state: "valid",
        observed_at: null,
      });
      for (let n = 1; n <= 3; n++)
        await ingestRecord(source, {
          record: record(n),
          locator: "work" + n,
          parser: "test-ao3",
          cursor: n,
        });
      const drain = async () => {
        for (let i = 0; i < 20; i++) {
          await projectCatalog();
          if (
            !(
              await pool.query(
                "SELECT 1 FROM catalog_pending UNION ALL SELECT 1 FROM catalog_snapshot_pending UNION ALL SELECT 1 FROM catalog_graph_pending LIMIT 1",
              )
            ).rowCount
          )
            break;
        }
        while (await search.projectText()) {}
        await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh");
      };
      await drain();
      const stored = await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_search",
        {
          size: 1,
          query: { match_all: {} },
        },
      );
      assert.equal(Object.hasOwn(stored.hits.hits[0]._source, "text"), false);
      // Rebuild uses canonical packs/SQL, never stored full text or dump files.
      const indexed = await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_search",
        {
          size: 100,
          sort: [{ id: "asc" }],
          _source: false,
          docvalue_fields: ["generation"],
          query: { match_all: {} },
        },
      );
      await search.searchRequest(
        "/" + search.SEARCH_INDEX,
        undefined,
        "DELETE",
      );
      assert.equal(await search.ensureSearchIndex(), true);
      await drain();
      const rebuilt = await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_search",
        {
          size: 100,
          sort: [{ id: "asc" }],
          _source: false,
          docvalue_fields: ["generation"],
          query: { match_all: {} },
        },
      );
      assert.deepEqual(rebuilt.hits, indexed.hits);
      await transaction(async (db) => {
        const q = (x: any) => catalogOperation(db, "catalogWorks", x);
        assert.equal((await q({ language: "English" })).total, 1);
        assert.equal((await q({ language: "English\nItaliano" })).total, 2);
        assert.equal((await q({ language: "en\nit" })).total, 2);
        assert.equal((await q({ language: "English\nEnglish" })).total, 1);
        assert.equal(
          (await q({ language: "English\nItaliano", words: ">150" })).total,
          1,
        );
        assert.equal((await q({ language: "Unknown language" })).total, 0);
        assert.equal((await q({ freeform: "Space" })).items.length, 1);
        const browse = await catalogOperation(db, "catalogBrowse", {
          kind: "freeform",
        });
        assert.equal(
          browse.items.find((t: any) => t.name === "Space").works,
          1,
        );
        assert.equal(
          browse.items.find((t: any) => t.name === "Voyages").works,
          2,
        );
        assert.equal((await q({ freeform: "Star travel" })).items.length, 1);
        assert.equal((await q({ freeform: "Voyages" })).items.length, 2);
        assert.equal((await q({ exclude: "Space" })).items.length, 2);
        assert.equal(
          (await q({ crossover: "false" })).total,
          3,
          "Related fandoms are not crossovers",
        );
        assert.equal(
          (await q({ q: "filter_ids:1 AND user_ids:writer" })).total,
          1,
        );
        assert.equal((await q({ q: "collection_ids:*" })).total, 3);
        assert.equal((await q({ creators: "Pen" })).total, 3);
        assert.equal(
          (await q({ q: 'title:"Moon 1" AND complete:true' })).items.length,
          1,
        );
        assert.equal((await q({ fulltext: '"lunar oceans"' })).items.length, 3);
        assert.equal(
          (await q({ words: ">150", singleChapter: "true" })).items.length,
          0,
        );
        assert.equal(
          (await q({ kudos: ">0" })).items.length,
          2,
          "unknown kudos are not zero",
        );
        const found = (await q({ sort: "words", direction: "desc" })).items;
        assert.deepEqual(
          found.map((w: any) => w.metadata.words),
          [300, 200, 100],
        );
        assert.equal(
          found[0].bibliography.entities.find(
            (e: any) => e.kind === "series" && e.source_id === "90",
          ).position,
          8,
        );
        const id = found[2].id,
          details = await catalogOperation(db, "readerWork", { id });
        const entity = details.bibliography.entities.find(
          (e: any) => e.kind === "author",
        );
        assert.equal(
          (
            await catalogOperation(db, "bibliographyPage", {
              kind: "author",
              id: entity.id,
            })
          ).relations[0].name,
          "Pen",
        );
        const series = details.bibliography.entities.find(
          (e: any) => e.kind === "series",
        );
        assert.deepEqual(
          (await q({ entity: series.id })).items.map(
            (w: any) => w.metadata.words,
          ),
          [100, 200, 300],
        );
        const interaction = await catalogOperation(db, "readerInteractions", {
          id,
        });
        assert.equal(interaction.comments.length, 1);
        assert.equal(interaction.comments[0].children, 1);
        assert.doesNotMatch(interaction.comments[0].html, /<script/);
        assert.equal(interaction.kudos.guests, 2);
        assert.equal(
          (
            await catalogOperation(db, "readerInteractions", {
              id,
              parent: "c1",
            })
          ).comments[0].id,
          "c2",
        );
        const html = await catalogOperation(db, "readerContent", {
          id,
          skin: "on",
        });
        assert.match(html.document, /@media/);
        assert.match(html.document, /\/media\//);
        const media = details.manifest.objects.find(
          (o: any) => o.name === "voice.wav",
        );
        const d = await catalogOperation(db, "readerMedia", {
          id,
          hash: media.hash,
        });
        assert.equal(d.mime, "audio/wav");
        assert.equal(d.size, 128);
        assert.equal(d.chunks.length, 2);
        const { assetBytes, streamMedia } = await import(
          "../apps/api/src/reader-media"
        );
        const { Readable } = await import("node:stream");
        assert.deepEqual(
          Buffer.concat(await Readable.from(streamMedia(d, 48, 80)).toArray()),
          wav.subarray(48, 81),
        );
        const { downloadWork } = await import(
          "../apps/api/src/reader-download"
        );
        const htmlDownload = await downloadWork(db, { id, format: "html" });
        assert.ok(
          (await htmlDownload.stream.toArray())
            .join("")
            .includes(wav.toString("base64")),
        );

        assert.deepEqual(
          await assetBytes(db, details.manifest, media.hash),
          wav,
        );
      });
      // Existing acquired versions retain attribution and interactions after a new head.
      const w = (
        await pool.query(
          "SELECT id,current_snapshot_id FROM archive_works WHERE external_id='900001'",
        )
      ).rows[0];
      const changed = record(1);
      changed.metadata.title = ["New title"];
      changed.metadata.ao3.comments = [
        {
          id: "c1",
          author: "Reader",
          html: "<p>Edited</p>",
          posted_at: "2024-02-03",
        },
      ];
      await ingestRecord(source, {
        record: changed,
        locator: "work1",
        parser: "test-ao3",
        cursor: 4,
      });
      await drain();
      await transaction(async (db) => {
        const old = await catalogOperation(db, "readerInteractions", {
          id: w.id,
          snapshot: w.current_snapshot_id,
        });
        assert.match(old.comments[0].html, /Lovely/);
      });
    } finally {
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
