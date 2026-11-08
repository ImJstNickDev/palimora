#!/usr/bin/env python3
"""Content-free A/B aggregates from retained P0 runners and optional P1B timings."""
import json
import pathlib
import sys


def read(root, name):
    path = root / name
    return json.loads(path.read_text()) if path.exists() else None


def summarize(argument):
    root = pathlib.Path(argument) / 'results'
    timing = read(root, 'end-to-end.json')
    operational = timing['scenario'] == 'B'
    filename = 'api-profile' if operational else 'projection-profile'
    profile = read(root, filename + '.json')['totals']
    before = read(root, 'before.json')
    after = read(root, 'after.json' if operational else 'after-projection.json')
    count_sql = lambda p, prefix: sum(v['calls'] for k, v in p.items() if k.startswith(prefix) and '.sql.' in k)
    result = {
        'timing': timing,
        'verification': {k: v for k, v in read(root, 'verification.json').items() if k not in ('monotonic_ns', 'verified_at')},
        'image_id': (root / 'image-id.txt').read_text().strip(),
        'catalog_sql_calls': count_sql(profile, 'projectCatalog.'),
        'catalog_sql_per_work': count_sql(profile, 'projectCatalog.') / 11032,
        'text_sql_calls': count_sql(profile, 'projectText.'),
        'catalog_active_seconds': profile['projectCatalog']['ms'] / 1000,
        'text_active_seconds': profile['projectText']['ms'] / 1000,
        'document_puts': profile['http.document']['calls'],
        'put_header_wait_seconds': profile['http.document']['ms'] / 1000,
        'put_body_bytes': profile['http.document']['bytes'],
        'full_text_non_put_seconds': (profile['projectText']['ms'] - profile['http.document']['ms']) / 1000,
        'legacy_single_work_bibliography_calls': profile.get('projectBibliography', {}).get('calls', 0),
        'graph_seconds': profile['projectGraph']['ms'] / 1000,
        'load_snapshot_seconds': profile.get('loadSnapshot', {}).get('ms', 0) / 1000,
        'chapter_bytes_seconds': profile.get('chapterBytes', {}).get('ms', 0) / 1000,
        'plain_seconds': profile.get('plain', {}).get('ms', 0) / 1000,
        'bibliography': read(root, filename + '-bibliography.json'),
        'queue_departures': after['queue_departures'],
        'database_delta': {k: float(after['database'][0][k]) - float(before['database'][0][k]) for k in before['database'][0]},
        'wal_delta_bytes': float(after['wal'][0]['wal_bytes']) - float(before['wal'][0]['wal_bytes']),
        'settings': after['settings'],
        'resources': read(root, 'resources-summary.json'),
        'integration': read(root, 'integration.json'),
        'search_stats': {k: after['search']['_all']['total'][k] for k in ['indexing','refresh','merges','translog','store']},
    }
    # The generic timing wrapper did not sample affected rows; only departures are counted.
    for metric in result['bibliography']['totals'].values():
        metric.pop('rows', None)
    result['database_delta']['scope'] = 'Whole fixture including probes, samplers and autocommit statements; not just explicit projection transactions'
    result['client_sql_calls'] = count_sql(profile, '')
    if operational:
        result['client_sql_calls'] += count_sql(read(root, 'worker-profile.json')['totals'], '')
    result['client_sql_scope'] = 'API + worker profiled clients' if operational else 'Projection client; excludes ingest client'
    result['client_sql_per_work'] = result['client_sql_calls'] / 11032
    # SQL hashes are stable and contain no query arguments.
    import hashlib
    commit = hashlib.sha256(b'COMMIT').hexdigest()[:16]
    result['catalog_explicit_commits'] = profile.get('projectCatalog.sql.' + commit, {}).get('calls', 0)
    result['text_explicit_commits'] = profile.get('projectText.sql.' + commit, {}).get('calls', 0)
    all_resources = [v for phase in result['resources'].values() for v in phase.values()]
    result['cpu_total_seconds'] = sum(v['cpu_seconds'] for v in all_resources)
    result['io_total_mib'] = {k: sum(v[k] for v in all_resources) if all(v[k] is not None for v in all_resources) else None for k in ['read_mib','write_mib','rx_mib','tx_mib']}
    if operational:
        samples = [json.loads(line) for line in (root / 'operational-resources.jsonl').read_text().splitlines()]
        cycle, peaks = {}, []
        result['partial_io'] = {}
        for suffix in ['worker','pg','search','redis']:
            rows = [x for x in samples if x['container'].endswith('-' + suffix)]
            available = [x for x in rows if x['io'] is not None]
            if len(available) >= 2 and len(available) != len(rows):
                a,b = available[0], available[-1]
                io = lambda row,op: sum(v['value'] for v in row['io'] if v['op'].lower() == op)
                result['partial_io'][suffix] = {
                    'scope': 'Available counter interval only; lower bound for full session, original sampler summary remains unchanged',
                    'seconds': b['time'] - a['time'], 'missing_start_seconds': a['time'] - rows[0]['time'],
                    'read_mib': (io(b,'read') - io(a,'read')) / 1048576,
                    'write_mib': (io(b,'write') - io(a,'write')) / 1048576,
                }
        for sample in samples:
            suffix = sample['container'].rsplit('-', 1)[-1]
            if suffix == 'worker':
                cycle = {}
            cycle[suffix] = sample['working_bytes']
            if suffix == 'redis' and len(cycle) == 4:
                peaks.append(sum(cycle.values()) / 1048576)
        result['working_set_simultaneous_peak_mib'] = max(peaks)
        summary = read(root, 'p0-summary.json')
        for k in ['queue_wait_bounds_seconds_per_visit','queue_residence_seconds_per_input_work_including_service','queue_max','processes']:
            result[k] = summary.get(k)
    else:
        result['ingest'] = read(root, 'ingest-default.json')['profile']
        result['phase_rates'] = {'ingest': 11032 / timing['ingest_seconds'], 'catalog_combined': 11032 / timing['catalog_seconds'], 'text': 11032 / timing['text_seconds'], 'refresh_verify': 11032 / timing['verification_seconds']}
        for phase in ['current','historical']:
            seconds = result['bibliography']['totals'][phase + '_slice']['seconds']
            result['phase_rates'][phase] = 11032 / seconds
    (root / 'integration-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'scenario': timing['scenario'], 'seconds': timing['seconds'], 'catalog_sql': result['catalog_sql_calls']}))


for argument in sys.argv[1:]:
    summarize(argument)
