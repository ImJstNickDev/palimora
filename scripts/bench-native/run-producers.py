"""Alternated, isolated producer measurements with identical input and settings."""
import argparse,subprocess,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,default=Path('/mnt/sdb/palimora-ingest-perf/samples/sample2048.zip'))
parser.add_argument('--records',type=int,default=2048)
parser.add_argument('--workers',type=int,nargs='+',default=[1,6,10])
parser.add_argument('--repeat',type=int,default=3)
parser.add_argument('--storage',type=Path,default=Path('/mnt/sdb/palimora-ingest-perf/storage'))
parser.add_argument('--image',default='palimora-dev-ingest')
parser.add_argument('--report',default='producers.json')
options=parser.parse_args()
source=options.source.resolve(strict=True)
storage=options.storage.resolve(strict=True)
if options.records<1 or options.repeat<1 or min(options.workers)<1:parser.error('Positive record/repetition/worker counts required')
if Path(options.report).name!=options.report:parser.error('Report must be a filename in .local/native-parser')
output=ROOT/'.local/native-parser';results=[]
for workers in options.workers:
    for repeat in range(options.repeat):
        for mode in (['current','native'] if repeat%2==0 else ['native','current']):
            args=['docker','run','--rm','--network','none','--init','--read-only','--tmpfs','/tmp']
            mounts=[(str(source.parent),'/dumps/ao3_stories',True),(str(storage),'/bench-storage',False),(str(ROOT/'scripts/bench-native/producer.cjs'),'/app/scripts/native-producer.cjs',True),(str(output/'adapters'),'/app/apps/ingest-adapters',True),(str(output/'html_scan.so'),'/app/native-scan.so',True)]
            for mount_source,target,ro in mounts:args+=['--mount','type=bind,source='+mount_source+',target='+target+(',readonly' if ro else '')]
            args+=['-e','INGEST_PARSER_WORKERS='+str(workers),'-e','BENCH_SOURCE='+source.name,'-e','BENCH_EXPECTED_RECORDS='+str(options.records)]
            if mode=='native':args+=['-e','PALIMORA_NATIVE_SCAN_LIBRARY=/app/native-scan.so']
            else:args+=['-e','PALIMORA_HTML_SCANNER=python']
            args+=[options.image,'node','scripts/native-producer.cjs']
            result=json.loads(subprocess.check_output(args,text=True));result['repetition']=repeat;results.append(result)
            assert result['results_hash']==results[0]['results_hash'],'Changed producer result'
            (output/options.report).write_text(json.dumps(results,indent=2))
            print(json.dumps(result),flush=True)
