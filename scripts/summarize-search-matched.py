#!/usr/bin/env python3
"""Same-request stage accounting and matched indexing-window diagnostics."""
import json,pathlib,sys,statistics,collections,importlib.util
here=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('p2d',here/'summarize-p2d.py');p2d=importlib.util.module_from_spec(spec);spec.loader.exec_module(p2d)
p2c=p2d.p2c
def stat(v):
 if not v:return None
 v=sorted(v);return {'n':len(v),'mean':statistics.mean(v),'p50':v[(len(v)-1)//2],'p95':v[int((len(v)-1)*.95)],'min':v[0],'max':v[-1]}
def union(spans):
 total=0;end=0
 for s in sorted(spans,key=lambda s:s['start_ms']):
  total+=max(0,s['end_ms']-max(end,s['start_ms']));end=max(end,s['end_ms'])
 return total
def run(path):
 root=path/'results';d=json.loads((root/'matched.json').read_text());spans={r['sample']:r for r in p2c.lines(root/'search-spans.jsonl') if r.get('sample')};resources=p2c.lines(root/'ablation-resources.jsonl');bulk=p2c.lines(root/'matched-projection-p2d-events.jsonl');windows=[]
 for w in d['results']:
  samples=[]
  for s in w['samples']:
   out=dict(s);r=spans.get(s['sample'])
   if r:
    assert r['status']==200 and not r['aborted'];totals=collections.Counter();counts=collections.Counter()
    for p in r['spans']:
     key=p['kind']+('/'+p['operation'] if 'operation' in p else '/'+p['purpose'] if 'purpose' in p else '')
     totals[key]+=p['end_ms']-p['start_ms'];counts[key]+=1
     if p.get('took_ms') is not None:totals['opensearch.took']+=p['took_ms']
    for operation in ['search','pit.open','pit.close','index.state']:
     totals['opensearch.operation/'+operation]=totals.get('opensearch.headers/'+operation,0)+totals.get('opensearch.body/'+operation,0)
    totals['postgres.all']=sum(v for k,v in totals.items() if k.startswith('postgres.client/'))
    totals['opensearch.client']=sum(v for k,v in totals.items() if k.startswith('opensearch.headers/') or k.startswith('opensearch.body/'))
    totals['api.wall']=r['wall_ms'];totals['api.unattributed']=max(0,r['wall_ms']-union(r['spans']))
    out.update(stages_ms=dict(totals),calls=dict(counts))
   samples.append(out)
  a,b=w['before'],w['after'];seconds=(w['end']-w['start'])/1000
  counters={g:{k:v-a['indices'][g].get(k,0) for k,v in b['indices'][g].items() if isinstance(v,(int,float)) and not isinstance(v,bool)} for g in ['indexing','refresh','merges','flush']}
  row={k:w[k] for k in ['label','start','end','queue_before','queue_after','indexed','indexed_per_second']};row.update(seconds=seconds,searches_per_second=len(samples)/seconds,samples=samples,client_ms=stat([s['client_ms'] for s in samples]))
  keys={k for s in samples for k in s.get('stages_ms',{})};row['stages_ms']={k:stat([s['stages_ms'].get(k,0) for s in samples if 'stages_ms' in s]) for k in sorted(keys)}
  keys={k for s in samples for k in s.get('calls',{})};row['calls']={k:stat([s['calls'].get(k,0) for s in samples if 'calls' in s]) for k in sorted(keys)}
  row['opensearch']={'cpu_seconds':(b['process']['cpu']['total_in_millis']-a['process']['cpu']['total_in_millis'])/1000,'heap_before_bytes':a['jvm']['mem']['heap_used_in_bytes'],'heap_after_bytes':b['jvm']['mem']['heap_used_in_bytes'],'heap_peak_bytes':max(s['node']['jvm']['mem']['heap_used_in_bytes'] for s in [{'node':a},*w['nodes'],{'node':b}]),'gc':{k:{f:v[f]-a['jvm']['gc']['collectors'][k][f] for f in ['collection_count','collection_time_in_millis']} for k,v in b['jvm']['gc']['collectors'].items()},'counters':counters,'index_documents_per_second':counters['indexing']['index_total']/seconds,'segments_before':a['indices']['segments']['count'],'segments_after':b['indices']['segments']['count'],'contexts_sampled_max':max(s['node']['indices']['search']['open_contexts'] for s in [{'node':a},*w['nodes'],{'node':b}]),'contexts_before':a['indices']['search']['open_contexts'],'contexts_after':b['indices']['search']['open_contexts'],'thread_pools':{k:{'active_sampled_max':max(s['node']['thread_pool'][k]['active'] for s in w['nodes']),'queue_sampled_max':max(s['node']['thread_pool'][k]['queue'] for s in w['nodes']),'rejections_delta':b['thread_pool'][k]['rejected']-a['thread_pool'][k]['rejected']} for k in ['search','write']}}
  calls=[x for x in bulk if x['kind']=='http' and x['operation']=='bulk' and w['start']<=x['start'] and x['end']<=w['end']]
  row['opensearch']['caches']={g:{k:b['indices'][g][k]-a['indices'][g][k] for k in ['hit_count','miss_count','evictions']} for g in ['query_cache','request_cache']}
  row['bulk']={'complete_calls_in_window':len(calls),'client_ms':stat([x['ms'] for x in calls])};row['resources']=p2c.resources([x for x in resources if w['start']/1000<=x['time']<=w['end']/1000]);row['roles']={role:p2d.windows(root,'matched-'+role,w['start'],w['end']) for role in ['api','projection']};windows.append(row)
 profiles=[]
 if (root/'query-profiles.json').exists():
  for p in json.loads((root/'query-profiles.json').read_text()):profiles.append({'mode':p['mode'],'took_ms_with_profiler':p['took'],'aggregations':[a for sh in p['profile']['shards'] for a in sh.get('aggregations',[])]})
 return {'root':str(path),'variant':d['variant'],'image':(root/'image-id.txt').read_text().strip(),'verification':json.loads((root/'matched-verification.json').read_text()),'windows':windows,'query_profiles_after_measurement':profiles}
if __name__=='__main__':
 assert len(sys.argv)==5, 'Expected full1, noagg1, noagg2, full2 roots'
 runs=[run(pathlib.Path(x)) for x in sys.argv[1:]];pairs=[]
 assert [r['variant'] for r in runs]==['full','no-aggs','no-aggs','full']
 assert len({r['image'] for r in runs})==1
 for r in runs:
  assert r['verification']=={'documents':11032,'pending':0}
  for w in r['windows']:
   assert len(w['samples'])==80
   if w['label'] in ['idle','backlog','fandom','fulltext']:
    assert all('stages_ms' in sample for sample in w['samples'])
 for a,b in [(runs[0],runs[1]),(runs[3],runs[2])]:
  for w in a['windows']:
   if w['label'] not in ['idle','backlog','fandom','fulltext']:continue
   other=next(v for v in b['windows'] if v['label']==w['label'])
   left={(v['ids_hash'],v['total'],v['items']) for v in w['samples']}
   right={(v['ids_hash'],v['total'],v['items']) for v in other['samples']}
   assert left==right and len(left)==1, 'Result identity/order/count drift'

 for a,b in [(runs[0],runs[1]),(runs[3],runs[2])]:
  x=next(w for w in a['windows'] if w['label']=='backlog');y=next(w for w in b['windows'] if w['label']=='backlog');ratio=max(x['indexed_per_second'],y['indexed_per_second'])/min(x['indexed_per_second'],y['indexed_per_second']);pairs.append({'full':a['root'],'no_aggs':b['root'],'rate_ratio':ratio,'matched_within_10_percent':ratio<=1.1,'full_docs_per_second':x['indexed_per_second'],'no_aggs_docs_per_second':y['indexed_per_second'],'opensearch_full_docs_per_second':x['opensearch']['index_documents_per_second'],'opensearch_no_aggs_docs_per_second':y['opensearch']['index_documents_per_second'],'opensearch_rate_ratio':max(x['opensearch']['index_documents_per_second'],y['opensearch']['index_documents_per_second'])/min(x['opensearch']['index_documents_per_second'],y['opensearch']['index_documents_per_second'])})
 report={'schema':'palimora.performance.p2e1b.v1','baseline_commit':'c07aed7f97e029308cebd78eb8e101f5f3ed3a8b','runs':runs,'matched_pairs':pairs,'p2e1b_complete':all(p['matched_within_10_percent'] for p in pairs),'p2e1_complete':all(p['matched_within_10_percent'] for p in pairs),'p2_complete':False,'methodology':{'fixture':'Cold copies of stopped P2C B1 PostgreSQL/OpenSearch; same readonly canonical packs, 11032 works','order':['full1','noagg1','noagg2','full2'],'load':'Four scheduled HTTP searches/s, 80 measured requests in20s, three predefined warmups. Real isolated P2D projection process16/1/1,800 same-source invalidations,5s initial ramp. Benchmark-only delay before bulk, nominal20docs/s; actual rate decides matching. No production scheduler changes.','pacing':'Delay includes document budget, production preparation and HTTP add residual latency; this is not product maximum throughput. Pacing removed after measured window to drain.','pit':'Fresh PIT per request, closed by probe immediately after reading first page. Close excluded from HTTP client timing, included in offered-load schedule. No cursor used after close.','query_ablation':'Only diagnostic fetch wrapper removes aggs. Normal searchWorks/contract/frontend remain unchanged.','queries':{'default':'/works','fandom':'First fandom bucket returned by authoritative default search on the fixed fixture','fulltext':'/works?fulltext=love'},'spans':'Same-request ALS spans: SQL client by purpose; generation filtering plus cursor construction between document lookup completion and next query; Express json call includes serialization/send; finish is server completion, not client receipt. took is nested in OpenSearch client time. Unattributed is per-request wall minus union of spans, never independent percentile subtraction.','resources':'Docker1Hz, Node1Hz event-loop10ms resolution, OpenSearch boundaries and every8 requests (2s). CPU/delta counters cumulative; heap/queue/active/segments are instant sampled gauges. Stats calls add equal observer load. No quotas, cache drop, concurrent build or benchmark.','overhead':'noagg1 and full2 repeat stable post-drain API windows with and without instrumentation, after fresh API restart and warmups. Startup/JIT/order differences limit pure overhead attribution. full1 early overhead window was uninstrumented only and is excluded from paired overhead estimates.','profiling':'Additional profile=true searches after timed windows only; profiling timings are distorted and not substituted for normal latency.'},'limits':['Matched document rates do not imply identical GC/segments/cache state; four cold initial clones and reversed order mitigate, do not eliminate, these differences.','No-op reindexing preserves contents; not an ingest or maximum-throughput benchmark.','No sampled queue/rejection does not exclude brief peaks between2s samples.','SQL durations include driver/transport/scheduling; no pure SQL server attribution.','Generation-filter span includes cursor construction and microtask scheduling, not an isolated instruction-level CPU measurement.','No-aggs is a diagnostic counterfactual; facets must be retained in the eventual product change.']}
 report['methodology']['idle'] = 'Initial idle/representative windows have no projection process; API background jobs remain. Full/no-aggs use the same process layout.'
 report['methodology']['boundaries'] = 'Queue and OpenSearch snapshots bracket the wall window by the duration of their own queries. ACK drain and internal indexed counters can differ by partial in-flight bulk; both rates are reported.'
 report['limits'].append('OpenSearch contexts sampled after each probe closes its PIT: zero gauges establish cleanup, not zero contexts during the search; probe is serial, at most one test PIT at a time.')
 report['configuration']={'postgres':'17.6','opensearch':'2.19.4','redis':'7.4.6','opensearch_jvm_heap_mib':1024,'batch':16,'prepare_lanes':1,'publish_lanes':1,'nominal_paced_docs_per_second':20,'queued_documents_per_run':800,'http_searches_per_second':4,'samples_per_window':80,'warmups_per_window':3,'duration_seconds':20,'docker_quotas':None,'roles':'API and projection independent Node processes in the same test application container','source':'/mnt/sdb/palimora-p2c-b1-20261109','host':'Shared Intel i9-13900H,14 CPUs, approximately62.8GiB RAM; no concurrent benchmark/build','production_changes':False}
 report['p2e1b_complete'] = report['p2e1_complete'] = all(p['matched_within_10_percent'] and p['opensearch_rate_ratio']<=1.1 for p in pairs)
 report['diagnosis'] = {
  'ranking': [
   {'rank':1,'component':'Facet aggregations in search','evidence':'Full search client mean46.01/45.20ms idle and60.52/54.73ms paced backlog; no-aggs20.22/20.12 and18.51/19.16ms. Server took similarly39.10/38.23 vs13.95/14.36 idle;54.41/48.48 vs13.62/13.88 backlog.','uncertainty':'Ablation removes a product feature; observed mean differences are diagnostic headroom, not implemented optimization benefit. Cache/GC/segment differences remain.'},
   {'rank':2,'component':'Remaining hits/query/sort/total search','evidence':'No-aggs18.51/19.16ms client,13.62/13.88ms took under paced backlog. Prior P2E.1a isolates total and sort; not repeated.','uncertainty':'Cannot decompose this residual into CPU/filter/sort/network from client spans alone.'},
   {'rank':3,'component':'PostgreSQL and PIT round trips','evidence':'Backlog SQL7.45–9.17ms total across9calls; PIT6.28–7.97ms, index HEAD2.34–2.79ms. Documents SQL3.10–3.71ms is INCLUDED in SQL total.','uncertainty':'Client SQL includes scheduling/transport; no pure server attribution. PIT closure by probe excluded from API latency.'},
   {'rank':4,'component':'API transformation/serialization and unassigned scheduling','evidence':'Generation+cursor0.08–0.10ms; serialize/send1.93–2.63ms; same-request unassigned4.68–5.48ms. API event-loop mean10.18–10.30ms at10ms sampling resolution.','uncertainty':'Unassigned is not proven CPU; external receive time and post-response observer write are additional client overhead.'}],
  'p95_interpretation':'API and OS P50/P95 are reported separately for each distribution. Never subtract independent percentile values to attribute a component. Per-request stage data retained in runs/windows/samples.',
  'resource_interpretation':'Full queries consume31.36/27.33 OS CPU-seconds versus20.04/17.73 without facets over20s at matched rate. No write/search rejections or sampled queue, no old GC or indexing throttle. Higher server took and CPU support genuine search work, not merely HTTP transit. Refresh/merge/young GC also vary; exclusive causality for tail spikes is not established.'}
 report['p2e2_recommendation'] = {
  'single_intervention':'Evaluate bounded two-way partition of the ten independent facet aggregations on the same PIT and exact same filters, merging unchanged facets into the existing response.',
  'implementation_candidate':'Two search bodies in bounded multi-search: one retains current hits/sort/total and a balanced facet subset, the other size0/track_total_hits=false and remaining facets. At most2 simultaneous searches; all-or-nothing response, identical PIT/epoch/filter and each terms definition; no mapping/cache/UI change.',
  'basis':'Profile runs distribute61.90/35.84ms across ten collectors; unclassified19.31/13.06, relationships12.19/6.26 and fandom9.16/5.53ms. Work spans multiple collectors; collection/leaf traversal dominates rather than just ordinal initialization.',
  'potential_not_demonstrated':'Reduce serial aggregation critical path while retaining facets. The measured full/no-aggs gap25.08–25.79ms idle and35.57–42.01ms paced backlog is an upper diagnostic opportunity, NOT a predicted saving. Two-way partition may duplicate traversal and fail to improve.',
  'correctness':'Require complete facet bucket/count/order equality, unchanged hits/order/totals/cursors/generation filtering, same snapshot, error/timeout cleanup; no partial facet response.',
  'indexing_impact':'Additional concurrent traversal/CPU/heap may worsen indexing or search tails. Measure maximum-throughput product workload and matched load; do not ship if gains require unacceptable throughput loss.',
  'complexity_and_contract':'Moderate search orchestration change; query construction changes, API/frontend/mapping/durability do not. No implementation in P2E.1b.',
  'documentation':'https://docs.opensearch.org/latest/api-reference/search-apis/multi-search/'}
 report['validation']={'build':'npm run build passed; existing frontend chunk-size warning only','syntax':'node --check for3scripts and bash -n passed','disabled_preload':'fetch, http.emit, pg.query, express.json unchanged without diagnostic opt-in; non-test DB rejected','http':'1360 measured authenticated requests; no HTTP errors; all compared default/fandom/fulltext IDs/order/counts identical; each final catalog11032 and text pending0','scope':'No production source changes, prior P2E.1/P2E.1a reports preserved; no repeat of unchanged crash suites'}
 print(json.dumps(report,indent=2))
