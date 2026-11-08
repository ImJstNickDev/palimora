#!/usr/bin/env python3
"""Print aggregate P0 results. No work IDs, SQL text, or archived content."""
import collections, json, pathlib, statistics, sys
for argument in sys.argv[1:]:
    root = pathlib.Path(argument) / 'results'
    result = {'root': str(root)}
    def read(name):
        path = root / name
        return json.loads(path.read_text()) if path.exists() else None
    result['end_to_end'] = read('end-to-end.json')
    result['profiles'] = {}
    for path in sorted(root.glob('p0-*.json')) + sorted(root.glob('overhead-*.json')):
        d = json.loads(path.read_text())
        if 'engine_seconds' in d:
            result['profiles'][path.stem] = {'seconds': d['engine_seconds'], 'works_s': d['works_per_second'], 'works': d['counts']['works']}
    for filename in ['projection-profile.json', 'api-profile.json', 'worker-profile.json']:
        d = read(filename)
        if not d:
            continue
        totals = d['totals']
        result[filename] = {k: v for k, v in totals.items() if '.sql.' not in k and not k.startswith('sql.')}
        sql = [v for k, v in totals.items() if '.sql.' in k or k.startswith('sql.')]
        result[filename]['sql'] = {'calls': sum(v['calls'] for v in sql), 'seconds': sum(v['ms'] for v in sql)/1000}
        for phase in ['projectCatalog', 'projectText']:
            q = [v for k,v in totals.items() if k.startswith(phase+'.sql.')]
            result[filename][phase+'_sql'] = {'calls': sum(v['calls'] for v in q), 'seconds':sum(v['ms'] for v in q)/1000}
    result['resources'] = read('resources-summary.json')
    timeline = read('timeline.json')
    if timeline:
        result['queue_residence_seconds_per_input_work_including_service'] = {
            k: sum((a[k]+b[k])/2*(b['seconds']-a['seconds']) for a,b in zip(timeline,timeline[1:]))/11032
            for k in ['catalog', 'historical', 'text']}
        snapshot = read('after.json')
        profile = read('api-profile.json')
        if snapshot and profile:
            departures = {r['queue']: int(r['departures']) for r in snapshot['queue_departures']}
            sampling_error = 2*max(b['seconds']-a['seconds'] for a,b in zip(timeline,timeline[1:]))
            result['queue_wait_bounds_seconds_per_visit'] = {}
            for k in ['catalog','historical','text']:
                residence = result['queue_residence_seconds_per_input_work_including_service'][k]*11032/departures[k]
                service_bound = profile['totals']['projectText' if k=='text' else 'projectCatalog']['max_ms']/1000
                result['queue_wait_bounds_seconds_per_visit'][k] = {'departures': departures[k], 'residence':residence, 'sampling_bound':sampling_error, 'service_bound':service_bound, 'wait_lower':max(0,residence-service_bound-sampling_error),'wait_upper':residence+sampling_error}
        result['queue_max'] = {k: max(r[k] for r in timeline) for k in ['catalog','historical','text']}
    path = root/'processes.jsonl'
    if path.exists():
        samples = [json.loads(line) for line in path.read_text().splitlines()]
        previous = {}; cpu = collections.Counter(); rss = collections.defaultdict(list)
        for sample in samples:
            sums = collections.Counter()
            for row in sample['processes']:
                pid = row['pid']; kind = row['kind']; sums[kind] += row['rss_bytes']
                cpu[kind] += max(0,row['cpu_seconds']-previous.get(pid,row['cpu_seconds']))
                previous[pid] = row['cpu_seconds']
            for kind in ['api','ingest','python']:
                rss[kind].append(sums[kind]/1048576)
        seconds = samples[-1]['time']-samples[0]['time']
        result['processes'] = {k: {'cpu_seconds_lower_bound':cpu[k], 'cpu_mean_percent_lower_bound':100*cpu[k]/seconds, 'rss_mean_mib':statistics.mean(v),'rss_max_mib':max(v)} for k,v in rss.items()}
    (root/'p0-summary.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
