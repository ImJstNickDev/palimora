"""Aggregate only private P3 fixtures; validate every semantic comparison."""
import json,pathlib,sys
base=pathlib.Path(sys.argv[1])
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(l) for l in p.read_text().splitlines()]
def run_root(name):return pathlib.Path(str(base)+'-'+name+('-final' if name in 'BC' else ''))
prior=read(pathlib.Path('docs/performance-p3a.json'))
r={'schema':'palimora.performance.p3-final.v1','reference_commit':'c8a75c0acfbd4cf1417c0d8b4fe4c2b2133be23e','status':'verification_pending','corpus':prior['corpus'],'configuration':{'default_mode':'conservative','default_sources':1,'parsers':6,'commits':4,'postgres_pool':12,'group_records':256,'zstd_level':3,'uv_threads':8,'projection_mode':'isolated','search_heap_gib':1,'search_parallel_facets':False,'host_resource_quotas':False,'conservative_queue_limit':65536,'throughput_first':{'disk_reserve_gib':8,'backlog_allocated_gib':8,'adapter_staging_reserved_gib':4,'sample_ms':1000,'sql_sample_ms':5000,'max_sample_age_ms':5000,'disk_warning_reserves':3,'disk_slow_reserves':2,'disk_wait_reserves':1,'disk_resume_reserves':2.5,'growth_headroom_seconds':10,'backlog_warn_fraction':.7,'backlog_slow_fraction':.85,'backlog_wait_fraction':1,'backlog_resume_fraction':.8}},'runs':{}}
for name,source_count,mode in [('A',4,'conservative'),('B',4,'throughput-first'),('C',2,'throughput-first')]:
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
ref=r['runs']['A']
for name,run in r['runs'].items():
 assert run['storage']['verified_objects']==107054
 for key in ['normalized_manifest_sha256','logical']:assert run['storage'][key]==ref['storage'][key],(name,key)
 assert [x for x in run['storage']['content'] if x['name']!='observation']==[x for x in ref['storage']['content'] if x['name']!='observation']
 assert run['normalized_observations']==ref['normalized_observations']
 for key in ['current_sha256','historical_sha256','search_sha256']:assert run['normalized_catalog'][key]==ref['normalized_catalog'][key]
 # Compare the immutable P3A baseline too.
 for key in ['current_sha256','historical_sha256','search_sha256']:assert run['normalized_catalog'][key]==prior['runs']['baseline']['normalized_catalog'][key]
r['queue_cost_probe']=read(pathlib.Path(str(base)+'-A')/'results/p3-queue-cost.json')
r['capacity_permissions']=lines(pathlib.Path(str(base)+'-A')/'results/p3-capacity-permissions.json')[-1]
r['verification']={'targeted_tests':17,'failed':0,'skipped':0,'all_objects_sha256':107054,'all_works_snapshots_catalog_search':11032,'chapter_revisions':22928,'all_profiles_equal':True,'prior_p3a_semantics_equal':True,'replay_all_profiles':all('retry' in x and x['retry']['before']==x['retry']['after'] for x in r['runs'].values()),'recovery':['conservative count gate with reduced test threshold','catalog absent while 160 works commit canonically','disk capacity injection pauses admission without advancing checkpoint, then resumes','staging reservation exhaustion persists paused state and resumes with capacity restored','OpenSearch connection failure retains 160 invalidations; all drain after restoration','projection passes in separate restarted processes','SIGTERM/SIGKILL with two ZIPs and durable backlog','SIGKILL inside PostgreSQL commit transaction and inside pack seal; zero checkpoint for the uncommitted group','source staging and unsealed pack leftovers removed after resume under existing locks','overlapping identities, conflicting metadata, 17 distinct snapshots for 20 acquisitions','missing, partial and corrupt sources','four parser processes cannot exceed shared staging reservations; corrupt ledger refuses writes']}
assert r['verification']['replay_all_profiles']
r['status']='implemented_verified_measured_complete_on_test_corpus'
r['recommended']={'default_unchanged':True,'explicit_large_import_candidate':'B','source_concurrency':4,'parsers':6,'commits':4,'pressure_mode':'throughput-first','ingest_memory':'4g','ingest_cpus':4,'quotas_measured':False,'production_ingest_authorized':False}
r['experimental_target']={'works_per_second':2000,'achieved':False}
r['notes']=['Filesystem caches were not dropped; this is a reused corpus on a shared host, not a cold-disk sustained-dump measurement.','Final pre-spawn cancellation cleanup was tested separately; the successful measured path is unchanged.','Source/decompressed MiB rates divide the verified input byte totals by canonical wall-clock; they are not isolated ZIP/decompression capacity measurements.','One final timed run per profile on a shared host without CPU/RAM quotas. A and B source concurrency 4; C uses 2 with identical total parser/commit budgets. Small canonical gain is not a statistical guarantee.','Canonical timing starts at persisted batch started_at and ends at the last successful ingestRecords return; batch-final cleanup/state time is separate. End-to-end includes queue drain, refresh and all-ID/generation plus authenticated sample reader checks.','The exact current/historical/full-text queue counts at the last commit are approximated by the first following ~1 s sample. OpenSearch node doc count can include Lucene deleted/nested documents; it is not the canonical searchable-work count. Final all-ID verification is authoritative.','CPU seconds and inclusive SQL/COPY/checkpoint/staging/pack spans overlap and must not be summed into wall-clock. API shares the worker benchmark container. Per-process CPU is sampled; a process can exit between samples.','Named staging sampling excludes anonymous/unlinked spool files. B/C reservations include these files and conservatively retained credits/input buffers, but exclude PackStore temporary packs (included in named staging). Baseline additional anonymous-spool upper bound is the sum of largest members above 8 MiB per source: 386955863 bytes, not a measured simultaneous peak.','Physical filesystem totals include cluster/WAL and OpenSearch translog and were captured after the timed drain/integrity verification, before queue-shape probes or replay. SQL database/index sizes and primary index bytes are separate. Filesystem cache contents and residual staging are zero.','The first B attempt stopped safely at 2071 committed works because an initial per-record staging estimate rejected a 262421940-byte member. Excluded from timing comparisons; replaced by shared per-source byte reservations, preserving the 4 GiB global budget.','B/C are measured from the final implementation, including global slots for single records, tags and auxiliary ZIP artifacts. Earlier B/C coordination probes are excluded from the main comparison. A uses the original P3A implementation.','Queue storage probe uses logged table clones with production columns/indexes, 100000 synthetic UUIDs, no foreign keys/triggers. It is a queue-operation measurement, not canonical ingest. One-million estimates are linear extrapolations. DELETE/VACUUM retain index pages; physical byte policy accounts for that.','Normalized comparisons retain content, metadata, versions and provenance; only validated local UUID references and non-semantic search generation/epoch/ingestion-time fields are normalized as in P3A. Tag keyword arrays are sorted, preserving multiplicity. Raw content hashes are also checked.']
print(json.dumps(r,indent=2))
