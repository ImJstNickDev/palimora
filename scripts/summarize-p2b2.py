#!/usr/bin/env python3
"""Aggregate isolated full-text measurements without publishing corpus contents."""
import json
import pathlib
import statistics
import sys

root = pathlib.Path(sys.argv[1])
resources = [json.loads(x) for x in (root / 'resources.jsonl').read_text().splitlines()]


def io(row):
    result = {}
    for item in row.get('io') or []:
        result[item['op']] = result.get(item['op'], 0) + item['value']
    return result


def network(row):
    return {k: sum(n.get(k, 0) for n in row.get('network', {}).values())
            for k in ['rx_bytes', 'tx_bytes']}


def run(label):
    r = json.loads((root / (label + '.json')).read_text())
    excluded = ['osBefore', 'osAfter', 'ioBefore', 'ioAfter', 'statementsBefore',
                'statementsAfter', 'databaseBefore', 'databaseAfter', 'payloads']
    result = {k: v for k, v in r.items() if k not in excluded}
    result['sql_per_document'] = r['sql'] / r['count']
    result['transactions_including_ack_and_renewal'] = r['transactions'] + r['ack_queries'] + r['renewal_queries']
    result['opensearch_cpu_seconds'] = (
        sum(n['process']['cpu']['total_in_millis'] for n in r['osAfter']['nodes'].values())
        - sum(n['process']['cpu']['total_in_millis'] for n in r['osBefore']['nodes'].values())) / 1000
    result['server_sql_calls'] = float(r['statementsAfter']['calls']) - float(r['statementsBefore']['calls'])
    result['server_sql_ms'] = float(r['statementsAfter']['ms']) - float(r['statementsBefore']['ms'])
    a, b = [{k: int(v) for k, v in (line.split(':') for line in r[key].splitlines())}
            for key in ['ioBefore', 'ioAfter']]
    result['node_io'] = {k: b[k] - a[k] for k in a}
    batches = []
    for line in (root / (label + '.log')).read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('event') == 'text_bulk':
            batches.append(event)
    result['stages'] = {k: sum(x[k] for x in batches) for k in [
        'claimed', 'acknowledged', 'requests', 'bytes', 'http_ms', 'prepare_ms',
        'claim_ms', 'ack_ms', 'failures', 'conflict_flushes']}
    assert result['stages']['acknowledged'] == r['count'] == 11032, label
    assert result['stages']['failures'] == 0, label
    assert result['stages']['requests'] == r['bulk_requests'], label
    if not label.startswith('legacy'):
        assert r['equivalent'] is True, label
    if batches and 'overlap_ms' in batches[0]:
        sums = ['producer_wait_ms', 'consumer_idle_ms', 'queue_wait_ms',
                'prepare_wall_ms', 'http_wall_ms', 'overlap_ms', 'groups',
                'group_total_ms', 'publication_total_ms', 'wall_ms',
                'lease_renewals', 'lease_expired', 'lease_rejected', 'renewal_queries',
                'cancelled', 'exceptional_preparations', 'preparation_inactive_wall_ms',
                'http_inactive_wall_ms']
        maxima = ['queue_wait_max_ms', 'preparation_concurrency_max', 'http_concurrency_max',
                  'buffered_documents_max', 'ndjson_bytes_max', 'reserved_bytes_max',
                  'claimed_documents_max', 'exceptional_input_bytes_max', 'group_max_ms']
        result['pipeline_metrics'] = {k: sum(x[k] for x in batches) for k in sums}
        result['pipeline_metrics'].update({k: max(x[k] for x in batches) for k in maxima})
        result['pipeline_metrics']['overlap_percent_of_wall'] = result['pipeline_metrics']['overlap_ms'] / (10*r['seconds'])
        result['pipeline_metrics']['group_mean_ms'] = result['pipeline_metrics']['group_total_ms'] / result['pipeline_metrics']['groups']
    result['database_counters'] = {k: float(r['databaseAfter'][k])-float(v) for k,v in r['databaseBefore'].items()}
    sizes = sorted(r['payloads'])
    result['payload_bytes'] = {'min': sizes[0], 'mean': statistics.mean(sizes), 'p95': sizes[int(.95*(len(sizes)-1))], 'max': sizes[-1]}
    result['opensearch_indices'] = {}
    for group in ['indexing', 'refresh', 'merges', 'flush']:
        before = next(iter(r['osBefore']['nodes'].values()))['indices'][group]
        after = next(iter(r['osAfter']['nodes'].values()))['indices'][group]
        result['opensearch_indices'][group] = {k: {'before': v, 'after': after[k], 'delta': after[k]-v}
            for k,v in before.items() if isinstance(v, (int,float)) and not isinstance(v,bool)}
    result['effective_options'] = batches[0].get('options') if batches else None
    result['preparation_documents_per_second'] = r['count'] * 1000 / result['stages']['prepare_ms']
    result['containers'] = {}
    for name in sorted({x['container'] for x in resources}):
        rows = [x for x in resources if x['container'] == name
                and r['started_at'] <= x['time'] * 1000 <= r['ended_at']]
        if len(rows) < 2:
            continue
        a, b = rows[0], rows[-1]
        ia, ib, na, nb = io(a), io(b), network(a), network(b)
        role = name.rsplit('-', 1)[-1]
        role = {'p2a': 'baseline', 'old': 'baseline', 'batch': 'worker'}.get(role, role)
        result['containers'][role] = {
            'sampled_seconds': b['time'] - a['time'],
            'cpu_seconds': (b['cpu_ns'] - a['cpu_ns']) / 1e9,
            'ram_mean': statistics.mean(x['memory_bytes'] for x in rows),
            'ram_max': max(x['memory_bytes'] for x in rows),
            'working_mean': statistics.mean(x['working_bytes'] for x in rows),
            'working_max': max(x['working_bytes'] for x in rows),
            'io_bytes': {k: ib.get(k, 0) - ia.get(k, 0) for k in set(ia) | set(ib)},
            'network_bytes': {k: nb[k] - na[k] for k in na},
        }
    return result


