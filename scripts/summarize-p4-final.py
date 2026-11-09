"""P4 paired campaign, reusing the P3 measurements and semantic checks."""
import json,pathlib,sys
base=pathlib.Path(sys.argv[1])
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(l) for l in p.read_text().splitlines()]
def run_root(name):return pathlib.Path(str(base)+'-'+name+'-final')
prior=read(pathlib.Path('docs/performance-p3a.json'))
r={'schema':'palimora.performance.p4-final.v1','reference_commit':'b23b9e0a3a96169873b4f06f1a079381855f60df','corpus':prior['corpus'],'runs':{}}
names=sys.argv[2].split(',') if len(sys.argv)>2 else ['A1','B1','B2','A2']
for name in names:
 source_count=4;mode='throughput-first'
 d=run_root(name)/'results'
 e=read(d/'end-to-end.json');t=read(d/'timeline.json');p=read(d/'p3-ingest-spans.json');s=read(d/'p3a-storage.json');cap=lines(d/'p3-capacity.jsonl');stage=lines(d/'staging-samples.jsonl');before=read(d/'before.json');after=read(d/'after.json')
 start=float(e['last']['processing_started_at_ms']);canonical=(p['last_commit_ms']-start)/1000;e2e=e['work_start_to_visible_seconds']
 q={}
 for key in ['catalog','historical','text']:
  area=sum((b['seconds']-a['seconds'])*(a[key]+b[key])/2 for a,b in zip(t,t[1:]))
  q[key]={'max_sampled':max(row[key] for row in t),'mean_residence_seconds_estimate':area/11032}
 at=next(row for row in t if row['seconds'] >= (p['last_commit_ms']-e['started_at_ms'])/1000)
 capacities={}
 for key in ['catalog_pending','catalog_snapshot_pending','catalog_text_pending']:
  rows=[q for c in cap for q in c['queues'] if q['relname']==key]
  capacities[key]={'max_allocated_bytes':max(int(q['bytes']) for q in rows),'max_index_bytes':max(int(q['index_bytes']) for q in rows),'max_dead_tuples_estimated':max(q['n_dead_tup'] or 0 for q in rows)}
 process=lines(d/'processes.jsonl');by_pid={}
 for row in process:
  for proc in row['processes']:
   v=by_pid.setdefault(proc['pid'],{'kind':proc['kind'],'cpu_seconds':0,'rss_peak_bytes':0});v['cpu_seconds']=max(v['cpu_seconds'],proc['cpu_seconds']);v['rss_peak_bytes']=max(v['rss_peak_bytes'],proc['rss_bytes'])
 disk=read(d/'p3a-disk.json');persistent=sum(v['apparent_bytes'] for v in disk.values())
 pressure=[json.loads(l) for l in (d/'worker.log').read_text().splitlines() if l.startswith('{') and 'ingest_pressure' in l]
 catalog_done=next(row['seconds'] for row in t if row['state']=='completed' and row['catalog']==row['historical']==0)-(start-e['started_at_ms'])/1000
 text_samples=[]
 for row in lines(d/'opensearch-samples.jsonl'):
  try:text_samples.append({'at':row['time'],'docs':sum(n['indices']['docs']['count'] for n in row['nodes'])})
  except KeyError:pass
 near=min(text_samples,key=lambda x:abs(x['at']-p['last_commit_ms'])) if text_samples else None
 r['runs'][name]={'source_concurrency':source_count,'mode':mode,'canonical_seconds_to_last_commit':canonical,'canonical_seconds_to_batch_finished':e['last']['processing_seconds'],'canonical_works_per_second':11032/canonical,'source_gib_per_hour':r['corpus']['source_bytes']/2**30/canonical*3600,'source_mib_per_second':r['corpus']['source_bytes']/2**20/canonical,'decompressed_mib_per_second':r['corpus']['decompressed_bytes']/2**20/canonical,'chapters_per_second':int(s['counts']['revisions'])/canonical,'objects_per_second':107054/canonical,'end_to_end_seconds':e2e,'end_to_end_works_per_second':11032/e2e,'drain_visibility_seconds':e2e-canonical,'catalog_done_seconds':catalog_done,'catalog_works_per_second_over_pipeline_interval':11032/catalog_done,'index_documents_per_second_over_pipeline_interval':11032/e2e,'queues_at_first_sample_after_last_commit':at,'search_node_docs_near_last_commit':near,'queue_samples':q,'queue_storage':capacities,'max_combined_queue_bytes_sampled':max(sum(int(q['bytes']) for q in c['queues']) for c in cap),'capacity_probe_mean_ms':sum(c['probe_ms'] for c in cap)/len(cap),'inclusive_ingest_spans':p,'wal_generated_pipeline_bytes':int(after['wal'][0]['wal_bytes'])-int(before['wal'][0]['wal_bytes']),'pressure':pressure,'resources':read(d/'resources-summary.json'),'process_samples':list(by_pid.values()),'max_python_processes_sampled':max(sum(proc['kind']=='python' for proc in row['processes']) for row in process),'staging_named_peak_bytes':max(row['bytes'] for row in stage),'adapter_reservations_peak_bytes':max(row.get('reservations',0) for row in stage) if name!='A' else None,'storage':s,'filesystem':disk,'persistent_total_bytes':persistent,'persistent_bytes_per_work':persistent/11032,'source_to_persistent_ratio':r['corpus']['source_bytes']/persistent,'search_primary_bytes':after['search']['_all']['primaries']['store']['size_in_bytes'],'bibliography':read(d/'projection-profile-bibliography.json'),'verification':read(d/'verification.json'),'normalized_catalog':read(d/'p3a-normalized-catalog.json'),'normalized_observations':read(d/'p3a-normalized-observations.json'),'image_id':(d/'image-id.txt').read_text().strip()}
 r['runs'][name]['postgres_settings']=before['settings']
 if (d/'p3a-retry.json').exists():r['runs'][name]['retry']=read(d/'p3a-retry.json')
