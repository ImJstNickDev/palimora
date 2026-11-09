import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

test(
  "concurrent ZIPs retain overlapping versions, checkpoints and provenance across retry",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const setup = new Pool({ connectionString: url.toString() });
    const schema = "test_multi_" + randomUUID().replaceAll("-", "");
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const root = await mkdtemp(join(tmpdir(), "palimora-multi-"));
    process.env.DATABASE_URL = url.toString();
    process.env.ARCHIVE_ROOT = join(root, "storage");
    process.env.AO3_DUMP_ROOT = root;
    process.env.INGEST_SOURCE_CONCURRENCY = "2";
    process.env.INGEST_COMMIT_CONCURRENCY = "2";
    process.env.INGEST_PARSER_WORKERS = "2";
    process.env.INGEST_GROUP_RECORDS = "2";
    const { pool, migrate } = await import("../apps/api/src/db");
    const { tick } = await import("../apps/api/src/ingest-worker");
    try {
      await migrate();
      execFileSync("python3", [
        "-c",
        `
import zipfile,sys,os,io
for source in range(2):
 with zipfile.ZipFile(os.path.join(sys.argv[1],str(source)+'.zip'),'w') as z:
  for i in range(10):
   identity=1000+i if i<5 else 2000+source*100+i
   text='shared' if i<3 else 'revision '+str(source)
   title='Alternative title' if source==1 and i==3 else 'Title'
   data=io.BytesIO()
   with zipfile.ZipFile(data,'w') as epub:
    epub.writestr('META-INF/container.xml','<container><rootfile full-path="content.opf"/></container>')
    epub.writestr('content.opf','<package><metadata><source>https://archiveofourown.org/works/'+str(identity)+'</source><title>'+title+'</title></metadata><manifest><item id="c" href="chapter1.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>')
    epub.writestr('chapter1.xhtml','<html><head><meta name="chapterurl" content="https://archiveofourown.org/chapters/'+str(identity)+'"/></head><body class="fff_chapter"><p>'+text+'</p></body></html>')
   z.writestr(str(i)+'.epub',data.getvalue())
  z.writestr('manifest.json','{"shared":true}')
`,
        root,
      ]);
      const id = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,true)",
        [id, ["0.zip", "1.zip"]],
      );
      await tick(id);
      assert.equal(
        (await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [id]))
          .rows[0].state,
        "completed",
      );
      const rows = (
        await pool.query(
          "SELECT checkpoint,imported,state FROM ingest_sources WHERE batch_id=$1",
          [id],
        )
      ).rows;
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.equal(r.checkpoint, "11");
        assert.equal(r.imported, "10");
        assert.equal(r.state, "ingested");
      }
      assert.equal(
        (await pool.query("SELECT count(*) FROM archive_work_heads")).rows[0]
          .count,
        "15",
      );
      const before = (
        await pool.query(
          "SELECT (SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_chapter_revisions) revisions,(SELECT count(*) FROM archive_object_data) objects,(SELECT count(*) FROM ingest_results) results",
        )
      ).rows[0];
      assert.equal(before.results, "20");
      assert.equal(before.snapshots, "17");
      assert.ok(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM archive_reconciliations WHERE kind='metadata'",
            )
          ).rows[0].count,
        ) > 0,
      );
      await pool.query(
        "UPDATE ingest_sources SET checkpoint=0,checkpoint_detail='{}',state='valid' WHERE batch_id=$1",
        [id],
      );
      await pool.query(
        "UPDATE ingest_batches SET state='running' WHERE id=$1",
        [id],
      );
      await tick(id);
      const after = (
        await pool.query(
          "SELECT (SELECT count(*) FROM archive_snapshots) snapshots,(SELECT count(*) FROM archive_chapter_revisions) revisions,(SELECT count(*) FROM archive_object_data) objects,(SELECT count(*) FROM ingest_results) results",
        )
      ).rows[0];
      assert.deepEqual(after, before);
      assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
      // Kill the coordinator after a durable prefix, then resume both sources.
      execFileSync("python3", [
        "-c",
        `
import zipfile,sys,os
for source in range(2):
 with zipfile.ZipFile(os.path.join(sys.argv[1],'crash'+str(source)+'.zip'),'w') as z:
  for i in range(160):
   z.writestr(str(i)+'.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/'+str(9000+source*1000+i)+'\\nChapters: 1\\n\\n'+('Content '*1024))
`,
        root,
      ]);
      for (const signal of ["SIGTERM", "SIGKILL", "pause"] as const) {
        const crashId = randomUUID();
        await pool.query(
          "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,true)",
          [crashId, ["crash0.zip", "crash1.zip"]],
        );
        const child = spawn(
          process.execPath,
          [
            "-e",
            `require('./apps/api/dist/ingest-worker').tick('${crashId}').finally(()=>require('./apps/api/dist/db').pool.end())`,
          ],
          { env: process.env, stdio: "ignore" },
        );
        const closed = new Promise((resolve) => child.on("exit", resolve));
        let prefix = 0;
        for (let i = 0; i < 300; i++) {
          prefix = Number(
            (
              await pool.query(
                "SELECT coalesce(sum(imported),0) n FROM ingest_sources WHERE batch_id=$1",
                [crashId],
              )
            ).rows[0].n,
          );
          if (prefix > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(prefix > 0 && prefix < 320);
        const { archiveOperation } = await import(
          "../apps/api/src/archive-admin"
        );
        const { transaction } = await import("../apps/api/src/db");
        if (signal === "pause")
          await transaction((db) =>
            archiveOperation(db, "ingestControl", {
              id: crashId,
              action: "pause",
            }),
          );
        else child.kill(signal);
        await closed;
        if (signal === "pause") {
          assert.equal(
            (
              await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
                crashId,
              ])
            ).rows[0].state,
            "paused",
          );
          for (const row of (
            await pool.query(
              "SELECT checkpoint,imported FROM ingest_sources WHERE batch_id=$1",
              [crashId],
            )
          ).rows)
            assert.equal(row.checkpoint, row.imported);
          await transaction((db) =>
            archiveOperation(db, "ingestControl", {
              id: crashId,
              action: "resume",
            }),
          );
        }
        await tick(crashId);
        assert.equal(
          (
            await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
              crashId,
            ])
          ).rows[0].state,
          "completed",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT sum(imported) n FROM ingest_sources WHERE batch_id=$1",
              [crashId],
            )
          ).rows[0].n,
          "320",
        );
        assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
      }
      // A database-side barrier makes the crash occur inside a live transaction.
      execFileSync("python3", [
        "-c",
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('fault.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/89999999\\nChapters: 1\\n\\nCrash test')`,
        join(root, "fault.zip"),
      ]);
      await pool.query(`CREATE FUNCTION p3a_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_id='89999999' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$;
      CREATE TRIGGER p3a_fault BEFORE INSERT ON archive_work_heads FOR EACH ROW EXECUTE FUNCTION p3a_fault()`);
      const faultId = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [faultId, ["fault.zip"]],
      );
      const fault = spawn(
        process.execPath,
        [
          "-e",
          `require('./apps/api/dist/ingest-worker').tick('${faultId}').finally(()=>require('./apps/api/dist/db').pool.end())`,
        ],
        {
          env: { ...process.env, PGAPPNAME: "palimora-p3a-fault" },
          stdio: "ignore",
        },
      );
      const exited = new Promise((resolve) => fault.on("exit", resolve));
      let inside = false;
      for (let i = 0; i < 400; i++) {
        inside = !!(
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name='palimora-p3a-fault' AND wait_event='PgSleep'",
          )
        ).rowCount;
        if (inside) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(inside, "Crash barrier reached inside archive transaction");
      fault.kill("SIGKILL");
      await exited;
      await pool.query(
        "DROP TRIGGER p3a_fault ON archive_work_heads; DROP FUNCTION p3a_fault()",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT checkpoint FROM ingest_sources WHERE batch_id=$1",
            [faultId],
          )
        ).rows[0].checkpoint,
        "0",
      );
      await tick(faultId);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            faultId,
          ])
        ).rows[0].state,
        "completed",
      );
      // Stop inside seal, after staging was written but before publication.
      execFileSync("python3", [
        "-c",
        "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('seal.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/89999998\\nChapters: 1\\n\\nSeal test');z.close()",
        join(root, "seal.zip"),
      ]);
      const sealId = randomUUID(),
        marker = join(root, "seal-ready");
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [sealId, ["seal.zip"]],
      );
      const sealing = spawn(
        process.execPath,
        [
          "-e",
          `
        const fs=require('node:fs'),{PackWriter}=require('./apps/api/dist/pack');
        const finish=PackWriter.prototype.finish;
        PackWriter.prototype.finish=async function(){if(this.current?.records.length){fs.writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(()=>{});}return finish.call(this);};
        require('./apps/api/dist/ingest-worker').tick('${sealId}').finally(()=>require('./apps/api/dist/db').pool.end());
      `,
        ],
        { env: process.env, stdio: "ignore" },
      );
      const sealExit = new Promise((r) => sealing.on("exit", r));
      const { access } = await import("node:fs/promises");
      let entered = false;
      for (let i = 0; i < 500; i++) {
        entered = await access(marker).then(
          () => true,
          () => false,
        );
        if (entered) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(entered, "Crash barrier reached inside seal");
      sealing.kill("SIGKILL");
      await sealExit;
      assert.equal(
        (
          await pool.query(
            "SELECT checkpoint FROM ingest_sources WHERE batch_id=$1",
            [sealId],
          )
        ).rows[0].checkpoint,
        "0",
      );
      assert.ok(
        (await readdir(join(root, "storage", "staging"))).some((n) =>
          n.endsWith(".pmpack"),
        ),
      );
      await tick(sealId);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            sealId,
          ])
        ).rows[0].state,
        "completed",
      );
      assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
