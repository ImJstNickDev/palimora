#!/usr/bin/env python3
"""Aggregate private measurements without corpus text, member paths or credentials."""
import json,pathlib,sys,collections
root=pathlib.Path(sys.argv[1]);repo=pathlib.Path(__file__).resolve().parents[1]
def read(name):return json.loads((root/name).read_text())
def stats(s):return {k:s[k] for k in ['store','translog','segments','merges','indexing','docs'] if k in s}
identity=read('identities.json');zipids=read('zip-identities.json');h={int(k):v for k,v in identity['identity_membership_histogram'].items()}
identity['ancillary_tags']=read('sqlite-tags.json')
for row in identity['sources']:
 if 'duplicate_identified_records' in row:row['duplicate_identified_records_in_source_group']=row.pop('duplicate_identified_records')
 if 'unique_identified' in row:row['additional_identified_in_source_group']=row.pop('unique_identified')
identity['zip_sources']=zipids['sources'];identity['zip_internal_duplicate_pass']={k:zipids[k] for k in ['seconds','peak_rss_kib','bitmap_limit']};identity['sqlite_only_if_zip_candidates_valid']=1479056;identity['metadata_unique']=sum(v for k,v in h.items() if k&7);identity['zip_candidate_unique']=sum(v for k,v in h.items() if k&8);identity['intersection']=sum(v for k,v in h.items() if k&7 and k&8)
search=read('search.json');settled={r['name']:r for r in read('search-settled.json')}
for r in search:
 r['writing']=stats(r['writing']);r['settled']=stats(r['settled']);s=settled[r['name']]
 r['ordinary']=stats(s['ordinary']);r['benchmark_only_force_merge']=stats(s['benchmark_only_force_merge']);r['ordinary_files']=s['ordinary_files'];r['merged_files']=s['merged_files'];r['merge_seconds']=s['merge_seconds'];r['merge_peak_physical_bytes']=s['merge_peak_physical_bytes'];r['merge_extra_sampled_bytes']=s['merge_extra_sampled_bytes']
 r['immediate_after_force_merge']=stats(s['immediate_after_force_merge'])
 if 'post_recovery_cleanup' in s:r['post_recovery_cleanup']=s['post_recovery_cleanup']
by={r['name']:r for r in search};assert 'd-zstd3' in by
pack=read('pack.json');pack.pop('by_kind',None);pgbefore=read('postgres-before.json');pgafter=read('postgres-after.json')['database']
out={'schema':'palimora.storage-overhaul.v1','reference_commit':'1a7dd6ac65e7d6dbfa154113c50fefef5c7a09fc','status':'safe_changes_validated_on_partial_corpus; requested_full_campaign_incomplete','first_real_ingest':'NO-GO','identity_census':identity,'pack':pack,'txt_p5_probe':read('txt.json'),'dictionary_probe':read('dictionary.json'),'postgres':{'before':pgbefore,'after_database_bytes':pgafter,'after_relations':read('postgres-after-relations.json'),'removed_indexes_bytes':20194976,'ordinary_vacuum':True,'lookup_plan':read('postgres-plan.json'),'compact_keys_probe':{'associations':167736,'tags':57661,'fresh_text_bytes':58245120,'fresh_bigint_bytes':22585344,'separate_mapping_bytes':13664256,'lookup_ms':0.302,'adopted':False},'wal_generated':None},'opensearch':search,'derived_source':read('derived.json'),'adopted':{'pack':'unchanged v1 / Zstd 3','postgres':'drop catalog_metadata and catalog_title','opensearch':'source excludes text; zstd level 3; recovery source retained'},'validation':{'unique_targeted_tests_passed':19,'failed_setup_attempts':['missing OPENSEARCH_URL','missing TYPST_PATH; rerun passed'],'txt_probe_1g_exit':137,'txt_probe_6g_completed':True,'full_dump_ingest':False,'full_heterogeneous_p5_end_to_end_rerun':False,'canonical_ingest_time_comparison':None,'wal_comparison':None,'staging_comparison':None,'maintenance_reserve_reduction':0}}
comparisons={}
for mode in ['ordinary','benchmark_only_force_merge']:
 before={'pack':pack['physical_bytes'],'postgres':pgbefore['database'],'opensearch':by['a'][mode]['store']['size_in_bytes']};after={'pack':pack['physical_bytes'],'postgres':pgafter,'opensearch':by['d-zstd3'][mode]['store']['size_in_bytes']}
 before['total']=sum(before.values());after['total']=sum(after.values());comparisons[mode]={'before':before,'after':after,'saving_percent':{k:100*(before[k]-after[k])/before[k] for k in before}}
out['comparison']=comparisons
resources=collections.defaultdict(lambda:dict(peak_memory_bytes=0,peak_working_bytes=0))
for line in (root/'resources.jsonl').read_text().splitlines():
 r=json.loads(line)
 if 'memory_bytes' not in r:continue
 a=resources[r['container']];a['peak_memory_bytes']=max(a['peak_memory_bytes'],r['memory_bytes']);a['peak_working_bytes']=max(a['peak_working_bytes'],r['working_bytes']);a.setdefault('first_cpu_ns',r['cpu_ns']);a['last_cpu_ns']=r['cpu_ns']
out['resources']={'partial_window_only':True,'roles':dict(resources)}
p5=json.loads((repo/'docs/performance-p5-final.json').read_text());scenarios=[]
# Sensitivity only: transfer the ordinary EPUB corpus coefficient to EPUB strata.
# Do not subtract historical/provenance costs or assume metadata rows are works.
factor=by['d-zstd3']['ordinary']['store']['size_in_bytes']/by['a']['ordinary']['store']['size_in_bytes']
for old in p5['completion']['capacity']['scenarios']:
 s={k:v for k,v in old.items() if k not in ['strata','metadata']};saved=sum(r['search_gib'] for r in old['strata'] if r['kind'].startswith('epub'))*(1-factor)
 s['search_store_gib']-=saved;s['working_total_gib']-=saved;s['restore_working_gib']-=saved
 s['persistent_core_gib']=s['pack_gib']+s['postgres_gib']+s['search_store_gib'];s['metadata_postgres_unvalidated_gib']=old['metadata']['postgres_gib'];s['not_a_forecast']=True
 # Keep absolute maintenance/safety reservations: no proof supports reducing them.
 scenarios.append(s)
out['capacity_sensitivity']={'epub_index_factor':factor,'scenarios':scenarios,'sql_overlap_saving_credited_gib':0,'sql_index_saving_extrapolated_gib':0,'absolute_maintenance_and_safety_reserves_unchanged':True,'definitive_capacity_established':False}
(repo/'docs/performance-storage-overhaul.json').write_text(json.dumps(out,indent=2)+'\n')
p5['storage_overhaul']={'report':'performance-storage-overhaul.json','historical_results_preserved':True,'sqlite_identity_correction':{'rows':48237465,'unique':16468371,'central_2351_gib_not_demonstrated':True},'capacity_sensitivity':out['capacity_sensitivity'],'first_ingest':'NO-GO'}
(repo/'docs/performance-p5-final.json').write_text(json.dumps(p5,indent=2)+'\n')
print(json.dumps(comparisons,indent=2));print(json.dumps(scenarios,indent=2))