for name,run in r['runs'].items():
 d=run_root(name)/'results'
 events=lines(d/'projection-profile-p2c-events.jsonl')
 start=float(read(d/'end-to-end.json')['last']['processing_started_at_ms'])
 last=run['inclusive_ingest_spans']['last_commit_ms']
 stages={}
 for kind in ['current','historical','text']:
  productive=[e for e in events if e['kind']==kind and e.get('rows',0)>0]
  assert sum(e['rows'] for e in productive)==11032
  first=min(e['start'] for e in productive);end=max(e['end'] for e in productive)
  completed=sum(e['rows'] for e in productive if e['end']<=last)
  crossing=sum(e['rows'] for e in productive if e['start']<=last<e['end'])
  stages[kind]={'completed_rows':11032,'first_productive_start_ms':first,'last_productive_end_ms':end,'done_seconds_from_batch_start':(end-start)/1000,'productive_envelope_seconds':(end-first)/1000,'rows_per_second_over_productive_envelope':11032/((end-first)/1000),'pending_at_canonical_commit_min':11032-completed-crossing,'pending_at_canonical_commit_max':11032-completed}
 run['downstream_events']=stages
 run['downstream_all_acknowledged_seconds']=max(v['done_seconds_from_batch_start'] for v in stages.values())
 run['verification_after_last_projection_seconds']=run['end_to_end_seconds']-run['downstream_all_acknowledged_seconds']
ref=r['runs'][names[0]]
for name,run in r['runs'].items():
 assert run['storage']['verified_objects']==107054
 for key in ['normalized_manifest_sha256','logical']:assert run['storage'][key]==ref['storage'][key],(name,key)
 assert [x for x in run['storage']['content'] if x['name']!='observation']==[x for x in ref['storage']['content'] if x['name']!='observation']
 assert run['normalized_observations']==ref['normalized_observations']
 for key in ['current_sha256','historical_sha256','search_sha256']:assert run['normalized_catalog'][key]==ref['normalized_catalog'][key]
 # Compare the immutable P3A baseline too.
 for key in ['current_sha256','historical_sha256','search_sha256']:assert run['normalized_catalog'][key]==prior['runs']['baseline']['normalized_catalog'][key]

