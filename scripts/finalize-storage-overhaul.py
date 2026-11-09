#!/usr/bin/env python3
"""Compare the complete, bounded heterogeneous runs and recalibrate conditional capacity."""
import collections,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);repo=pathlib.Path(__file__).resolve().parents[1];G=2**30
load=lambda p:json.loads(p.read_text())
p5=load(repo/'docs/performance-p5-final.json');out=load(repo/'docs/performance-storage-overhaul.json');old=p5['completion'];runs={}
for label,directory in [('baseline','heterogeneous-a2'),('candidate','heterogeneous-b')]:
 r=root/directory/'results';c=load(r/'completion.json');assert 'error' not in c and len(c['categories'])==15
 storage=load(r/'p3a-storage.json');normal=load(r/'p3a-normalized-catalog.json');observations=load(r/'p3a-normalized-observations.json');components=load(r/'heterogeneous-components.json');maintenance=load(r/'storage-maintenance.json');categories=load(r/'category-search.json')
 resources=collections.defaultdict(list)
 for line in (r/'storage-resources.jsonl').read_text().splitlines():
  v=json.loads(line)
  if 'cpu_ns' in v and c['started']/1000<=v['time']<=c['finished']/1000:resources[v['container'].rsplit('-',1)[-1]].append(v)
 measured={}
 for role,values in resources.items():
  measured[role]=dict(working_peak_bytes=max(x['working_bytes'] for x in values),memory_with_cache_peak_bytes=max(x['memory_bytes'] for x in values),sampled_cpu_seconds=sum(max(0,b['cpu_ns']-a['cpu_ns']) for a,b in zip(values,values[1:]))/1e9)
 samples=[json.loads(line) for line in (r/'sustained.jsonl').read_text().splitlines()]
 runs[label]={'canonical_seconds':sum(x['canonical_seconds'] for x in c['categories']),'projection_seconds':sum(x['projection']['seconds'] for x in c['categories']),'pipeline_wall_seconds':(c['finished']-c['started'])/1000,'worker_cpu_seconds_including_drain':sum(x['cpu_seconds'] for x in c['categories']),'wal_generated_bytes':c['final']['wal_generated_bytes']-c['fixed']['wal_generated_bytes'],'peaks':{k:max(x[k] for x in samples) for k in ['staging_bytes','memory_bytes','working_bytes','wal_retained_bytes','queue_bytes']},'resources':measured,'counts':components['counts'],'tables':components['tables'],'objects':components['objects'],'pack':{k:storage[k] for k in ['physical','packs','staging','verified_objects','content','normalized_manifest_sha256','logical','cache','storage']},'normalized_catalog':normal,'normalized_observations':observations,'replay':c['replay'],'maintenance':maintenance,'categories':c['categories'],'category_search':categories,'fixed':c['fixed'],'final':c['final']}
for label,directory in [('baseline','heterogeneous-a2'),('candidate','heterogeneous-b')]:
 r=runs[label];path=root/directory/'results'
 r['image_id']=(path/'image-id.txt').read_text().strip()
 r['physical_services']=load(path/'physical-services.json')
 r['post_analysis']=load(path/'storage-post-analysis.json')
 events=load(path/'text-pipeline-events.json')
 r['bulk']={k:sum(e[k] for e in events) for k in ['claimed','acknowledged','requests','bytes','http_ms','prepare_ms','failures','cancelled']}
 r['last_source_projection_seconds']=r['categories'][-1]['projection']['seconds']
 r['search_semantics']=load(path/'search-semantics.json')
 r['sampled_index_and_translog_peak_bytes']=max(x['projection']['index']['primaries']['store']['size_in_bytes']+x['projection']['index']['primaries']['translog']['size_in_bytes'] for x in r['categories'])
 r['sampled_index_peak_bytes']=max(x['projection']['index']['primaries']['store']['size_in_bytes'] for x in r['categories'])
 r['sampled_translog_peak_bytes']=max(x['projection']['index']['primaries']['translog']['size_in_bytes'] for x in r['categories'])
 r['table_measurement_phase']='Collection before final ordinary maintenance; baseline collection was retried after earlier VACUUM. Atomic cloned-index removal is measured separately to distinguish structural savings from bloat.'
 r['relation_totals']={k:sum(t[k] for t in r['tables']) for k in ['heap_bytes','index_bytes','toast_bytes','total_bytes']}
 sizes={t['relname']:t['total_bytes'] for t in r['tables']}
 r['density']={'all_relations_per_work':r['relation_totals']['total_bytes']/r['counts']['works'],'current_relations_per_work':sum(sizes[k] for k in ['catalog_documents','catalog_work_tags','catalog_work_filters','catalog_entity_works'])/r['counts']['works'],'historical_view_per_snapshot':sizes['catalog_snapshot_views']/r['counts']['snapshots'],'chapter_revision_row':sizes['archive_revision_data']/r['counts']['chapters'],'catalog_tag':sizes['catalog_tags']/r['counts']['tags'],'direct_tag_association':sizes['catalog_work_tags']/r['counts']['tag_associations'],'filter_association':sizes['catalog_work_filters']/r['counts']['filter_associations'],'catalog_entity':sizes['catalog_entities']/r['counts']['entities'],'entity_association':sizes['catalog_entity_works']/r['counts']['entity_associations'],'canonical_acquisition_row':sizes['archive_record_data']/r['counts']['acquisitions']}
 r['cpu_measurement_note']='Positive counter deltas, sampled across container restarts; lower bound, not a complete profiler. One paired run, no statistical throughput guarantee.'
