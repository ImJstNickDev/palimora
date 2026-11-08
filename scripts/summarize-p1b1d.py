#!/usr/bin/env python3
"""Consolidate private P1B.1d artifacts; print only aggregate, content-free results."""
import json
import pathlib
import statistics
import sys

base = pathlib.Path(sys.argv[1])

def read(path):
    return json.loads(path.read_text())

def results(name):
    return base / ('palimora-' + name + '-20261108') / 'results'

def latency(name):
    root = base / ('palimora-p1b1d-' + name + '-20261108')
    return {key: read(root / filename) for key, filename in [('idle','http-idle.json'),('backlog','http-backlog.json'),('queues','latency-load.json')]}

def baseline(name, public):
    root = base / name / 'results'
    before, after = read(root / 'before.json'), read(root / 'after.json')
    resources = read(root / 'resources-summary.json')['operational-resources']
    cycle, peaks = {}, []
    for line in (root / 'operational-resources.jsonl').read_text().splitlines():
        sample = json.loads(line)
        kind = sample['container'].rsplit('-', 1)[-1]
        if kind == 'worker':
            cycle = {}
        cycle[kind] = sample['working_bytes']
        if kind == 'redis' and len(cycle) == 4:
            peaks.append(sum(cycle.values()) / 1048576)
    return {
        'scenario':'B', 'end_to_end_seconds':public['timing']['seconds'],
        'works_per_second':public['timing']['works_per_second'],
        'current_seconds':None, 'historical_seconds':None,
        'catalog_combined_seconds':public['catalog_active_seconds'],
        'text_active_seconds':public['text_active_seconds'],
        'catalog_sql_calls':public['catalog_sql']['calls'],
        'cpu_total_seconds':sum(r['cpu_seconds'] for r in resources.values()),
        'simultaneous_peak_working_mib':max(peaks),
        'wal_delta_bytes':float(after['wal'][0]['wal_bytes']) - float(before['wal'][0]['wal_bytes']),
    }

p1a = read(pathlib.Path('docs/performance-p1a.json'))
a = read(results('p1b1d-a') / 'integration-summary.json')
b = read(results('p1b1d-b') / 'integration-summary.json')
# Keep aggregate ingest instrumentation; per-group traces remain private.
a['ingest'] = {k:v for k,v in a['ingest'].items() if k != 'groups'}
old0 = baseline('palimora-p0-20261108-b', p1a['runs']['P0_B'])
old1 = baseline('palimora-p1a-b-20261108', p1a['runs']['P1A_B'])
new = {
    'scenario':'B','end_to_end_seconds':b['timing']['seconds'], 'works_per_second':b['timing']['works_per_second'],
    'current_seconds':b['bibliography']['totals']['current_slice']['seconds'],
    'historical_seconds':b['bibliography']['totals']['historical_slice']['seconds'],
    'catalog_combined_seconds':b['catalog_active_seconds'], 'text_active_seconds':b['text_active_seconds'],
    'catalog_sql_calls':b['catalog_sql_calls'], 'cpu_total_seconds':b['cpu_total_seconds'],
    'simultaneous_peak_working_mib':b['working_set_simultaneous_peak_mib'], 'wal_delta_bytes':b['wal_delta_bytes'],
}
control_root = base / 'palimora-p1b1d-control-20261108'
order = ['old','new','new','old','old','new']
controls = [{'order':i, 'variant':mode, 'measurements':read(control_root / f'{i}-{mode}.json')} for i,mode in enumerate(order,1)]
control_summary = {}
for mode in ['old','new']:
    values = [x['measurements'][0]['seconds'] for x in controls if x['variant']==mode]
    control_summary[mode] = {'median_seconds':statistics.median(values),'min_seconds':min(values),'max_seconds':max(values)}
