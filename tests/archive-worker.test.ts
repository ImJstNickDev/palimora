import { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
test(
  "worker continues past gaps, suspends unsupported parser and resumes the exact checkpoint",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "palimora-worker-"));
    assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname, /test/);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema =
      "test_archive_" +
      (await import("node:crypto")).randomUUID().replaceAll("-", "");
    const setupPool = new Pool({ connectionString: url.toString() });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.AO3_DUMP_ROOT = root;
    process.env.INGEST_GROUP_RECORDS = "32";
    process.env.ARCHIVE_ROOT = join(root, "storage");
    const { pool, migrate } = await import("../apps/api/src/db");
    const { tick } = await import("../apps/api/src/ingest-worker");
    try {
      await migrate();
      execFileSync("python3", [
        "-c",
        "import sys;sys.path.insert(0,'apps/ingest-adapters');from html_fragments import notes,resource_urls;s='<p>è\\u2028</p><div class=notes>n</div>';r=notes(s);assert len(r)==1;assert s[r[0][0]:r[0][1]]=='<div class=notes>n</div>';s='<div class=notes>è</div >';assert notes(s)==[(0,len(s))];assert resource_urls('<a href=\"https://archiveofourown.org/works/1\">work</a><img src=\"https://example.test/image.png\">')=={'https://example.test/image.png'}",
      ]);

      execFileSync("python3", [
        "-c",
        `
import sys,sqlite3,os,json
sys.path.insert(0,'apps/ingest-adapters')
from metadata_index import indexed_rows
root=sys.argv[1];path=os.path.join(root,'index-fixture.sqlite3')
c=sqlite3.connect(path);c.execute('CREATE TABLE ao3_metadata(Path,Title,Author,Story_URL)')
c.executemany('INSERT INTO ao3_metadata VALUES(?,?,?,?)',[('queue1/'+str(i),'Title','Author','https://archiveofourown.org/works/'+str(i)) for i in range(4100)]);c.commit();c.close()
c=sqlite3.connect('file:'+path+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
os.environ['PALIMORA_METADATA_CACHE']=os.path.join(root,'cache-fixture')
def interrupt(cursor):raise InterruptedError()
try:list(indexed_rows(c,path,'ao3_metadata',0,[],['4099'],interrupt));raise AssertionError('Expected interruption')
except InterruptedError:pass
rows=list(indexed_rows(c,path,'ao3_metadata',0,[],['4099'],lambda x:None));assert len(rows)==1 and rows[0]['_rowid']==4100
assert len(list(indexed_rows(c,path,'ao3_metadata',4098,['queue1'],None,lambda x:(_ for _ in ()).throw(AssertionError('Index rebuilt')))))==2
cachefile=next(os.path.join(root,'cache-fixture',name) for name in os.listdir(os.path.join(root,'cache-fixture')) if name.endswith('.sqlite3'))
with open(cachefile,'wb') as damaged:damaged.write(b'corrupt')
try:list(indexed_rows(c,path,'ao3_metadata',4098,[],None,lambda x:None));raise AssertionError('Expected cache recovery')
except OSError as error:assert error.errno==5
assert len(list(indexed_rows(c,path,'ao3_metadata',4098,[],None,lambda x:None)))==2
c.close();os.unlink(path)
`,
        root,
      ]);
      await writeFile(join(root, "broken.zip"), "invalid");
      await writeFile(join(root, "transfer.zip.part"), "partial");
      execFileSync("python3", [
        "-c",
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('story.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/987654321\\nChapters: 1\\n\\nText')
 z.writestr('unknown.bin','unknown')`,
        join(root, "source.zip"),
      ]);
      const id = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state) VALUES($1,'pending')",
        [id],
      );
      await tick(id);
      assert.equal(
        (await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [id]))
          .rows[0].state,
        "parser_blocked",
      );
      const source = (
        await pool.query(
          "SELECT * FROM ingest_sources WHERE batch_id=$1 AND path='source.zip'",
          [id],
        )
      ).rows[0];
      assert.equal(source.checkpoint, "1");
      assert.equal(source.imported, "1");
      await pool.query(
        "UPDATE ingest_sources SET state='retry_pending',parser='previous-parser' WHERE id=$1",
        [source.id],
      );
      await pool.query(
        "UPDATE ingest_batches SET state='pending' WHERE id=$1",
        [id],
      );
      await tick(id);
      assert.equal(
        (
          await pool.query("SELECT imported FROM ingest_sources WHERE id=$1", [
            source.id,
          ])
        ).rows[0].imported,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ingest_issues WHERE source_id=$1",
            [source.id],
          )
        ).rows[0].count,
        "1",
      );
      // Remove the unsupported member to simulate a repaired source, retaining the first verified record.
      execFileSync("python3", [
        "-c",
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('story.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/987654321\\nChapters: 1\\n\\nText')`,
        join(root, "source.zip"),
      ]);
      await pool.query(
        "UPDATE ingest_sources SET state='retry_pending' WHERE id=$1",
        [source.id],
      );
      await pool.query(
        "UPDATE ingest_batches SET state='pending' WHERE id=$1",
        [id],
      );
      await tick(id);
      assert.equal(
        (await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [id]))
          .rows[0].state,
        "completed_with_gaps",
      );
      const incremental = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [incremental, ["source.zip"]],
      );
      await tick(incremental);
      assert.equal(
        (
          await pool.query(
            "SELECT imported FROM ingest_sources WHERE batch_id=$1",
            [incremental],
          )
        ).rows[0].imported,
        "0",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ingest_results r JOIN ingest_sources s ON s.id=r.source_id WHERE s.batch_id=$1",
            [incremental],
          )
        ).rows[0].count,
        "1",
      );
      execFileSync("python3", [
        "-c",
        `import zipfile,io,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('META-INF/container.xml','<container><rootfile full-path="content.opf"/></container>')
 z.writestr('content.opf','<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:source>https://archiveofourown.org/works/987654322</dc:source><dc:title>Media</dc:title></metadata><manifest><item id="c" href="chapter1.xhtml"/><item id="m" href="large.bin"/></manifest><spine><itemref idref="c"/></spine></package>')
 z.writestr('chapter1.xhtml','<html><body class="fff_chapter"><p>Content</p></body></html>')
 z.writestr('large.bin',b'x'*(16*1024*1024)+b'y')
missing=io.BytesIO()
with zipfile.ZipFile(b) as original,zipfile.ZipFile(missing,'w') as z:
 z.writestr('META-INF/container.xml',original.read('META-INF/container.xml'))
 z.writestr('content.opf',original.read('content.opf').replace(b'987654322',b'987654323'))
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('media.epub',b.getvalue())
 z.writestr('partial.epub',missing.getvalue())
 z.writestr('work.html','<html><head><title>HTML</title><style>p {color:black}</style></head><body><table><tr><td><b>Story URL:</b></td><td>https://archiveofourown.org/works/987654324</td></tr><tr><td><b>Chapters:</b></td><td>2</td></tr></table><div class="userstuff"><div class="story"><p>First</p><div class="fff_chapter_notes">Note</div></div><div class="story"><p>Second</p></div></div></body></html>')
 z.writestr('metadata.csv','Path,Title,Author,Story URL\\r\\nmedia.epub,Index title,Author,https://archiveofourown.org/works/987654322\\r\\n')
 z.writestr('empty.7z',b'7z\\xbc\\xaf\\x27\\x1c\\x00\\x04\\x8d\\x9b\\xd5\\x0f'+bytes(20))`,
        join(root, "media.zip"),
      ]);
      const mediaBatch = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [mediaBatch, ["media.zip", "absent.zip"]],
      );
      await tick(mediaBatch);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            mediaBatch,
          ])
        ).rows[0].state,
        "completed_with_gaps",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT current_snapshot_id FROM archive_works WHERE external_id='987654323'",
          )
        ).rows[0].current_snapshot_id,
        null,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ingest_issues i JOIN ingest_sources s ON s.id=i.source_id WHERE s.batch_id=$1 AND i.code='partial_content'",
            [mediaBatch],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_snapshot_chapters c JOIN archive_works w ON w.current_snapshot_id=c.snapshot_id WHERE w.external_id='987654324'",
          )
        ).rows[0].count,
        "2",
      );
      const manifest = (
        await pool.query(
          "SELECT hash FROM archive_objects WHERE kind='chunk_manifest' LIMIT 1",
        )
      ).rows[0];
      assert.ok(manifest);
      const { downloadObject } = await import(
        "../apps/api/src/archive-download"
      );
      let bytes = 0,
        last = 0;
      for await (const chunk of downloadObject(manifest.hash)) {
        bytes += chunk.length;
        last = chunk[chunk.length - 1];
      }
      assert.equal(bytes, 16 * 1024 * 1024 + 1);
      assert.equal(last, 121);
      const work = (
        await (
          await import("../apps/api/src/archive-catalog")
        ).hydrateWorks(
          pool as any,
          (
            await pool.query(
              "SELECT * FROM archive_works WHERE external_id='987654322'",
            )
          ).rows,
        )
      )[0];
      assert.deepEqual(work.metadata.title, ["Media"]);
      assert.deepEqual(work.metadata.creators, ["Author"]);
      execFileSync("python3", [
        "-c",
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('metadata.csv','Path,Title,Author,Story URL\\nmedia.epub,Title,Author,https://archiveofourown.org/works/987654322\\nbroken,row\\n')`,
        join(root, "index.zip"),
      ]);
      const csvBatch = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [csvBatch, ["index.zip"]],
      );
      await tick(csvBatch);
      const csvSource = (
        await pool.query("SELECT * FROM ingest_sources WHERE batch_id=$1", [
          csvBatch,
        ])
      ).rows[0];
      assert.equal(csvSource.state, "parser_unsupported");
      assert.equal(csvSource.checkpoint, "0");
      assert.deepEqual(csvSource.checkpoint_detail, { row: 1 });
      assert.equal(csvSource.imported, "1");
      await pool.query(
        "UPDATE ingest_sources SET state='retry_pending' WHERE id=$1",
        [csvSource.id],
      );
      await pool.query(
        "UPDATE ingest_batches SET state='pending' WHERE id=$1",
        [csvBatch],
      );
      await tick(csvBatch);
      assert.equal(
        (
          await pool.query("SELECT imported FROM ingest_sources WHERE id=$1", [
            csvSource.id,
          ])
        ).rows[0].imported,
        "1",
      );
      // Pause while the parser has a prefetched group, then resume the durable
      // boundary. Unacknowledged staging must never advance the source cursor.
      execFileSync("python3", [
        "-c",
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for n in range(96):z.writestr(str(n)+'.txt','Grouped '+str(n)+'\\n\\nStory URL: https://archiveofourown.org/works/'+str(40000000+n)+'\\nChapters: 1\\n\\nText')`,
        join(root, "groups.zip"),
      ]);
      const groupedBatch = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [groupedBatch, ["groups.zip"]],
      );
      const { archiveOperation } = await import(
        "../apps/api/src/archive-admin"
      );
      const { transaction } = await import("../apps/api/src/db");
      const running = tick(groupedBatch);
      let paused = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const s = (
          await pool.query(
            "SELECT imported FROM ingest_sources WHERE batch_id=$1",
            [groupedBatch],
          )
        ).rows[0];
        if (Number(s?.imported) >= 32) {
          await transaction((db) =>
            archiveOperation(db, "ingestControl", {
              id: groupedBatch,
              action: "pause",
            }),
          );
          paused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await running;
      assert.ok(paused, "Group checkpoint became visible");
      const pausedSource = (
        await pool.query(
          "SELECT checkpoint,imported FROM ingest_sources WHERE batch_id=$1",
          [groupedBatch],
        )
      ).rows[0];
      assert.equal(
        Number(pausedSource.checkpoint),
        Number(pausedSource.imported),
      );
      await transaction((db) =>
        archiveOperation(db, "ingestControl", {
          id: groupedBatch,
          action: "resume",
        }),
      );
      await tick(groupedBatch);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            groupedBatch,
          ])
        ).rows[0].state,
        "completed",
      );
      const resumed = (
        await pool.query(
          "SELECT imported,checkpoint FROM ingest_sources WHERE batch_id=$1",
          [groupedBatch],
        )
      ).rows[0];
      assert.equal(resumed.imported, "96");
      assert.equal(resumed.checkpoint, "96");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM archive_works WHERE external_id::text LIKE '400000%'",
          )
        ).rows[0].count,
        "96",
      );
    } finally {
      await pool.end();
      await setupPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await setupPool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
