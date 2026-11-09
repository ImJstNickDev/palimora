import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  IngestPressure,
  pressureConfig,
} from "../apps/api/src/ingest-pressure";

test(
  "durable backlog survives conservative pause, disk pressure, offline search and projection restart",
  { skip: !process.env.TEST_DATABASE_URL || !process.env.OPENSEARCH_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.match(url.pathname, /test/);
    const setup = new Pool({ connectionString: url.toString() });
    const schema = "test_pressure_" + randomUUID().replaceAll("-", "");
    await setup.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const root = await mkdtemp(join(tmpdir(), "palimora-pressure-"));
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      ARCHIVE_ROOT: join(root, "storage"),
      AO3_DUMP_ROOT: root,
      INGEST_SOURCE_CONCURRENCY: "2",
      INGEST_COMMIT_CONCURRENCY: "2",
      INGEST_PARSER_WORKERS: "2",
      INGEST_GROUP_RECORDS: "2",
      INGEST_PRESSURE_MODE: "throughput-first",
    });
    const { pool, migrate } = await import("../apps/api/src/db");
    const { tick } = await import("../apps/api/src/ingest-worker");
    const searchUrl = process.env.OPENSEARCH_URL!;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      await migrate();
      execFileSync("python3", [
        "-c",
        `import zipfile,sys,os
for s in range(2):
 with zipfile.ZipFile(os.path.join(sys.argv[1],str(s)+'.zip'),'w') as z:
  for i in range(80):z.writestr(str(i)+'.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/'+str(700000+s*100+i)+'\\nChapters: 1\\n\\n'+('Durable backlog text '*32))`,
        root,
      ]);
      const id = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [id, ["0.zip", "1.zip"]],
      );
      let clock = Date.now();
      let free = 100 * 1024 ** 3;
      const collect = async () => {
        const q = Number(
          (await pool.query("SELECT count(*) n FROM catalog_pending")).rows[0]
            .n,
        );
        return {
          at: clock,
          disks: ["archive", "postgres", "wal", "search"].map((name) => ({
            name,
            free,
            total: 200 * 1024 ** 3,
          })),
          queues: q * 128,
          queueLimit: q >= 4,
          staging: 0,
          database: 0,
          wal: 0,
        };
      };
      const now = () => (clock += 1001);
      const conservative = new IngestPressure(
        { ...pressureConfig(), mode: "conservative" },
        collect,
        now,
      );
      const running = tick(id, conservative);
      for (let i = 0; i < 200; i++) {
        if (
          Number(
            (await pool.query("SELECT count(*) n FROM archive_work_heads"))
              .rows[0].n,
          ) >= 4
        )
          break;
        await delay(20);
      }
      await delay(600);
      const stalled = Number(
        (await pool.query("SELECT count(*) n FROM archive_work_heads")).rows[0]
          .n,
      );
      assert.ok(stalled >= 4 && stalled < 160);
      await pool.query("UPDATE ingest_batches SET state='paused' WHERE id=$1", [
        id,
      ]);
      await running;
      const before = (
        await pool.query(
          "SELECT sum(imported)::int n FROM ingest_sources WHERE batch_id=$1",
          [id],
        )
      ).rows[0].n;
      await pool.query(
        "UPDATE ingest_batches SET state='running' WHERE id=$1",
        [id],
      );
      free = 1;
      const throughput = new IngestPressure(pressureConfig(), collect, now);
      const resumed = tick(id, throughput);
      await delay(600);
      assert.equal(
        (
          await pool.query(
            "SELECT sum(imported)::int n FROM ingest_sources WHERE batch_id=$1",
            [id],
          )
        ).rows[0].n,
        before,
      );
      free = 100 * 1024 ** 3;
      await resumed;
      assert.equal(
        (await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [id]))
          .rows[0].state,
        "completed",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM catalog_pending"))
          .rows[0].n,
        160,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM catalog_snapshot_pending",
          )
        ).rows[0].n,
        160,
      );
      await delay(1500); // Durable while all projection consumers are absent.
      // Two independent processes: no in-memory queue state survives the restart.
      const project = `const {pool}=require('./apps/api/dist/db');const {projectCatalog}=require('./apps/api/dist/catalog');projectCatalog(5,5).finally(()=>pool.end())`;
      execFileSync(process.execPath, ["-e", project], { env: process.env });
      execFileSync(process.execPath, ["-e", project], { env: process.env });
      const { projectCatalog } = await import("../apps/api/src/catalog");
      for (let i = 0; i < 100; i++) {
        await projectCatalog(20, 20);
        const n = Number(
          (
            await pool.query(
              "SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending) n",
            )
          ).rows[0].n,
        );
        if (!n) break;
      }
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM catalog_documents"))
          .rows[0].n,
        160,
      );
      const search = await import("../apps/api/src/catalog-search");
      const pending = Number(
        (await pool.query("SELECT count(*) n FROM catalog_text_pending"))
          .rows[0].n,
      );
      assert.equal(pending, 160);
      process.env.OPENSEARCH_URL = "http://127.0.0.1:65534";
      await search.projectText().catch(() => {});
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) n FROM catalog_text_pending"))
            .rows[0].n,
        ),
        pending,
      );
      process.env.OPENSEARCH_URL = searchUrl;
      for (let i = 0; i < 100; i++) {
        await search.projectText();
        if (
          !Number(
            (await pool.query("SELECT count(*) n FROM catalog_text_pending"))
              .rows[0].n,
          )
        )
          break;
        await delay(100);
      }
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) n FROM catalog_text_pending"))
            .rows[0].n,
        ),
        0,
      );
      await search.searchRequest("/" + search.SEARCH_INDEX + "/_refresh");
      const ids = (
        await pool.query("SELECT work_id,generation FROM catalog_documents")
      ).rows;
      const docs = await search.searchRequest(
        "/" + search.SEARCH_INDEX + "/_mget",
        { ids: ids.map((r) => r.work_id) },
      );
      assert.equal(docs.docs.length, 160);
      for (const [i, doc] of docs.docs.entries()) {
        assert.ok(doc.found);
        assert.equal(String(doc._source.generation), String(ids[i].generation));
      }
      assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
      // Test-only tiny capacity injection exercises the actual adapter guard and
      // persisted pause without consuming the host filesystem.
      execFileSync("python3", [
        "-c",
        "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('budget.txt','Title\\n\\nStory URL: https://archiveofourown.org/works/799999\\nChapters: 1\\n\\n'+('Capacity '*100));z.close()",
        join(root, "budget.zip"),
      ]);
      const budgetId = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection) VALUES($1,'pending',$2)",
        [budgetId, ["budget.zip"]],
      );
      const tiny = new IngestPressure(
        { ...pressureConfig(), staging: 4096 },
        collect,
        now,
      );
      await tick(budgetId, tiny);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            budgetId,
          ])
        ).rows[0].state,
        "paused",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT checkpoint FROM ingest_sources WHERE batch_id=$1",
            [budgetId],
          )
        ).rows[0].checkpoint,
        "0",
      );
      await pool.query(
        "UPDATE ingest_batches SET state='running' WHERE id=$1",
        [budgetId],
      );
      await tick(budgetId, throughput);
      assert.equal(
        (
          await pool.query("SELECT state FROM ingest_batches WHERE id=$1", [
            budgetId,
          ])
        ).rows[0].state,
        "completed",
      );
      await projectCatalog();
      while (await search.projectText()) {}
      assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
      // Cancel before an adapter is started while capacity admission is waiting.
      const cancelledId = randomUUID();
      await pool.query(
        "INSERT INTO ingest_batches(id,state,selection,reprocess) VALUES($1,'pending',$2,true)",
        [cancelledId, ["budget.zip"]],
      );
      free = 1;
      const cancelled = tick(
        cancelledId,
        new IngestPressure(pressureConfig(), collect, now),
      );
      for (let i = 0; i < 100; i++) {
        if (
          (
            await pool.query(
              "SELECT 1 FROM ingest_sources WHERE batch_id=$1 AND state='valid'",
              [cancelledId],
            )
          ).rowCount
        )
          break;
        await delay(20);
      }
      await pool.query("UPDATE ingest_batches SET state='paused' WHERE id=$1", [
        cancelledId,
      ]);
      await cancelled;
      assert.deepEqual(await readdir(join(root, "storage", "staging")), []);
      console.log(
        JSON.stringify({
          conservative_stalled_works: stalled,
          canonical_works: 160,
          backlog_without_consumers: 160,
          search_unavailable_preserved: pending,
          disk_pause_preserved: before,
        }),
      );
    } finally {
      process.env.OPENSEARCH_URL = searchUrl;
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
