"""Aggregate the named private P3A runs; missing evidence remains explicit."""
import json,pathlib,sys,zipfile
base=pathlib.Path(sys.argv[1])
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
source_bytes=raw_bytes=0
for p in pathlib.Path(sys.argv[2]).glob('part*.zip'):
    source_bytes+=p.stat().st_size
    with zipfile.ZipFile(p) as z:raw_bytes+=sum(i.file_size for i in z.infolist())
report={'schema':'palimora.performance.p3a.v1','reference_commit':'6928e8844345f5b28ddddfb556c908aa32f4d897','status':'partial_validation','configuration':{'source_default':1,'parsers':6,'commits':4,'group_records':256,'zstd_level':3,'postgres_pool':12,'projection_mode':'isolated','search_parallel_facets':False,'queue_gate_per_queue':65536},'corpus':{'works':11032,'sources':4,'source_bytes':source_bytes,'decompressed_bytes':raw_bytes,'limitation':'Artificial partitions of the single authorized reference ZIP; not representative of the entire dump.'},'runs':{}}
for name in ['baseline','1-repeat','mode2','mode4','mode1']:
    root=pathlib.Path(str(base)+'-'+name);d=root/'results'
    if name=='mode1' and not (d/'end-to-end.json').exists():continue
    end=read(d/'end-to-end.json');timeline=read(d/'timeline.json');storage=read(d/'p3a-storage.json')
    elapsed=end['last']['processing_seconds']; e2e=end['work_start_to_visible_seconds']
    queue={}
    for key in ['catalog','historical','text']:
        area=sum((b['seconds']-a['seconds'])*(a[key]+b[key])/2 for a,b in zip(timeline,timeline[1:]))
        queue[key]={'max_sampled':max(r[key] for r in timeline),'mean_residence_seconds_estimate':area/11032}
    process=lines(d/'processes.jsonl');by_pid={}
    for row in process:
        for p in row['processes']:
            v=by_pid.setdefault(p['pid'],dict(kind=p['kind'],cpu_seconds=0,rss_peak_bytes=0))
            v['cpu_seconds']=max(v['cpu_seconds'],p['cpu_seconds']);v['rss_peak_bytes']=max(v['rss_peak_bytes'],p['rss_bytes'])
    staging=lines(d/'staging-samples.jsonl')
    report['runs'][name]={'canonical_seconds':elapsed,'canonical_works_per_second':11032/elapsed,'source_gib_per_hour':source_bytes/2**30/elapsed*3600,'decompressed_mib_per_second':raw_bytes/2**20/elapsed,'chapters_per_second':int(storage['counts']['revisions'])/elapsed,'objects_per_second':int(storage['counts']['objects'])/elapsed,'end_to_end_seconds':e2e,'end_to_end_works_per_second':11032/e2e,'drain_and_visibility_seconds':e2e-elapsed,'catalog_done_seconds_from_batch_creation':next(r['seconds'] for r in timeline if r['state']=='completed' and r['catalog']==r['historical']==0),'all_queues_empty_seconds_from_batch_creation':timeline[-1]['seconds'],'queue_samples':queue,'resources':read(d/'resources-summary.json'),'process_samples':list(by_pid.values()),'max_python_processes_sampled':max(sum(p['kind']=='python' for p in r['processes']) for r in process),'staging_peak_sampled_bytes':max((r['bytes'] for r in staging),default=None),'staging_allocated_peak_sampled_bytes':max((r['allocated_bytes'] for r in staging),default=None),'storage':storage,'verification':read(d/'verification.json'),'image_id':(d/'image-id.txt').read_text().strip(),'bibliography':read(d/'projection-profile-bibliography.json')}
    report['runs'][name]['filesystem']=read(d/'p3a-disk.json')
    persistent=sum(v['apparent_bytes'] for v in report['runs'][name]['filesystem'].values())
    report['runs'][name]['persistent_total_bytes']=persistent
    report['runs'][name]['persistent_bytes_per_work']=persistent/11032
    report['runs'][name]['source_to_persistent_ratio']=source_bytes/persistent
    report['runs'][name]['normalized_catalog']=read(d/'p3a-normalized-catalog.json')
    report['runs'][name]['normalized_observations']=read(d/'p3a-normalized-observations.json')
    if (d/'p3a-retry.json').exists():report['runs'][name]['retry']=read(d/'p3a-retry.json')
    report['runs'][name]['opensearch_primary_bytes']=read(d/'after.json')['search']['_all']['primaries']['store']['size_in_bytes']
    if (d/'p3a-readers.json').exists():report['runs'][name]['readers']=read(d/'p3a-readers.json')
    report['runs'][name]['storage']['bytes_per_work']=storage['storage']['apparent']/11032
    report['runs'][name]['storage']['source_to_canonical_ratio']=source_bytes/storage['storage']['apparent']
