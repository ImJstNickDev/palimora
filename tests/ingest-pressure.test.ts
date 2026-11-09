import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IngestPressure,
  pressureConfig,
  type PressureSample,
} from "../apps/api/src/ingest-pressure";
import {
  IngestSlots,
  scheduleSources,
  sourceBudgets,
} from "../apps/api/src/ingest-sources";

test("disk pressure fails closed, has hysteresis, and does not depend on search availability", async () => {
  let now = 10000;
  let sample: PressureSample = {
    at: now,
    disks: ["archive", "postgres", "wal", "search", "temporary"].map(
      (name) => ({ name, free: 500, total: 1000 }),
    ),
    queues: 0,
    staging: 0,
    database: 0,
    wal: 0,
    queueLimit: true,
  };
  let unavailable = false;
  const p = new IngestPressure(
    { mode: "throughput-first", reserve: 100, backlog: 100, staging: 100 },
    async () => {
      if (unavailable) throw Error("missing mount");
      return sample;
    },
    () => now,
  );
  const inspect = async () => {
    now += 1001;
    sample.at = now;
    return (await p.inspect()).state;
  };
  assert.equal(await inspect(), "ready"); // 65k count irrelevant, bytes safe
  sample.disks[1].free = 90;
  assert.equal(await inspect(), "wait");
  sample.disks[1].free = 240;
  assert.equal(await inspect(), "wait");
  sample.disks[1].free = 260;
  assert.equal(await inspect(), "warn");
  sample.disks[1].free = 500;
  sample.queues = 86;
  assert.equal(await inspect(), "slow");
  sample.queues = 100;
  assert.equal(await inspect(), "wait");
  sample.queues = 81;
  assert.equal(await inspect(), "wait");
  sample.queues = 79;
  assert.equal(await inspect(), "warn");
  sample.queues = 0;
  unavailable = true;
  assert.equal(await inspect(), "wait");
  unavailable = false;
  assert.equal(await inspect(), "ready");
  sample.staging = 100;
  assert.equal(await inspect(), "stop");
  const stale = new IngestPressure(
    p.config,
    async () => ({ ...sample, at: now - 6000 }),
    () => now,
  );
  assert.equal((await stale.inspect()).reason, "capacity_unavailable");
});
test("conservative retains the count gate; invalid configuration is rejected", async () => {
  assert.throws(() => pressureConfig({ INGEST_PRESSURE_MODE: "off" }), /MODE/);
  assert.throws(() => pressureConfig({ INGEST_BACKLOG_GIB: "NaN" }), /GIB/);
  assert.equal(pressureConfig({}).mode, "conservative");
  const p = new IngestPressure(pressureConfig({}), async () => ({
    at: Date.now(),
    disks: [],
    queues: 0,
    staging: 0,
    database: 0,
    wal: 0,
    queueLimit: true,
  }));
  assert.equal((await p.inspect()).reason, "downstream_count");
});
test("shared slots bound pending groups and release in FIFO order", async () => {
  const slots = new IngestSlots(2);
  const first = await slots.acquire(),
    second = await slots.acquire();
  let admitted = false;
  const third = slots.acquire().then((release) => {
    admitted = true;
    return release;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(admitted, false);
  second();
  (await third)();
  first();
  first();
  const fourth = await slots.acquire();
  fourth();
});
test("a singleton ZIP uses every configured parser", async () => {
  await scheduleSources(
    [{ path: "only.zip" }],
    sourceBudgets(4, 6, 4),
    async (_, b) => assert.deepEqual(b, { parsers: 6, commits: 4 }),
  );
});

test("adapter reservations bound concurrent writes, release on ACK cleanup and fail closed after corruption", async () => {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "python3",
    [
      "-c",
      `
import os,sys,tempfile,json,multiprocessing,pathlib
os.environ['PALIMORA_HTML_SCANNER']='python'
with tempfile.TemporaryDirectory() as root:
 os.environ['PALIMORA_ADAPTER_STAGING']=root
 os.environ['PALIMORA_STAGING_BYTES']=str(32*1024*1024)
 pathlib.Path(root,'.quota').write_text('{}')
 sys.path.insert(0,'apps/ingest-adapters')
 import ao3
 def fill(i):
  ao3.active_dir=os.path.join(root,str(i));os.mkdir(ao3.active_dir)
  try:
   for n in range(40):ao3.obj(str(n),'text',b'x'*(1024*1024))
  except OSError as e:assert e.errno==28
  finally:ao3.close_segment()
 processes=[multiprocessing.get_context('fork').Process(target=fill,args=(i,)) for i in range(4)]
 for p in processes:p.start()
 for p in processes:p.join();assert p.exitcode==0
 reserved=sum(json.loads(pathlib.Path(root,'.quota').read_text()).values())
 actual=sum(p.stat().st_size for p in pathlib.Path(root).glob('*/objects*'))
 assert actual<=reserved<=32*1024*1024,(actual,reserved)
 for i in range(4):ao3.cleanup_staging(os.path.join(root,str(i)))
 assert json.loads(pathlib.Path(root,'.quota').read_text())=={}
 pathlib.Path(root,'.quota').write_text('{')
 ao3.active_dir=os.path.join(root,'new');os.mkdir(ao3.active_dir)
 try:ao3.ensure_space(1)
 except OSError as e:assert e.errno==28
 else:raise AssertionError('Corrupt reservation must not authorize writes')
`,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
});
