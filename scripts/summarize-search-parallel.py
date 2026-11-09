#!/usr/bin/env python3
import importlib.util,json,pathlib,sys,os
spec=importlib.util.spec_from_file_location('matched',pathlib.Path(__file__).with_name('summarize-search-matched.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
runs=[m.run(pathlib.Path(p)) for p in sys.argv[1:]]
for run in runs:
 raw={r['sample']:r for r in m.p2c.lines(pathlib.Path(run['root'])/'results/search-spans.jsonl') if r.get('sample')}
 for window in run['windows']:
  for sample in window['samples']:
   spans=raw.get(sample['sample'],{}).get('spans',[])
   sample['search_detail']=[s for s in spans if s.get('operation')=='search']
   bodies=[s for s in spans if s['kind']=='opensearch.body' and s.get('operation')=='search']
   documents=[s for s in spans if s['kind']=='postgres.client' and s.get('purpose')=='documents']
   if len(bodies)==len(documents)==1:
    sample['composition_validation_dispatch_ms']=documents[0]['start_ms']-bodies[0]['end_ms']
  window['composition_validation_dispatch_ms']=m.stat([s['composition_validation_dispatch_ms'] for s in window['samples'] if 'composition_validation_dispatch_ms' in s])
  window['subquery_took_ms']=[m.stat([v for s in window['samples'] for p in s['search_detail'] for i,v in enumerate(p.get('subquery_took_ms',[])) if i==idx]) for idx in [0,1]]
pairs=[]
for a,b in [(runs[0],runs[1]),(runs[3],runs[2])]:
 for label in ['idle','backlog']:
  left=next(w for w in a['windows'] if w['label']==label);right=next(w for w in b['windows'] if w['label']==label)
  # Raw JSON hashes include object property order; structural equality is tested separately.
  raw_equal={s['semantic_hash'] for s in left['samples']}=={s['semantic_hash'] for s in right['samples']}
  pairs.append({'label':label,'original':a['root'],'parallel':b['root'],'api_original':left['client_ms'],'api_parallel':right['client_ms'],'docs_s':[left['indexed_per_second'],right['indexed_per_second']],'raw_json_hash_equal':raw_equal})
report={'schema':'palimora.performance.p2e2.v1','baseline_commit':'b0f699a95fd24f490c59012b71e48f686254d09a','runs':runs,'pairs':pairs,'default_enabled':False,'p2_complete':False}
report['methodology']={'fixture':'Independent cold copies of stopped P2C B1 PostgreSQL/OpenSearch,11032 works, same readonly packs','order':['off2','on1','on2','off3','offmax','onmax'],'configuration':{'postgres':'17.6','opensearch':'2.19.4','jvm_heap_mib':1024,'redis':'7.4.6','batch':16,'prepare_lanes':1,'publish_lanes':1,'docker_quotas':False,'http_rps':4,'samples':80,'window_seconds':20,'warmups':3},'pacing':'Matched nominal20docs/s; actual ACK and internal index rates determine matching; max variants no pacing,11032 queued. No concurrent build or benchmark.','pit':'One fresh PIT/request, closed after reading first page; closure outside API timer. No concurrent probe PIT accumulation.','same_application':'API dist bind-mounted on palimora-p2d-api base image; same compiled application in each OFF/ON comparison. Image hash identifies base only.','latency_compiled_search_sha256':'89ecbd186387943a494d3b1f162d0cadb46bf518c54344c3e6e7cc3633feb417','functional_operational_search_sha256':'e3c8a88acf7e4958ead189c5f131852d0150eabaf955f3e584ebfe236dbdf8b1','build_difference':'Final build additionally maps top-level HTTP400 to original SEARCH_QUERY_INVALID; successful search path unchanged. Both variants always use the same build within each comparison.','resources':'Docker/Node1Hz; OS boundaries and2s snapshots. CPU/counters deltas, gauges sampled. took nested in client duration; subqueries overlap.','composition':'Per-request gap from search JSON body completion to document SQL start: includes validation, merge, dispatch, scheduling. Not an isolated instruction-level merge timer.','bytes':'Request UTF8 body bytes and reserialized decoded response JSON bytes, not wire/compressed bytes.'}
report['limits']=['Single full-throughput pair; host/cache/GC/merge variance prevents attributing all throughput difference to msearch.','Matched ACK rates differ4.8percent, within10percent; inspect internal index rates too.','Raw JSON hashes differ with object key order; structural comparison independently validates hits/facets/cursors including array order.','No independent percentile subtraction; full no-facet ablation savings are not the msearch benefit.','Operational ingest control has no continuous search traffic: it verifies integration/throughput, not maximum search contention.','Short windows and sampled thread pools can miss transient queue peaks; byte accounting instrumentation overhead not separately re-benchmarked.']
report['adoption']={'enabled':False,'reason':'Stable idle improvement, no repeatable matched API P95 gain; full-throughput API P95 worsens144.65to156.37ms and observed ACK rate92.8to85.6docs/s. Reject default adoption.','residual':'Search tail latency under indexing remains unresolved; no further phase implemented.'}
if os.environ.get('P2E_FUNCTIONAL_ROOT'):
 root=pathlib.Path(os.environ['P2E_FUNCTIONAL_ROOT'])/'results'
 checks=json.loads((root/'parallel-equivalence.json').read_text());checks['case_count']=len(checks.pop('cases'))
 compat=json.loads((root/'compat.json').read_text());report['functional']={'root':str(root.parent),'checks':checks,'compatibility':{'version':compat['version'],'cases':[{'name':v['name'],'http_status':v['status'],'subquery_status':[r.get('status') for r in v['body']['responses']]} for v in compat['rows']]},'fault_injection':'Per-subquery error, timeout flag, shard failure, missing aggregations and transport failure injected around real responses; real fielddata failure and expired PIT also exercised.','early_probe_failures':'Corrected Nest exception code assertion and empty freeform fixture assumption; early roots excluded from benchmarks.'}
report['operational']=[]
for path in os.environ.get('P2E_OPERATIONAL_ROOTS','').split(':'):
 if not path:continue
 root=pathlib.Path(path)/'results';before=json.loads((root/'before.json').read_text());after=json.loads((root/'after.json').read_text())
 report['operational'].append({'root':path,'timing':json.loads((root/'end-to-end.json').read_text()),'verification':json.loads((root/'verification.json').read_text()),'resources':json.loads((root/'resources-summary.json').read_text()),'wal_bytes':int(after['wal'][0]['wal_bytes'])-int(before['wal'][0]['wal_bytes']),'queue_departures':after['queue_departures']})
for run in report['operational']:
 timing=run['timing'];root=pathlib.Path(run['root'])/'results'
 run['projection_process']=m.p2d.windows(root,'projection-profile',timing['started_at_ms'],timing['ended_at_ms'])
 projection=run['resources']['operational-resources'].get('projection',{})
 if projection.get('cpu_seconds',0)<0:
  projection['cpu_seconds']=None
  projection['cpu_mean_percent']=None
  projection['counter_limit']='Container shutdown reset the CPU counter; use projection_process event CPU instead. Raw negative delta retained only in private source summary.'
report['p2e2_complete']='functional' in report and len(report['operational'])==2
report['validation']={'build':'npm run build passed','syntax':'node --check and bash -n passed','baseline_reports':'P2E.1a/P2E.1b unchanged','production_scope':'catalog-search.ts and explicit Compose flag only; projection, canonical, parser, mappings, frontend unchanged'}
print(json.dumps(report,indent=2))