labels = ['legacy-16', 'serial-16', 'p11-16', 'p21-16', 'p12-16', 'p11-64', 'p12-64',
          'legacy-16-repeat', 'p11-16-repeat', 'p12-16-repeat', 'p12-64-repeat']
report = {
    'schema': 'palimora.performance-p2b2.v1',
    'scope': 'Full-text only, durable claim through ACK; no end-to-end ingest campaign',
    'baseline_commit': '641755db939b629ddef39a311dcca9ab445e89ec',
    'historical_p2b1': {'fulltext_seconds':154.593,'documents_per_second':71.362,
                       'prepare_seconds':55.715,'http_seconds':84.427,'bulk_requests':690},
    'runs': [run(label) for label in labels],
    'validation': {}
}
for name in ['faults', 'preparation-fixtures', 'concurrency-fixtures', 'checks', 'environment', 'final-equivalence']:
    path = root / (name+'.json')
    if path.exists(): report['validation'][name] = json.loads(path.read_text())
fixture_log = root / 'preparation-fixtures.log'
if fixture_log.exists():
    events = []
    for line in fixture_log.read_text().splitlines():
        try: event = json.loads(line)
        except ValueError: continue
        if event.get('event') == 'text_bulk':
            events.append({k:event[k] for k in ['claimed','acknowledged','failures','exceptional_preparations',
                'exceptional_input_bytes_max','reserved_bytes_max']})
    report['validation']['exceptional_preparation_runtime'] = events
report['conditions'] = {
    'works': 11032, 'postgres': '17.6', 'opensearch': '2.19.4',
    'opensearch_heap_bytes': 1073741824, 'uv_threadpool_size': 8,
    'source': 'Cold P2B.1 PostgreSQL fixture; original P1B.1d B canonical packs mounted read-only',
    'opensearch_initial_state': 'Same cold physical populated-index checkpoint restored before every reported run; fresh JVM',
    'postgres_initial_state': 'Running warm isolated database; revisions advance; checkpoints and filesystem caches uncontrolled',
    'docker_resource_caps': None, 'host': 'Shared; no other services modified',
    'durability': {'fsync': True, 'synchronous_commit': 'on', 'full_page_writes': True},
    'network': 'Internal Docker network, no published ports',
    'timer': 'Complete projectText loop, durable claim through ACK, including internal checks; excludes initial enqueue/bootstrap and final refresh/equivalence checks',
    'default': {'batch':16, 'prepare_lanes':1, 'publish_lanes':1, 'groups':8, 'documents':256,
                'ndjson_mib':384, 'memory_mib':448, 'renew_ms':60000},
    'ordinary_preparation_window_bytes':16777216, 'maximum_document_bytes':67108864,
    'bulk_target_bytes':8388608,
    'repeat_policy': 'Baseline, default and both two-publisher profiles repeated once; no batch128 or end-to-end campaign',
}
report['limits'] = [
    'Full-text measurements only. Historical P2B.1 timings used different segment/cache state; primary comparison uses contemporaneous repeated controls.',
    'Same starting OpenSearch segments and fresh JVM control one confounder. Filesystem caches, PostgreSQL checkpoints, JIT/merge timing and shared-host contention still vary; no causal or statistical guarantee.',
    'CPU/RSS are for the full process, not isolated per-lane allocations. Summing overlapping phase CPU or SQL deltas would double count, so only full-process counters are used.',
    'Phase cumulative times, phase unions and actual preparation/HTTP intersection are separate. Queue/producer/consumer waits sum across lanes and are not additive wall-clock components.',
    'ndjson_bytes_max counts encoded bytes and encoded-equivalent temporary publication copies; reserved_bytes_max conservatively reserves five times actual NDJSON plus preparation permits. Neither is total RSS.',
    'Large indivisible native objects/works execute exclusively and can exceed the ordinary preparation budget. No format/codec change or truncation; output above64MiB remains a durable explicit error.',
    'Client SQL calls include BEGIN/COMMIT and control queries. transactions_including_ack_and_renewal counts explicit transactions plus ACK and renewal writes; database counters also include autocommit reads, observers and delayed statistics.',
    'Node RSS sampled100ms; cgroup CPU/RAM/working-set/I/O/network sampled1s, excluding boundary fractions. Node proc I/O and cgroup physical I/O differ from logical PackStore bytes. WAL includes background work.',
    'OpenSearch CPU includes background refresh/merge/flush. Their counters/gauges are reported before/after/delta; durations may overlap.',
    'Search equivalence compares totals and first100 IDs in explicit ID order for five reference queries; complete_source verification covers every field of every document.',
    'P2A unchanged fault suite uses groups1 to preserve its global no-SQL-transaction-during-HTTP assertion. Concurrency suite verifies each document own preparation COMMIT plus independent read-only snapshots.',
    'Fault injections surround real PostgreSQL/OpenSearch operations. SIGKILL recovery timings force lease expiry and exclude the normal five-minute expiration wait.',
    'No production changes, original dump writes, ingest, parser/PackStore/bibliography changes, persistent text caches or P2C work.',
]
report['repetitions'] = {}
for profile in ['legacy-16','p11-16','p12-16','p12-64']:
    samples = [r for r in report['runs'] if r['label'] in [profile,profile+'-repeat']]
    seconds = [r['seconds'] for r in samples]
    report['repetitions'][profile] = {'seconds': seconds, 'mean_seconds': statistics.mean(seconds),
                                    'min_seconds':min(seconds),'max_seconds':max(seconds),
                                    'documents_per_second_at_mean':11032/statistics.mean(seconds)}