a,b=runs['baseline'],runs['candidate']
assert a['counts']==b['counts']
assert a['search_semantics']==b['search_semantics']
assert a['normalized_catalog']==b['normalized_catalog']
assert a['normalized_observations']==b['normalized_observations']
assert a['pack']['normalized_manifest_sha256']==b['pack']['normalized_manifest_sha256']
for name in ['asset','chapter_html','source_text','notes_html','css','document_html','package_metadata','metadata']:
 aa=[x for x in a['pack']['content'] if x['name']==name];bb=[x for x in b['pack']['content'] if x['name']==name];assert aa==bb,(name,aa,bb)
backup=load(root/'heterogeneous-b/results/backup-restore.json');assert backup['signatures_equal'] and backup['secret_decrypted']
readers={k:load(root/('heterogeneous-b/results/'+k+'-readers.json')) for k in ['source','restored']}
assert readers['source']==readers['restored']
immutable=load(root/'heterogeneous-b/results/restore-immutable-signatures.json');assert immutable['all_equal']
backup['immutable_sql_verification']=immutable
out['heterogeneous']=runs;out['backup_restore']=backup;out['readers']=readers;out['search_recovery']=load(root/'search-recovery.json')
out['status']='completed_safe_optimizations; physical_capacity_conditional; first_ingest_NO_GO'
out['validation']['restore_first_attempt']={'legacy_benchmark_runner_aborted_on':'HTTP_429','durable_pending_rows':583,'failed_rows_with_http_429':2,'resolution':'Private backup/restore rerun using the unchanged application persistent scheduler; no retry timestamps, leases, fsync or quotas relaxed.'}
out['protocol']={'paired_runs':1,'baseline':'heterogeneous-a2','candidate':'heterogeneous-b','baseline_image':'palimora-p5-completion','candidate_image':'palimora-storage-candidate','original_source_bind':'readonly','quotas':{'worker':'4 CPUs / 3 GiB','projection':'2 CPUs / 1.5 GiB','postgres':'2 CPUs / 2 GiB','opensearch':'2 CPUs / 3 GiB; heap 1 GiB'},'exploratory_run_excluded':'heterogeneous-a; collector did not handle provisional identities','collection_retries':'A2 ordinary collection retried after read-only helper fixes; timed ingest resources preserved separately.'}
out['validation'].update(build_passed=True,full_heterogeneous_p5_end_to_end_rerun=True,semantic_comparison_passed=True,canonical_ingest_time_comparison={'baseline':a['canonical_seconds'],'candidate':b['canonical_seconds']},wal_comparison={'baseline':a['wal_generated_bytes'],'candidate':b['wal_generated_bytes']},staging_comparison={'baseline':a['peaks']['staging_bytes'],'candidate':b['peaks']['staging_bytes']})
comparison={}
for label,r in runs.items():
 m=r['maintenance'];v=dict(pack=m['physical']['pack'],postgres=m['after']['database_bytes'],opensearch=m['index']['store']['size_in_bytes']);v['total']=sum(v.values());comparison[label]=v
