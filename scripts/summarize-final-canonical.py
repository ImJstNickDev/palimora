"""Aggregate only non-content evidence; historical reports are never overwritten."""
import json,pathlib,sys,collections
repo=pathlib.Path(__file__).resolve().parents[1]
physical=pathlib.Path(sys.argv[1]);txt=pathlib.Path(sys.argv[2]);observation=pathlib.Path(sys.argv[3]);campaign=pathlib.Path(sys.argv[4]);G=2**30
load=lambda p:json.loads(pathlib.Path(p).read_text())
p=load(physical/'report.json');additional=load(txt);alternative=load(observation)
old=load(repo/'docs/performance-storage-overhaul.json')['capacity_sensitivity']['scenarios'];p5=load(repo/'docs/performance-p5-final.json')['completion'];oldcats={c['category']:c for c in p5['categories']}
a=p['variants']['A'];d=p['variants']['D'];scenarios=[]
populations={'sample_ao3.sqlite3':22249303,'sample_ao3_deduped.sqlite3':17656566,'sample_ao3_old_files.sqlite3':8331596}
sqlite=sum(n*d['categories'][name]['physical']/oldcats[name]['sampled_records']/G for name,n in populations.items())
source_ratio=d['categories']['txt.zip']['kinds']['source_text']['payload']/oldcats['txt.zip']['source']['original_compressed_bytes']
txt_ratios=[source_ratio]+[s['source_payload']/s['zip_payload'] for s in additional['sources']]
for prev in old:
 label=prev['scenario'];strata=[]
 for kind in ['epub-small','epub-medium','epub-large','epub-huge','txt','html']:
  name=kind.replace('huge','extreme')+'.zip';names=[name]+(['media-'+name] if kind.startswith('epub') else [])
  coefficients=[d['categories'][n]['physical']/oldcats[n]['source']['original_compressed_bytes'] for n in names]
  coefficient=coefficients[0] if label=='central' else (min(coefficients) if label=='favorable' else max(coefficients))
  projected=coefficient*p5['format_inventory'][kind]['compressed_bytes']/G
  if kind=='txt' and label!='central':projected+=((min(txt_ratios) if label=='favorable' else max(txt_ratios))-source_ratio)*p5['format_inventory'][kind]['compressed_bytes']/G
  strata.append({'kind':kind,'pack_gib':projected,'physical_bytes_per_source_compressed_byte':coefficient})
 residual=prev['pack_gib']-sum(x['pack_gib'] for x in prev['strata'])-prev['sqlite_pack_gib']
 total=sum(x['pack_gib'] for x in strata)+sqlite+residual
 scenarios.append({'scenario':label,'baseline_pack_gib':prev['pack_gib'],'pack_gib':total,'saving_gib':prev['pack_gib']-total,'sqlite_pack_gib':sqlite,'unchanged_other_gib':residual,'strata':strata})
runs={}
for label in ['baseline','candidate']:
 root=campaign/('final-batched-'+label)/'results'
 if not (root/'completion.json').exists():continue
 c=load(root/'completion.json')
 if 'final' not in c:continue
 run={'categories':len(c['categories']),'canonical_seconds':sum(x['canonical_seconds'] for x in c['categories']),'canonical_worker_cpu_seconds':sum(x['cpu_seconds'] for x in c['categories']),'pipeline_seconds':(c['finished']-c['started'])/1000,'projection_seconds':c['integrated_projection']['seconds'],'final':c['final'],'wal_generated_bytes':c['final']['wal_generated_bytes']-c['fixed']['wal_generated_bytes'],'replay':c['replay'],'image':(root/'image-id.txt').read_text().strip()}
 run['category_results']=[{k:x[k] for k in ['source','source_bytes','canonical_seconds','cpu_seconds','before','after','sources']} for x in c['categories']]
 if (root/'sustained.jsonl').exists():
  samples=[json.loads(line) for line in (root/'sustained.jsonl').read_text().splitlines()];run['peaks']={key:max(s.get(key,0) for s in samples) for key in ['staging_bytes','memory_bytes','working_bytes','wal_retained_bytes','queue_bytes']}
 if (root/'storage-resources.jsonl').exists():
  groups=collections.defaultdict(list)
  for line in (root/'storage-resources.jsonl').read_text().splitlines():
   sample=json.loads(line)
   if c['started']/1000 <= sample['time'] <= c['finished']/1000:groups[sample['container'].rsplit('-',1)[-1]].append(sample)
  run['timed_resources']={role:{'cpu_seconds':(max(x['cpu_ns'] for x in xs)-min(x['cpu_ns'] for x in xs))/1e9,'peak_memory_bytes':max(x['memory_bytes'] for x in xs),'peak_working_bytes':max(x['working_bytes'] for x in xs)} for role,xs in groups.items() if xs}
 run['projection_documents']=c['integrated_projection']['documents']
 run['projection_index_bytes']=c['integrated_projection']['index']['primaries']['store']['size_in_bytes']
 for file,key in [('p3a-storage.json','storage'),('heterogeneous-components.json','components'),('storage-post-analysis.json','post_analysis'),('physical-services.json','physical_services'),('storage-maintenance.json','maintenance'),('csv-verification.json','csv'),('p3a-normalized-catalog.json','normalized_catalog'),('p3a-normalized-observations.json','normalized_observations'),('backup-restore.json','backup_restore'),('restore-immutable-signatures.json','restore_immutable_signatures'),('source-readers.json','source_readers'),('restored-readers.json','restored_readers'),('canonical-export.json','standalone_export'),('canonical-downloads.json','downloads'),('canonical-search-text.json','canonical_search_text'),('backup-concurrent-readers.json','backup_concurrent_readers')]:
  if (root/file).exists():
   value=load(root/file)
   if key=='storage':value={k:value[k] for k in ['physical','packs','staging','verified_objects','storage'] if k in value}
   run[key]=value
 runs[label]=run
report={'schema':'palimora.final-canonical-storage.v1','status':'validation_in_progress','reference_commit':'5c5774f84fdff9805c5e9e062312a4cef2fca6d6','physical_comparison':p,'saving':{'objects':a['objects']-d['objects'],'bytes':a['physical']-d['physical'],'percent':100*(a['physical']-d['physical'])/a['physical']},'additional_txt_sample':additional,'observation_shared_payload_alternative':alternative,'reader':load(physical/'reader.json') if (physical/'reader.json').exists() else None,'integrated':runs,'conditional_capacity':{'method':'Per-format physical sample / original compressed source bytes; SQLite by preserved acquisition counts. No global compression percentage. Additional TXT source-payload range changes only that component. Other formats retain prior budgets; no hypothetical global dedup credit.','scenarios':scenarios,'first_real_ingest_started':False,'sql_savings_extrapolated':False,'operational_reserves_reduced':False},'validation':load(campaign/'final-canonical-validation.json') if (campaign/'final-canonical-validation.json').exists() else {}}
if report['validation'].get('complete'):report['status']='validated'
(repo/'docs/performance-final-canonical-storage.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'saving':report['saving'],'projection':scenarios},indent=2))
