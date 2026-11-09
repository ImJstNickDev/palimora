#!/usr/bin/env python3
"""Aggregate private P5 evidence without publishing work locators or content."""
import collections,json,pathlib,statistics,sys
root=pathlib.Path(sys.argv[1]);GIB=2**30
load=lambda f:json.loads((root/f).read_text())
if '--model-only' in sys.argv:
 summary=load('results/completion-summary.json')
else:
 run=load('run/results/completion.json');sources=load('results/source-strata.json');search={r['source']:r for r in load('run/results/category-search.json')}
 formats=collections.defaultdict(collections.Counter)
 for z in load('results/format-inventory.json')['zip_distributions']:
  for kind,values in z['groups'].items():formats[kind].update(values)
 categories=[]
 for c in run['categories']:
  before,after,projected=c['before'],c['after'],c['projection']['after'];source=sources.get(c['source']);n=source['members'] if source else after['snapshots']-before['snapshots']
  delta={key:after[key]-before[key] for key in ['works','snapshots','chapters','objects','object_stored_bytes','object_raw_bytes','relation_bytes']}
  categories.append(dict(category=c['source'],sampled_records=n,source=source or {'fixture_bytes':c['source_bytes']},delta=delta,canonical_seconds=c['canonical_seconds'],worker_cpu_seconds_including_drain=c['cpu_seconds'],projection_seconds=c['projection']['seconds'],postgres_total_growth_bytes=projected['relation_bytes']-before['relation_bytes'],search=search[c['source']],source_gib_per_hour=source['original_compressed_bytes']/GIB*3600/c['canonical_seconds'] if source else None))
 rows=[json.loads(x) for x in (root/'run/results/sustained.jsonl').read_text().splitlines()];start=rows[0]['at'];s=run['sustained'];canonical=[r for r in rows if r['at']<=start+1000*s['canonical_wall_seconds']]
 intervals=[dict(start_seconds=(a['at']-start)/1000,seconds=(b['at']-a['at'])/1000,new_works=b['works']-a['works'],works_per_second=1000*(b['works']-a['works'])/(b['at']-a['at'])) for a,b in zip(canonical,canonical[1:])]
 resources={}
 for filename in ['heterogeneous-resources.jsonl','completion-resources.jsonl']:
  grouped=collections.defaultdict(list)
  for line in (root/'run/results'/filename).read_text().splitlines():
   r=json.loads(line);grouped[r['container'].rsplit('-',1)[-1]].append(r)
  resources[filename]={}
  for role,rs in grouped.items():
   pairs=[(a,b) for a,b in zip(rs,rs[1:]) if b['time']>a['time']]
   def io(r,op):return None if r['io'] is None else sum(v['value'] for v in r['io'] if v['op'].lower()==op)
   def peak_io(op):
    values=[(io(b,op)-io(a,op))/(b['time']-a['time']) for a,b in pairs if io(a,op) is not None and io(b,op) is not None and io(b,op)>=io(a,op)]
    return max(values) if values else None
   resources[filename][role]=dict(working_peak_bytes=max(r['working_bytes'] for r in rs),memory_with_cache_peak_bytes=max(r['memory_bytes'] for r in rs),cpu_peak_percent=max(max(0,b['cpu_ns']-a['cpu_ns'])/1e9/(b['time']-a['time'])*100 for a,b in pairs),read_peak_bytes_per_second=peak_io('read'),write_peak_bytes_per_second=peak_io('write'),cpu_observed_positive_deltas_seconds=sum(max(0,b['cpu_ns']-a['cpu_ns']) for a,b in pairs)/1e9)
 pools=[r for x in (root/'run/results/pool-waits.jsonl').read_text().splitlines() for r in [json.loads(x)] if start<=r['at']<=start+1000*s['canonical_wall_seconds']];last={}
 for r in pools:last[r['pid']]=r
 summary=dict(schema='palimora.p5.completion.v2',technical_status='complete',restore_verified=True,reference_commit='a6a07d2d918a89ab5a4a6a56764c93827712cf15',readiness='NO-GO',format_inventory=dict(formats),zip_end_records=load('results/zip-inventory.json'),memory={name:load('results/'+name+'.json') for name in ['memory-zipfile','memory-adapter','memory-final-adapter','memory-3g-rejected']},categories=categories,fixed=run['fixed'],components=load('run/results/heterogeneous-components.json'),metadata_cache=load('run/results/metadata-cache.json'),sustained={**{k:v for k,v in s.items() if k!='projection'},'drain_seconds':s['projection']['seconds'],'final':s['projection']['after'],'search_final_store_bytes':s['projection']['index']['primaries']['store']['size_in_bytes'],'search_final_translog_bytes':s['projection']['index']['primaries']['translog']['size_in_bytes'],'works_per_second':s['synthetic']['works']/s['canonical_wall_seconds'],'source_gib_per_hour':s['synthetic']['source_bytes']/GIB*3600/s['canonical_wall_seconds'],'intervals':intervals,'sampled_duration_seconds':(rows[-1]['at']-start)/1000,'peaks':{key:max(r[key] for r in rows) for key in ['memory_bytes','working_bytes','staging_bytes','pack_bytes','queue_bytes','wal_retained_bytes','current_pending','historical_pending','text_pending']},'canonical_worker_cpu_seconds':(canonical[-1]['cpu_us']-canonical[0]['cpu_us'])/1e6,'pool':dict(calls=sum(r['calls'] for r in last.values()),observed_wait_ms=sum(r['wait_ms'] for r in last.values()),max_wait_ms=max(r['max_wait_ms'] for r in pools),max_waiting=max(r['max_waiting'] for r in pools),note='Last sample before SIGKILL may omit up to five seconds; includes connection setup.')},resources=resources,checkpoints=run['checkpoints'],vacuum={k:run[k] for k in ['vacuum_before','vacuum_after','vacuum_seconds']},replay=run['replay'],backup_restore=load('run/results/backup-restore.json'),verification=load('run/results/verification-final.json'),provenance=load('run/results/restored-provenance.json'),readers={k:load('run/results/'+k+'-readers.json') for k in ['source','restored']},controller_retries=run.get('controller_retries',[]))