comparison['saving_percent']={k:100*(comparison['baseline'][k]-comparison['candidate'][k])/comparison['baseline'][k] for k in comparison['baseline']}
out['heterogeneous_comparison']=comparison
out['filesystem_comparison']={label:{'postgres':r['physical_services']['postgres'],'opensearch':r['physical_services']['search'],'archive':r['maintenance']['physical']['archive'],'archive_allocated_bytes':r['pack']['storage']['allocated'],'total_allocated_bytes':r['physical_services']['postgres']['allocated']+r['physical_services']['search']['allocated']+r['pack']['storage']['allocated'],'total_apparent_bytes':r['physical_services']['postgres']['apparent']+r['physical_services']['search']['apparent']+r['maintenance']['physical']['archive']} for label,r in runs.items()}
# Current catalog relations are charged ONCE per plausible unique identity.
# Avoid per-row attribution of a global taxonomy invalidation to 60 sampled rows.
current_names={'catalog_documents','catalog_work_tags','catalog_work_filters','catalog_entity_works'}
current=sum(t['total_bytes'] for t in b['tables'] if t['relname'] in current_names)/b['counts']['works']
cats={r['source']:r for r in b['categories']};search={r['source']:r for r in b['category_search']};oldcats={r['category']:r for r in old['categories']}
def costs(name):
 r=cats[name];n=oldcats[name]['sampled_records'];before=r['before'];after=r['after'];projected=r['projection']['after']
 groups={k:max(0,projected['storage_groups'][k]-before['storage_groups'][k])/n for k in ['canonical','history','dictionary']}
 compressed=oldcats[name].get('source',{}).get('original_compressed_bytes')
 return dict(n=n,groups=groups,pack_per_record=(after['object_stored_bytes']-before['object_stored_bytes'])/n,index_per_record=search[name]['store_bytes']/n,pack_ratio=(after['object_stored_bytes']-before['object_stored_bytes'])/compressed if compressed else None,index_ratio=search[name]['store_bytes']/compressed if compressed else None)
metadata={'sample_ao3.sqlite3':22249303,'sample_ao3_deduped.sqlite3':17656566,'sample_ao3_old_files.sqlite3':8331596}
unique={'favorable':16780865+34,'central':16780865+34,'prudent':16780865+4048643+34}
metadata_only={'favorable':0,'central':1479056+34,'prudent':1479056+34}
scenarios=[]
backup_ratio=backup['backup_payload_bytes']/(b['maintenance']['physical']['pack']+b['maintenance']['after']['database_bytes'])
for historical in old['capacity']['scenarios']:
 scenario=historical['scenario'];pack=pg_noncurrent=index=0;strata=[]
 for kind in ['epub-small','epub-medium','epub-large','epub-huge','txt','html']:
  name=kind.replace('huge','extreme')+'.zip';choices=[costs(name)]+([costs('media-'+name)] if kind.startswith('epub') else [])
  def choose(values):return values[0] if scenario=='central' else (min(values) if scenario=='favorable' else max(values))
  pc=choose([x['pack_ratio'] for x in choices]);ic=choose([x['index_ratio'] for x in choices]);sql=choose([sum(x['groups'].values()) for x in choices]);f=old['format_inventory'][kind]
  p=f['compressed_bytes']*pc/G;q=f['members']*sql/G;i=f['compressed_bytes']*ic/G
  pack+=p;pg_noncurrent+=q;index+=i;strata.append(dict(kind=kind,pack_gib=p,postgres_noncurrent_gib=q,search_gib=i,records=f['members'],pack_ratio=pc,index_ratio=ic,postgres_noncurrent_bytes_per_record=sql))
 meta_pack=sum(n*costs(name)['pack_per_record']/G for name,n in metadata.items());meta_pg=sum(n*sum(costs(name)['groups'].values())/G for name,n in metadata.items());pack+=meta_pack;pg_noncurrent+=meta_pg
 weighted_index=sum(n*costs(name)['index_per_record'] for name,n in metadata.items())/sum(metadata.values());meta_index=metadata_only[scenario]*weighted_index/G;index+=meta_index
 csv_rows=historical['csv_estimated_rows'];pack+=historical['csv_pack_gib'];csv_noncurrent=csv_rows*sum(sum(costs(name)['groups'].values()) for name in metadata)/3/G;pg_noncurrent+=csv_noncurrent;index+=csv_rows*weighted_index/G
 pg_current=(unique[scenario]+csv_rows)*current/G;pg=pg_noncurrent+pg_current
 # Existing absolute maintenance and safety reservations are never decreased.
 maintenance=max(historical['maintenance_gib'],pack,pg,index)
 operational=historical['metadata_cache_gib']+historical['wal_retention_budget_gib']+historical['backlog_budget_gib']+historical['staging_temporary_gib']+historical['search_translog_budget_gib']+historical['untyped_raw_budget_gib']+b['fixed']['database_bytes']/G
 before_margin=pack+pg+index+operational+maintenance;margin=max(historical['safety_margin_gib'],before_margin*.25)
 scenarios.append(dict(scenario=scenario,pack_gib=pack,postgres_gib=pg,postgres_current_gib=pg_current,postgres_noncurrent_gib=pg_noncurrent,search_store_gib=index,persistent_core_gib=pack+pg+index,unique_work_sensitivity=unique[scenario],csv_additional_work_sensitivity=csv_rows,sqlite_records=sum(metadata.values()),sqlite_noncurrent_gib=meta_pg,sqlite_pack_gib=meta_pack,sqlite_additional_current_sensitivity=metadata_only[scenario],sqlite_search_gib=meta_index,metadata_cache_gib=historical['metadata_cache_gib'],untyped_raw_budget_gib=historical['untyped_raw_budget_gib'],fixed_postgres_gib=b['fixed']['database_bytes']/G,operational_total_gib=operational,wal_retention_budget_gib=16,backlog_budget_gib=8,staging_temporary_gib=8,search_translog_budget_gib=8,maintenance_gib=maintenance,safety_margin_gib=margin,working_total_gib=before_margin+margin,backup_one_copy_gib=(pack+pg)*backup_ratio*1.25,restore_working_gib=before_margin+margin,strata=strata))