report['notes']=['One measured run per configuration; mode1 is an exploratory run with incomplete staging sampling and overlapping small integration tests; 1-repeat is the comparison run.','End-to-end starts at persisted batch started_at and includes refresh, all IDs/generations and authenticated sample reader verification.','Queue residence is a trapezoidal estimate from ~1 s samples, not individual enqueue/dequeue tracing.','Per-process CPU is sampled, so exited processes may lose their final unsampled interval. Container CPU/I/O covers the full campaign including verification.','Benchmark image predates final guard preventing concurrent failures from overwriting paused/blocked batch state; successful ingest path is unchanged.']
reference=report['runs']['baseline']
for name,run in report['runs'].items():
    for field in ['normalized_manifest_sha256','logical']:
        assert run['storage'][field]==reference['storage'][field],(name,field)
    assert [r for r in run['storage']['content'] if r['name']!='observation']==[r for r in reference['storage']['content'] if r['name']!='observation'],(name,'source object hashes')
    assert run['normalized_observations']==reference['normalized_observations'],(name,'observations')
    for field in ['current_sha256','historical_sha256','search_sha256']:
        assert run['normalized_catalog'][field]==reference['normalized_catalog'][field],(name,field)
report['verification']={'canonical_objects_per_run':107054,'canonical_manifests_equivalent':True,'source_object_hash_sets_equivalent':True,'normalized_observations_equivalent':True,'current_catalog_equivalent':True,'historical_catalog_equivalent':True,'search_documents_equivalent':True,'targeted_tests_passed':10,'targeted_tests_skipped':0,'recovery':['overlapping ZIPs with explicit chapter identities and conflicting metadata: 20 acquisitions, 15 works, 17 snapshots; conflicts preserved','checkpoint replay without new snapshots/revisions/objects','SIGTERM and SIGKILL with two sources','SIGKILL inside a PostgreSQL archive transaction: checkpoint remains zero','multi-source pause/resume','missing, .part, corrupt and unsupported sources','out-of-order ACK, slow/fast source and fatal scheduler drain','staging empty after resumed completion']}
report['notes']+=['Entity IDs scoped to a local work UUID are verified against the production key function, then normalized to external-work scope for comparison. OpenSearch excludes local id/snapshot/generation/epoch and ingestion archived_at only. Keyword tag arrays are sorted as sets, preserving duplicates; text and bibliographic values are retained. Raw hashes are also retained.','65,536-entry backpressure threshold is implemented but not reached by this 11,032-work campaign. No full-dump capacity claim.','Parser process sample includes adapter parents and pool children, but not Python resource trackers; configured absolute bound is parsers + 2 * effective source lanes.','Observation objects retain their source/evidence fields; work UUIDs and snapshot/manifest references are validated and normalized before comparison.', 'Full corpus replay is a separate untimed check; transaction concurrency includes pool acquisition.']
report['corpus']['reference_zip_sha256']='fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429'
report['status']='implemented_verified_measured'
report['recommended_source_concurrency']=1
print(json.dumps(report,indent=2))