assert summary['verification']['pending']==0
assert summary['verification']['synthetic_manifests_verified']==70000
assert summary['verification']['search_documents']==71207
assert summary['backup_restore']['signatures_equal'] and summary['backup_restore']['secret_decrypted']
assert summary['memory']['memory-final-adapter']['members']==2308264
if 'csv_supplement' not in summary:
 summary['csv_supplement']={**load('fixture-csv/sample.json'),**load('run/results/csv-verification.json')}
d=summary;cats={x['category']:x for x in d['categories']};G=GIB;out=[]
# Same observed record upper bounds in all scenarios; identity overlap is a separate assumption.
metadata={'sample_ao3.sqlite3':22249303,'sample_ao3_deduped.sqlite3':17656566,'sample_ao3_old_files.sqlite3':7973784+357812}
for scenario in ['favorable','central','prudent']:
 pack=pg=index=canon=down=0;detail=[]
 for kind in ['epub-small','epub-medium','epub-large','epub-huge','txt','html']:
  key=kind.replace('huge','extreme')+'.zip';matches=[cats[key]]+([cats['media-'+key]] if kind.startswith('epub') else []);v=d['format_inventory'][kind];compressed=v['compressed_bytes'];n=v['members']
  def coeff(c):return {'pack':c['delta']['object_stored_bytes']/c['source']['original_compressed_bytes'],'pg':c['postgres_total_growth_bytes']/c['sampled_records'],'index':c['search']['store_bytes']/c['source']['original_compressed_bytes'],'canonical_s_per_byte':c['canonical_seconds']/c['source']['original_compressed_bytes'],'down_s_per_byte':c['projection_seconds']/c['source']['original_compressed_bytes']}
  allc=[coeff(c) for c in matches];chosen=allc[0] if scenario=='central' else {k:(min if scenario=='favorable' else max)(c[k] for c in allc) for k in allc[0]}
  dp=compressed*chosen['pack']/G;dq=n*chosen['pg']/G;di=compressed*chosen['index']/G;tc=compressed*chosen['canonical_s_per_byte']/3600;td=compressed*chosen['down_s_per_byte']/3600
  pack+=dp;pg+=dq;index+=di;canon+=tc;down+=td;detail.append(dict(kind=kind,records=n,pack_gib=dp,postgres_gib=dq,search_gib=di,canonical_hours=tc,projection_hours=td,coefficients=chosen))
 meta_pack=meta_pg=meta_index=meta_hours=0
 for name,n in metadata.items():
  c=cats[name];sample=c['sampled_records'];meta_pack+=n*c['delta']['object_stored_bytes']/sample/G
  meta_pg+=n*(c['delta']['relation_bytes'] if scenario=='favorable' else c['postgres_total_growth_bytes'])/sample/G
  if scenario!='favorable':meta_index+=n*c['search']['store_bytes']/sample/G
  meta_hours+=n*c['canonical_seconds']/sample/3600
 pack+=meta_pack;pg+=meta_pg;index+=meta_index
 cache=sum(n*(r['logical_bytes'] if scenario=='favorable' else r['physical_bytes'])/r['rows']/G for r in d['metadata_cache'] for n in [22249303 if r['source']=='sample_ao3.sqlite3' else 17656566 if r['source']=='sample_ao3_deduped.sqlite3' else 7973784 if r['table']=='metadata_full_old' else 357812])
 # Explicit operational budgets, not fitted growth coefficients. Active WAL is configured/capped operationally.
 wal=16;queues=8;staging=8;translog=8
 csv_rows=d['format_inventory']['csv']['expanded_bytes']/(d['csv_supplement']['fixture_bytes']/d['csv_supplement']['rows'])
 csv_pack=d['csv_supplement']['object_stored_bytes']/d['csv_supplement']['fixture_bytes']*d['format_inventory']['csv']['expanded_bytes']/G
 meta=[cats[n] for n in metadata]
 csv_pg_coeff=(min(c['postgres_total_growth_bytes']/c['sampled_records'] for c in meta) if scenario=='favorable' else cats['sample_ao3.sqlite3']['postgres_total_growth_bytes']/60 if scenario=='central' else max(c['postgres_total_growth_bytes']/c['sampled_records'] for c in meta))
 csv_search_coeff=(min(c['search']['store_bytes']/c['sampled_records'] for c in meta) if scenario=='favorable' else cats['sample_ao3.sqlite3']['search']['store_bytes']/60 if scenario=='central' else max(c['search']['store_bytes']/c['sampled_records'] for c in meta))
 pack+=csv_pack;pg+=csv_rows*csv_pg_coeff/G;index+=csv_rows*csv_search_coeff/G
 minor=sum(v['expanded_bytes'] for k,v in d['format_inventory'].items() if not k.startswith('epub') and k not in ['txt','html','csv'])/G

 # One full largest-component rewrite + merge allowance for search. No simultaneous global compaction. CSV row count is a size-per-row sensitivity from 64 sampled rows, with SQLite projection costs as explicit proxy. Untyped artifacts reserve their raw bytes.
 maintenance=max(pack,pg,index)
 base=pack+pg+index+cache+wal+queues+staging+translog+minor+d['fixed']['database_bytes']/G+maintenance
 margin=base*.25;total=base+margin
 # Backup ratio measured on actual full fixture: includes SQL and canonical objects, no derived index.
 backup_ratio=d['backup_restore']['backup_payload_bytes']/(d['replay']['before']['object_stored_bytes']+d['replay']['before']['database_bytes'])
 backup=(pack+pg)*backup_ratio*1.25
 item=dict(scenario=scenario,pack_gib=pack,postgres_gib=pg,search_store_gib=index,search_translog_budget_gib=translog,metadata_cache_gib=cache,wal_retention_budget_gib=wal,backlog_budget_gib=queues,staging_temporary_gib=staging,untyped_raw_budget_gib=minor,csv_estimated_rows=csv_rows,csv_pack_gib=csv_pack,csv_postgres_gib=csv_rows*csv_pg_coeff/G,csv_search_gib=csv_rows*csv_search_coeff/G,maintenance_gib=maintenance,safety_margin_gib=margin,working_total_gib=total,backup_one_copy_gib=backup,restore_working_gib=total,zip_canonical_hours=canon,zip_projection_hours=down,metadata_canonical_serial_hours=meta_hours,metadata=dict(record_upper_bounds=metadata,pack_gib=meta_pack,postgres_gib=meta_pg,search_gib=meta_index),strata=detail)
 out.append(item)
summary['capacity']=dict(scenarios=out,method='Source-compressed weighted PackStore and search; member-weighted PostgreSQL. Min/main/max observed EPUB strata; TXT/HTML own coefficients. Metadata rowid upper bounds, no filename identity inference. Favorable metadata reuses current projections; central/prudent treat every metadata record as a new derived identity. 25% operational margin; maintenance covers one largest-component rewrite, not concurrent full rewrites. Not statistical intervals.',backup_ratio_measured=backup_ratio)
(root/'results/completion-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for i in out:print({k:round(v,1) if isinstance(v,float) else v for k,v in i.items() if k not in ['strata','metadata']})
