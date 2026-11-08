#!/usr/bin/env python3
"""Publish content-free P1A aggregates; input roots retain the raw P0 instrumentation."""
import json
import pathlib
import sys


def read(root, filename):
    return json.loads((pathlib.Path(root) / 'results' / filename).read_text())


def run(root):
    summary = read(root, 'p0-summary.json')
    profile = read(root, 'api-profile.json')['totals']
    departures = {r['queue']: int(r['departures']) for r in read(root, 'after.json')['queue_departures']}
    result = {
        'image_id': (pathlib.Path(root) / 'results/image-id.txt').read_text().strip(),
        'timing': read(root, 'end-to-end.json'),
        'verification': {k: v for k, v in read(root, 'verification.json').items()
                         if k not in ['verified_at', 'monotonic_ns']},
        'current_projections': departures['catalog'],
        'historical_projections': departures['historical'],
        'additional_current_projections': departures['catalog'] - 11032,
        'document_puts': profile['http.document']['calls'],
        'catalog_active_seconds': profile['projectCatalog']['ms'] / 1000,
        'text_active_seconds': profile['projectText']['ms'] / 1000,
        'queue_residence': summary['queue_wait_bounds_seconds_per_visit'],
        'queue_residence_seconds_per_input_work': summary['queue_residence_seconds_per_input_work_including_service'],
        'queue_max': summary['queue_max'],
        'catalog_sql': summary['api-profile.json']['projectCatalog_sql'],
        'text_sql': summary['api-profile.json']['projectText_sql'],
        'database': read(root, 'after.json')['database'],
        'resources': read(root, 'resources-summary.json'),
    }
    for filename, key in [('http-latency.json', 'http'), ('p1a-functional.json', 'functional'), ('p1a-generations.json', 'generation_verification')]:
        if (pathlib.Path(root) / 'results' / filename).exists():
            result[key] = read(root, filename)
    if 'functional' in result:
        result['functional_scope'] = 'Same P1A image, retained isolated attribution corpus, before operational B; B generations verified separately.'
    return result


if len(sys.argv) not in (4, 6):
    raise SystemExit('Usage: summarize-p1a.py P0_B_ROOT INVALIDATION_ONLY_ROOT P1A_B_ROOT [P0_LATENCY_ROOT P1A_LATENCY_ROOT]')
result = {
    'schema': 'palimora.performance-p1a.v1',
    'date': '2026-11-08',
    'baseline_source_commit': '23afe66d36ac06c9716936987afdcdf05ffbfaa0',
    'baseline_artifacts_commit': '15241640c6bd653bd3d791c6490ec992b8e105e3',
    'corpus': read(sys.argv[3], 'environment.json')['corpus'],
    'p1a_source_hashes': (pathlib.Path(sys.argv[3]) / 'results/source-files-sha256.txt').read_text().splitlines(),
    'runs': dict(zip(['P0_B', 'invalidation_only_B', 'P1A_B'], map(run, sys.argv[1:4]))),
    'limitations': [
        'One operational run per variant on a shared host; warm/uncontrolled caches.',
        'Same P0 profiler, services, settings, corpus and verification; AO3 seeding enabled, external network unavailable.',
        'Queue residence includes service; sample-derived bounds are not per-item timestamps.',
        'Active stage spans overlap and are not CPU time.',
        'CPU 100 percent is one core; RAM is cgroup working set; I/O includes writeback.',
        'Original P0 has no concurrent ingest/HTTP latency baseline; separate matched projection-backlog diagnostics are reported.',
    ],
}
if len(sys.argv) == 6:
    result['projection_latency_probe'] = {
        label: {key: read(root, filename) for key, filename in [
            ('idle', 'http-idle.json'), ('backlog', 'http-backlog.json'), ('queues', 'latency-load.json')]}
        for label, root in zip(['P0_timers', 'P1A'], sys.argv[4:6])
    }
    result['limitations'].append('Matched HTTP diagnostic: same retained corpus, P0 timers then P1A; both include migrations 037–038; 100 samples per endpoint after 3 warmups. Backlog is 1000 current plus 1000 historical views, without concurrent ingest or AO3 worker.')
print(json.dumps(result, indent=2))