out['capacity_sensitivity']={'scenarios':scenarios,'current_catalog_bytes_per_unique_work':current,'measured_backup_ratio':backup_ratio,'metadata_coefficients':{name:costs(name) for name in metadata},'unverified_filename_single_work_member_upper_sensitivity':46876154,'method':'Current catalog charged once per unique identity; canonical/history/dictionary charged conservatively per acquisition. ZIP indexing keeps all source-version volume as a conservative sensitivity, without assuming proportional savings from duplicate IDs. SQLite search uses distinct additional identities. CSV count remains P5 size-based estimate. No statistical confidence interval. History/content dedup and graph tail cardinalities remain unknown. Existing maintenance/safety absolute reservations are not reduced.','definitive_layout_approved':False}
closure_bytes=next(t['total_bytes'] for t in b['tables'] if t['relname']=='catalog_work_filters')/b['counts']['filter_associations']
central=next(s for s in scenarios if s['scenario']=='central')
for scenario in scenarios:
 scenario['working_plus_one_backup_gib']=scenario['working_total_gib']+scenario['backup_one_copy_gib']
 scenario['working_backup_parallel_restore_gib']=scenario['working_plus_one_backup_gib']+scenario['restore_working_gib']
out['capacity_sensitivity']['unmodelled_graph_tail']={'measured_filter_relation_bytes_per_association':closure_bytes,'extra_gib_per_additional_filter_per_central_work':closure_bytes*(unique['central']+central['csv_additional_work_sensitivity'])/G,'note':'Sample-density sensitivity, not a measured full-graph closure bound. Work filters are retained.'}
out['capacity_sensitivity']['unverified_filenames_extreme']={'single_work_members_plus_sqlite':46876154,'additional_current_sql_gib_over_central':(46876154-unique['central'])*current/G,'additional_metadata_search_gib_over_central':(16468371+34-metadata_only['central'])*weighted_index/G,'note':'All ZIP members treated as separate works and no SQLite overlap. Excludes extra CSV uncertainty; not an absolute bound. Main scenarios assume filename candidates are valid.'}
p5['storage_overhaul']={'report':'performance-storage-overhaul.json','historical_results_preserved':True,'capacity_sensitivity':out['capacity_sensitivity'],'first_ingest':'NO-GO'}
# Keep relevant storage counters; raw private reports retain zero-valued remote,
# query-cache and replica copies. No metric used in the comparison is discarded.
def compact_index(v):
 result={k:v[k] for k in ['docs','store','indexing','merges','translog'] if k in v}
 if 'segments' in v:result['segments']={k:x for k,x in v['segments'].items() if k not in ['remote_store','segment_replication']}
 if 'translog' in result:result['translog']={k:x for k,x in result['translog'].items() if k!='remote_store'}
 return result
for run in runs.values():
 run['maintenance']['index']=compact_index(run['maintenance']['index'])
 for category in run['categories']:
  category['projection']['index']={'primaries':compact_index(category['projection']['index']['primaries'])}
for candidate in out['opensearch']:
 for phase in ['writing','settled','ordinary','benchmark_only_force_merge','immediate_after_force_merge']:
  candidate[phase]=compact_index(candidate[phase])
out['physical_capacity_observation']=load(root/'filesystem-capacity.json')
(repo/'docs/performance-storage-overhaul.json').write_text(json.dumps(out,indent=2)+'\n');(repo/'docs/performance-p5-final.json').write_text(json.dumps(p5,indent=2)+'\n')
print(json.dumps(comparison,indent=2));print(json.dumps([{k:v for k,v in r.items() if k!='strata'} for r in scenarios],indent=2))
