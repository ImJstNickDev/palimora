import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "@palimora/archive-format";
import { spawnSync } from "node:child_process";

test(
  "virtual TXT historical reader/downloads and metadata-only replay preserve complete head",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "palimora-canonical-integration-"),
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const admin = new Pool({ connectionString: url.toString() });
    const schema = "test_canonical_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = url.toString();
    process.env.ARCHIVE_ROOT = root;
    const { pool, migrate, transaction } = await import("../apps/api/src/db");
    const { ingestRecord } = await import("../apps/api/src/archive");
    const { loadSnapshot, chapterBytes, catalogOperation } = await import(
      "../apps/api/src/catalog"
    );
    const { downloadWork } = await import("../apps/api/src/reader-download");
    try {
      await migrate();
      const batch = randomUUID(),
        source = {
          id: randomUUID(),
          path: "fixture.zip",
          fingerprint: "fixture",
        };
      await pool.query(
        "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
        [batch],
      );
      await pool.query(
        "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
        [source.id, batch, source.path, source.fingerprint],
      );
      const original = Buffer.from(
        "Title\nStory URL: https://archiveofourown.org/works/12345\n\n\n\nélève & <story> 😀",
      );
      const parsed = spawnSync(
        "python3",
        [
          "-c",
          "import sys,json;sys.path.insert(0,'apps/ingest-adapters');import ao3;print(json.dumps(ao3.text_record(sys.stdin.buffer.read())))",
        ],
        {
          input: original,
          env: { ...process.env, PALIMORA_HTML_SCANNER: "python" },
        },
      );
      assert.equal(parsed.status, 0, parsed.stderr.toString());
      const record = JSON.parse(parsed.stdout.toString());
      const envelope = {
        record,
        locator: "work.txt",
        parser: "ao3-dump-5",
        cursor: 1,
      };
      await ingestRecord(source, envelope);
      await ingestRecord(source, envelope);
      const work = (
        await pool.query(
          "SELECT * FROM archive_works WHERE external_id='12345'",
        )
      ).rows[0];
      const expected = Buffer.from("<pre>élève &amp; &lt;story&gt; 😀</pre>");
      await transaction(async (db) => {
        const { manifest } = await loadSnapshot(
          db,
          work.id,
          work.current_snapshot_id,
        );
        assert.deepEqual(
          await chapterBytes(db, manifest, manifest.chapters[0]),
          expected,
        );
        assert.equal(manifest.chapters[0].hash, digest(original));
        const reader = await catalogOperation(db, "readerContent", {
          id: work.id,
          snapshot: work.current_snapshot_id,
          skin: "off",
        });
        assert.match(reader.document, /élève/);
        for (const format of ["html", "epub", "pdf"]) {
          const begin = performance.now();
          const result = await downloadWork(db, {
            id: work.id,
            snapshot: work.current_snapshot_id,
            format,
          });
          const data = Buffer.concat(
            (await result.stream.toArray()).map((b) =>
              Buffer.isBuffer(b) ? b : Buffer.from(b),
            ),
          );
          if (format === "html") assert.match(data.toString(), /élève/);
          if (format === "pdf")
            assert.equal(data.subarray(0, 5).toString(), "%PDF-");
          if (format === "epub") {
            const unzip = spawnSync(
              "python3",
              [
                "-c",
                "import zipfile,io,sys,html;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert any('élève' in html.unescape(z.read(n).decode('utf-8')) for n in z.namelist() if n.endswith(('.html','.xhtml')))",
              ],
              { input: data },
            );
            assert.equal(unzip.status, 0, unzip.stderr.toString());
          }
          console.log(
            JSON.stringify({
              virtual_txt_download: format,
              bytes: data.length,
              ms: performance.now() - begin,
            }),
          );
        }
      });
      const metadata = {
        ...envelope,
        locator: "sqlite-row:1",
        cursor: 2,
        record: {
          external_id: "12345",
          metadata: { Title: "Contrasting title" },
          objects: [],
          chapters: [],
          state: "metadata_only",
          observed_at: null,
        },
      };
      await ingestRecord(source, metadata);
      const counts = async () =>
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM archive_object_data) objects,(SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_record_data) acquisitions",
          )
        ).rows[0];
      const before = await counts();
      await ingestRecord(source, metadata);
      assert.deepEqual(await counts(), before);
      assert.equal(
        (
          await pool.query(
            "SELECT current_snapshot_id FROM archive_works WHERE id=$1",
            [work.id],
          )
        ).rows[0].current_snapshot_id,
        work.current_snapshot_id,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_objects WHERE kind='chapter_html'",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_snapshots WHERE state='metadata_only' AND manifest_hash=metadata_hash",
          )
        ).rows[0].count,
        "1",
      );
    } finally {
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
