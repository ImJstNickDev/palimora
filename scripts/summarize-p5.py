#!/usr/bin/env python3
"""Summarize isolated quota checks; never label the short corpus as sustained."""
import json,pathlib,sys
report=pathlib.Path('docs/performance-p5-final.json');r=json.loads(report.read_text());r['quota_checks']={}
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(x) for x in p.read_text().splitlines()]
for label in ['A','B','C']:
    d=pathlib.Path(sys.argv[1]+'-'+label+'-final')/'results'
    end=read(d/'end-to-end.json');spans=read(d/'p3-ingest-spans.json');storage=read(d/'p3a-storage.json');timeline=read(d/'timeline.json');caps=lines(d/'p3-capacity.jsonl');staging=lines(d/'staging-samples.jsonl')
    seconds=(spans['last_commit_ms']-float(end['last']['processing_started_at_ms']))/1000
    before=read(d/'before.json');after=read(d/'after.json')
    r['quota_checks'][label]={'sources':4 if label=='A' else 2,'works':11032,'canonical_seconds':seconds,'canonical_works_per_second':11032/seconds,'source_gib_per_hour':228732607/2**30/seconds*3600,'chapters_per_second':22928/seconds,'end_to_end_seconds':end['work_start_to_visible_seconds'],'drain_seconds':end['work_start_to_visible_seconds']-seconds,'queue_peaks':{key:max(x[key] for x in timeline) for key in ['catalog','historical','text']},'queue_bytes_peak':max(sum(int(q['bytes']) for q in c['queues']) for c in caps),'wal_generated_bytes':int(after['wal'][0]['wal_bytes'])-int(before['wal'][0]['wal_bytes']),'staging_peak_bytes':max(x['bytes'] for x in staging),'adapter_reserved_peak_bytes':max(x.get('reservations',0) for x in staging),'resources':read(d/'resources-summary.json'),'verified_objects':storage['verified_objects'],'storage':storage,'search_primary_bytes':after['search']['_all']['primaries']['store']['size_in_bytes'],'verification':read(d/'verification.json'),'image_id':(d/'image-id.txt').read_text().strip(),'measured_with_quotas':read(d/'environment.json')['docker_limits']}
    run=r['quota_checks'][label]
    start=float(end['last']['processing_started_at_ms'])
    run['catalog_done_seconds']=next(t['seconds'] for t in timeline if t['state']=='completed' and t['catalog']==0 and t['historical']==0)-(start-end['started_at_ms'])/1000
    run['index_documents_per_second_over_pipeline']=11032/run['end_to_end_seconds']
    run['wal_retained_peak_bytes']=None
    run['io_peak_bytes_per_second']=None
    run['integrity_manifest_sha256']=storage['normalized_manifest_sha256']
r['limitations']=['No sustained distinct-identity workload measured','No prolonged OpenSearch outage or recovery under large backlog measured in P5','Heterogeneous sample inspected but not ingested','No final backup/restore rehearsal','No final production profile validated','Capacity scenarios are sensitivity assumptions, not measured population cardinalities','Only source-concurrency comparison on the same smallest ZIP; no global optimum established']
r['validation']={'build':'passed','pressure_and_sources_tests':8,'preflight_tests':2,'original_sources_imported':False,'production_modified':False,'sustained_throughput':None,'p5_complete':False}
report.write_text(json.dumps(r,indent=2)+'\n')
for k,v in r['quota_checks'].items():print(k,{a:v[a] for a in ['canonical_seconds','canonical_works_per_second','source_gib_per_hour','end_to_end_seconds','drain_seconds','verified_objects']})
