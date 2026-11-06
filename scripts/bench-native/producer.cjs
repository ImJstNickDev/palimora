// Real producer and ACK transport; no PostgreSQL/catalog/pack persistence.
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const fs=require('node:fs/promises');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const cpu=()=>Number(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/usage_usec (\d+)/)[1])/1e6;
(async()=>{
 const dir=await fs.mkdtemp('/bench-storage/native-probe-');let count=0,groups=0;
 const digest=createHash('sha256'),start=performance.now(),startCpu=cpu();
 const p=spawn('python3',['-u','apps/ingest-adapters/ao3.py','/dumps/ao3_stories/'+(process.env.BENCH_SOURCE??'sample2048.zip'),'0'],{env:{...process.env,PALIMORA_ADAPTER_STAGING:dir,PALIMORA_ADAPTER_ACK:'1',PALIMORA_ADAPTER_CACHE:'1',PALIMORA_ADAPTER_GROUP_SIZE:'256',PALIMORA_ADAPTER_GROUP_BYTES:String(16*1024*1024)},stdio:['pipe','pipe','inherit']});
 const exit=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve)});
 try {
  for await(const line of createInterface({input:p.stdout})){
   const e=JSON.parse(line);
   if(e.schema==='palimora.ingest.cache.v1'){p.stdin.write('{}\n');continue;}
   const records=e.records??(e.record?[e]:[]);
   for(const item of records){const r=item.record;digest.update(JSON.stringify({...r,objects:r.objects.map(o=>({name:o.name,kind:o.kind,hash:o.hash}))}));}
   count+=records.length;if(e.records)groups++;
   if(e.blocked||e.gap||e.io_error)throw Error('Invalid producer output');
   p.stdin.write('\n');
  }
  const code=await exit;if(code!==0||count!==Number(process.env.BENCH_EXPECTED_RECORDS??2048))throw Error('Producer failed');
  const seconds=(performance.now()-start)/1000;
  console.log(JSON.stringify({implementation:process.env.PALIMORA_NATIVE_SCAN_LIBRARY?'native':'current',workers:Number(process.env.INGEST_PARSER_WORKERS),records:count,groups,seconds,rate:count/seconds,cpu_seconds:cpu()-startCpu,memory_peak_bytes:Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8')),results_hash:digest.digest('hex')}));
 } finally{p.kill();await exit;await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