eq = results('p1b1d-equivalence')
equivalence = read(eq / 'equivalence-result.json')
assert all(all(v == 0 for v in relation.values()) for relation in equivalence.values())
assert read(eq / 'verify.json')['verified'] == 107054
assert read(eq / 'reprojection.json')['generations_verified'] == 11032
faults = read(eq / 'p1a-functional.json')
history = read(eq / 'history-functional.json')
assert faults['all_current_generations_verified'] == 11032
assert history['equivalence'] and history['crash_after_insert_and_retry']
report = {
    'phase':'P1B.1d', 'status':'P1B.1 integration, A/B/C benchmarks and correctness verification complete; observed interactive-latency regressions retained below',
    'date':'2026-11-08', 'application_commit':'c3dcb57118d19e8aeabaa70da1b21e29629c8486',
    'method':{
        'runners':['benchmark-p0.sh','benchmark-release.cjs','benchmark-performance-operational.cjs','benchmark-projection-latency.cjs','benchmark-performance-http.cjs'],
        'configuration':'Parser2/commit2, current20/historical20/text16; existing scheduler and AO3 seeding enabled; no CPU/RAM limits; isolated PostgreSQL17.6/Redis7.4.6/OpenSearch2.19.4 heap1GiB and PackStore; fsync/synchronous_commit/full_page_writes on',
        'corpus':read(results('p1b1d-b') / 'environment.json')['corpus'],
        'instrumentation':'Original P0 profiler and cgroup samplers; optional bibliography preload adds mutually exclusive current/historical slices inside projectCatalog, inclusive enrichment and nested SQL/lock spans. Never add nested phases or overlapping B stages.',
        'verification_extension':'Existing ID/API/reader/queue checks retained; final timed verifier additionally checks all11032 generations and historical-view count. No weakened criteria.',
        'A_boundaries':'Direct ingest, normal combined catalog batches, then full-text, refresh/API verification. Current/historical slices partition each catalog call; initial coordination separately measured. Historical slice includes commit.',
        'B_boundaries':'From persisted batch enqueue through all IDs/generations/API verification; API and worker are real distinct processes in one app container, as P1A. Resource window also covers startup/shutdown.',
        'C_boundaries':'Unchanged HTTP probe:3 warmups+100 sequential authenticated requests/endpoint, internal HTTP. Same new B corpus, P1A then P1B.1. Standard1000 cached historical views; supplemental5000 derived views removed in both variants for real historical work; both bibliography queues asserted nonempty at probe end. Text-only1000 attribution pair also reported.',
        'current_regression_control':'Unchanged probe-history-contention.cjs on same copied/ANALYZEd logged facts;256 current with/without256 historical, baselineP1B.1b vsP1B.1c, order old/new/new/old/old/new, no instrumentation or concurrent benchmarks',
        'private_root':str(base), 'runs_per_AB_case':1,
    },
    'runs':{'A':a,'B':b},
    'operational_comparison':{'P0':old0,'P1A':old1,'P1B1':new},
    'improvements':{
        'B_vs_P1A_speedup':old1['end_to_end_seconds']/new['end_to_end_seconds'],
        'B_vs_P1A_seconds_saved':old1['end_to_end_seconds']-new['end_to_end_seconds'],
        'B_vs_P1A_catalog_queries_eliminated':old1['catalog_sql_calls']-new['catalog_sql_calls'],
        'B_vs_P0_speedup':old0['end_to_end_seconds']/new['end_to_end_seconds'],
        'A_vs_P0_A2_speedup':read(pathlib.Path('docs/performance-p0.json'))['runs']['A2']['timing']['seconds']/a['timing']['seconds'],
    },
    'latency':{
        'historical_P1A_reference':p1a['projection_latency_probe']['P1A'],
        'standard1000':{v:latency('c-'+v) for v in ['p1a','p1b1']},
        'historical_regeneration5000':{v:latency('cold-'+v) for v in ['p1a','p1b1']},
        'text_only1000':{v:latency('text-latency-'+v) for v in ['p1a','p1b1']},
    },
    'current_control':{'baseline_commit':'d5fcde3837890cd82aa52dc80f2e8afb2b437c10','runs':controls,'summary':control_summary},
    'validation':{
        'reference':'Original preserved P1A same-ID bibliography capture; cold copy of reference database, original PackStore read-only; freshly regenerate all historical views and current documents, then index and compare actual normalized values/relations',
        'equivalence':equivalence,'counts':b['integration']['counts'],
        'historical_regeneration':read(eq/'historical-regeneration-new.json'),
        'current_reprojection_and_search':read(eq/'reprojection.json'),
        'canonical_objects_verified':read(eq/'verify.json')['verified'],
        'fault_probes':faults,'historical_probes':history,
        'build':'Complete Docker API build (includes all workspace builds) passed; existing Vite large-chunk warning',
        'ingest_pipeline_tests':{'passed':2,'failed':0,'skipped':0},
    },
    'limitations':[
        'Shared host and uncontrolled caches; one A/B pass, small controlled C samples; no SLO or statistical confidence guarantee.',
        'P0/P1A current and historical active times were not separately instrumented; null is missing, not zero.',
        'P0 B includes6128 extra projections/PUTs; P1A and P1B.1 have equal work counts.',
        'Main1000-view probe ends with only full-text backlog in P1B.1; supplemental5000 probe keeps both bibliography queues active and does actual historical materialization.',
        'Search p95 worsens in the matched backlog probes; preserve this observation. Text-only unchanged engine also varies, so the full latency difference is not causally isolated. No claim of unchanged interactive latency.',
        'Current-only +8.17% from P1B.1c is not reproduced in the alternating control; ranges overlap and new median is lower.',
        'Worker first I/O sample is null; partial441-second interval reported separately, no invented complete total. Network RX/TX sees both ends of internal traffic.',
        'WAL and physical I/O include checkpoints/writeback/background activity; lower WAL does not imply proportional physical-I/O reduction.',
        'Graph has no edges in the real corpus; graph invalidations tested with fixtures, no large-graph performance claim.',
        'Normalized equivalence preserves tag/entity sets; generation coherence checked against current PostgreSQL, not equality to legacy P1A hash ordering.',
        'No product architecture/default change in P1B.1d. Keep20/20/16 defaults; larger batches have only subsystem throughput evidence and higher memory cost.',
        'Full-text remains dominant: residual reconstruction/SQL/reads/commit as well as individual PUT; P1B.2/P2/P3/P4/P5 not implemented.',
    ],
}
print(json.dumps(report, indent=2, ensure_ascii=False))