for name,run in r['runs'].items():
 d=run_root(name)/'results'
 run['postgres_relations_before_replay']=read(d/'after.json')['sizes']
 if (d/'p4-storage-detail.json').exists():run['supplementary_storage_after_replay']=read(d/'p4-storage-detail.json')
 e=read(d/'end-to-end.json')
 start=float(e['last']['processing_started_at_ms'])/1000
 end=run['inclusive_ingest_spans']['last_commit_ms']/1000
 samples=lines(d/'operational-resources.jsonl')
 roles={}
 for row in samples:
  role=row['container'].rsplit('-',1)[-1]
  roles.setdefault(role,[]).append(row)
 run['canonical_sampled_resources']={}
 for role,rows in roles.items():
  a=min(rows,key=lambda x:abs(x['time']-start))
  b=min(rows,key=lambda x:abs(x['time']-end))
  cpu=(b['cpu_ns']-a['cpu_ns'])/1e9
  def io(row,op):
   return None if row['io'] is None else sum(v['value'] for v in row['io'] if v['op'].lower()==op)
  def delta_io(op):
   first,last=io(a,op),io(b,op)
   return None if first is None or last is None else (last-first)/11032
  run['canonical_sampled_resources'][role]={
   'interval_seconds':b['time']-a['time'],
   'start_sample_offset_seconds':a['time']-start,
   'end_sample_offset_seconds':b['time']-end,
   'cpu_seconds':cpu,'cpu_seconds_per_work':cpu/11032,
   'read_bytes_per_work':delta_io('read'),
   'write_bytes_per_work':delta_io('write')}
 activity=lines(d/'postgres-activity.jsonl')
 waits={}
 for row in activity:
  if start*1000<=row['time']<=end*1000:
   for v in row['rows']:
    k=str(v['application_name'])+':'+str(v['wait_event_type'])+':'+str(v['wait_event'])
    waits[k]=waits.get(k,0)+v['connections']
 run['canonical_postgres_wait_connection_samples']=waits
r['configuration']={'sources':4,'parsers':6,'commits':4,'postgres_pool':12,
 'group_records':256,'io_threads':8,'zstd':3,'pressure':'throughput-first',
 'projection':'isolated','search_parallel_facets':0,'host_quotas':False}
r['comparison_order']=names
r['notes']=[
 'Inclusive spans overlap and are not added.',
 'Resource CPU and block I/O canonical intervals use nearest one-second cgroup samples; PostgreSQL includes concurrent projection.',
 'Warm reused fixture on a shared host; no cache drops. Compare paired runs, not historical P3 wall time.',
 'Final storage captured before replay. No persistent cache or compression-level change.',
 'Only the isolated 11032-work corpus is measured; P5 is not started.']

if len(names)==4:
 import statistics
 pairs=[(names[0],names[1]),(names[3],names[2])]
 r['paired_comparisons']=[{
  'baseline':a,'candidate':b,
  'canonical_time_change_percent':100*(r['runs'][b]['canonical_seconds_to_last_commit']/r['runs'][a]['canonical_seconds_to_last_commit']-1)
 } for a,b in pairs]
 r['means']={}
 for label,group in [('baseline',[names[0],names[3]]),('optimized',[names[1],names[2]])]:
  values=[r['runs'][n] for n in group]
  keys=['canonical_seconds_to_last_commit','canonical_works_per_second','source_gib_per_hour',
   'chapters_per_second','objects_per_second','end_to_end_seconds','end_to_end_works_per_second',
   'wal_generated_pipeline_bytes','persistent_total_bytes','search_primary_bytes',
   'staging_named_peak_bytes','adapter_reservations_peak_bytes','drain_visibility_seconds']
  mean={k:statistics.mean(v[k] for v in values) for k in keys}
  mean['worker_canonical_cpu_seconds_per_work']=statistics.mean(v['canonical_sampled_resources']['worker']['cpu_seconds_per_work'] for v in values)
  mean['worker_pipeline_cpu_seconds_per_work']=statistics.mean(v['resources']['operational-resources']['worker']['cpu_seconds']/11032 for v in values)
  mean['pack_bytes']=statistics.mean(v['storage']['storage']['apparent'] for v in values)
  mean['postgres_database_bytes']=statistics.mean(int(v['storage']['counts']['database_bytes']) for v in values)
  mean['inclusive_spans_seconds']={k:statistics.mean(v['inclusive_ingest_spans']['spans'][k]['ms']/1000 for v in values) for k in ['sql.other','sql.copy','sql.commit','staging.prepare','pack.append','pack.finish','checkpoint']}
  r['means'][label]=mean
print(json.dumps(r,indent=2))