report['comparison'] = {}
base = report['repetitions']['legacy-16']['mean_seconds']
serial = next(r['seconds'] for r in report['runs'] if r['label']=='serial-16')
for profile in ['p11-16','p12-16','p12-64']:
    seconds=report['repetitions'][profile]['mean_seconds']
    report['comparison'][profile] = {'seconds_saved_vs_repeated_p2b1_mean':base-seconds,
                                   'wall_reduction_percent_vs_repeated_p2b1_mean':100*(1-seconds/base)}
report['comparison']['serial_control_seconds']=serial
report['comparison']['default_seconds_saved_vs_serial_control']=serial-report['repetitions']['p11-16']['mean_seconds']
report['paired_comparisons'] = []
by_label = {r['label']: r for r in report['runs']}
for suffix in ['', '-repeat']:
    before = by_label['legacy-16'+suffix]
    after = by_label['p11-16'+suffix]
    tuned = by_label['p12-64'+suffix]
    report['paired_comparisons'].append({
        'series': 'first' if not suffix else 'repeat',
        'p2b1_seconds': before['seconds'], 'default_seconds': after['seconds'],
        'default_reduction_percent': 100*(1-after['seconds']/before['seconds']),
        'batch64_two_publishers_seconds': tuned['seconds'],
        'batch64_two_publishers_reduction_percent':100*(1-tuned['seconds']/before['seconds']),
        'attribution': 'Observed subsystem comparison; batch64 combines grouping and concurrency. Host/cache/background variability remains.'
    })
report['recommendation'] = {
    'normal_runtime': 'Keep batch16 and one preparation/one publisher, with overlap; conservative default pending mixed workload measurements outside this phase',
    'isolated_reindex': 'Opt-in batch64, one preparation/two publishers; repeated full-corpus profile, same configured memory/document bounds',
    'not_selected': 'Second preparation lane has only a small single-sample benefit at16; no recommendation to increase it. No128 or more than2 lanes tested.'
}
report['bottleneck'] = {}
for label in ['p11-16-repeat','p12-64-repeat']:
    r=by_label[label]
    report['bottleneck'][label]={
        'http_union_percent_of_wall':100*r['pipeline_metrics']['http_wall_ms']/(r['seconds']*1000),
        'preparation_union_percent_of_wall':100*r['pipeline_metrics']['prepare_wall_ms']/(r['seconds']*1000),
        'interpretation': 'Publication remains on the dominant path; client HTTP includes response handling and overlaps preparation. These counters do not prove absolute OpenSearch hardware saturation.'
    }
report['status'] = ('P2B.2 complete; P2C not started; P2 not complete'
                    if all(k in report['validation'] for k in ['faults','preparation-fixtures','concurrency-fixtures','checks','final-equivalence'])
                    else 'Benchmarks measured; separate correctness reports not all present')
print(json.dumps(report, indent=2))
