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
                'statementsAfter', 'old_queue_sql_ms', 'old_prepare_ms']
    result = {k: v for k, v in r.items() if k not in excluded}
    result['sql_per_document'] = r['sql'] / r['count']
    result['transactions_including_ack_autocommit'] = r['transactions'] + r['bulk_requests']
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
    if not label.startswith('p2a'):
        assert r['equivalent'] is True, label
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


runs = [run(x) for x in ['p2a-16', 'sql-16', 'batch-16', 'batch-64', 'batch-128']]
baseline, sql, batch = runs[:3]
report = {
    'schema': 'palimora.performance-p2b1.v1',
    'status': 'P2B.1 complete; P2B.2 and P2C not started; P2 not complete',
    'scope': 'Full-text reindex, including durable claim/preparation/publication/ACK; no end-to-end ingest campaign',
    'end_to_end_after': None,
    'baseline_commit': 'ad6f91ff16d8f66aaa36fd70025fbd096414cfc6',
    'historical_p2a': {'fulltext_seconds': 276.305, 'documents_per_second': 39.927,
                       'preparation_seconds': 170.064, 'sql': 250240, 'bulk_requests': 690},
    'runtime': json.loads((root / 'environment.json').read_text()),
    'conditions': {
        'works': 11032, 'postgres': '17.6', 'opensearch': '2.19.4',
        'opensearch_heap_bytes': 1073741824, 'uv_threadpool_size': 8,
        'source': 'Cold copy of retained P2A PostgreSQL; original P1B.1d B canonical packs mounted read-only',
        'durability': {'fsync': True, 'synchronous_commit': 'on', 'full_page_writes': True},
        'network': 'Internal isolated Docker network; no published ports',
        'default_documents': 16, 'preparation_window_bytes': 16777216,
        'bulk_target_bytes': 8388608, 'maximum_document_bytes': 67108864,
        'execution': 'Sequential single worker; no persistent cache or advanced preparation parallelism',
    },
    'first_baseline_control': run('p2a-16-first'),
    'runs': runs,
    'ablation': {
        'sql_16_definition': 'Collective SQL, bounded acquisition and same transformer; native readMany forced to sequential singleton reads by benchmark instrumentation only',
        'collective_acquisition_prepare_seconds_saved': (baseline['stages']['prepare_ms'] - sql['stages']['prepare_ms']) / 1000,
        'pack_grouping_additional_prepare_seconds_saved': (sql['stages']['prepare_ms'] - batch['stages']['prepare_ms']) / 1000,
        'fulltext_seconds_saved_at_default': baseline['seconds'] - batch['seconds'],
        'preparation_seconds_saved_at_default': (baseline['stages']['prepare_ms'] - batch['stages']['prepare_ms']) / 1000,
    },
    'validation': {'p2a_protocol_unchanged_tests': json.loads((root / 'faults.json').read_text()),
                   'preparation_fixtures': json.loads((root / 'preparation-fixtures.json').read_text())},
    'limits': [
        'Shared host and uncontrolled caches/segment merges; sequential subsystem runs, not statistical guarantees or end-to-end acceleration. OpenSearch CPU rises in the final repeated runs; counters include background work and are not a causal attribution to the builder.',
        'Primary comparison uses repeated P2A and final batch16, both replacing populated documents. First P2A populated an empty index; its cgroup sampling began late.',
        'All final ablation/16/64/128 runs use final preparation code and unchanged durable P2A protocol. Default stays 16.',
        'Initial enqueue/index bootstrap and final refresh/verification are outside the timer for both versions; per-call index HEAD, claim, preparation, HTTP and ACK remain included.',
        'Full _source SHA256, IDs/generations/snapshots and five reference searches compared for every completed batch run, after timed refresh. Search checks compare total counts and first 100 IDs in explicit ID order.',
        'Preparation timing includes read-only repeatable-read transactions and pack reads. SQL count is client calls/round trips, including BEGIN/COMMIT; server count also includes observer queries.',
        'Preparation SQL/CPU instrumentation covers transaction callbacks; preparation stage telemetry also includes surrounding control work. HTTP wrapper ends at headers; stage HTTP includes response parsing. These overlap and must not be added.',
        'Pack bytes are logical file reads, including existing readMany range gaps and headers. They increase with grouping; /proc and cgroup physical I/O are reported separately.',
        'Decoded bytes are sum of native object sizes, not heap allocation. Deduplication is within bounded windows, never persistent; cross-window rereads remain possible.',
        '16MiB bounds ordinary metadata/manifest/raw-text groups and decoded read windows, not process RSS. One indivisible exceptional work/frame is isolated; native API decodes a whole frame. Reconstruction and JavaScript/string/NDJSON copies add memory; P2A 64MiB output limit remains explicit permanent failure.',
        'RSS describes the whole full-text process, not separate heap allocations for SQL, decompression or HTML extraction; preparation CPU is measured over its read transactions.',
        'RSS sampled at 100ms, cgroup CPU/RAM/I/O/network at one second; intervals omit boundary fractions. WAL includes background activity. Physical I/O depends on cache/checkpoints.',
        'Zero retries/errors in timed runs. Fault probes inject transport loss/overload around real writes; crash leases forced expired after SIGKILL. Synthetic fixtures use a separate schema, index and writable packs.',
        'No P2B.2, P2C, parser, canonical format, PackStore implementation, bibliography or production data changes.',
    ],
}
assert report['validation']['preparation_fixtures']['shared_note_occurrences_counted_in_reconstruction_budget'] is True
if (root / 'checks.json').exists():
    report['validation']['final_checks'] = json.loads((root / 'checks.json').read_text())
print(json.dumps(report, indent=2))
