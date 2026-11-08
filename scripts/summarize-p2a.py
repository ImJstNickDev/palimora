#!/usr/bin/env python3
"""Publish aggregates only; private source documents and node metadata stay local."""
import json, pathlib, sys, statistics
root=pathlib.Path(sys.argv[1])
resources=[json.loads(x) for x in (root/'resources.jsonl').read_text().splitlines()]
def total_io(row):
    values={}
    for item in row.get('io',[]): values[item['op']]=values.get(item['op'],0)+item['value']
    return values

def run(label):
    r=json.loads((root/(label+'.json')).read_text())
    result={k:v for k,v in r.items() if k not in ['osBefore','osAfter','ioBefore','ioAfter','statementsBefore','statementsAfter']}
    if 'osBefore' in r:
        result['opensearch_cpu_seconds']=sum(n['process']['cpu']['total_in_millis'] for n in r['osAfter']['nodes'].values())/1000-sum(n['process']['cpu']['total_in_millis'] for n in r['osBefore']['nodes'].values())/1000
        result['server_sql_calls']=float(r['statementsAfter']['calls'])-float(r['statementsBefore']['calls'])
        result['server_sql_ms']=float(r['statementsAfter']['ms'])-float(r['statementsBefore']['ms'])
        def parse_io(text):return {k:int(v) for k,v in (line.split(':') for line in text.splitlines())}
        a,b=parse_io(r['ioBefore']),parse_io(r['ioAfter'])
        result['node_io']={k:b[k]-a[k] for k in a}
    result['transactions_including_ack_autocommit']=r['transactions']+r.get('bulk_requests',0)
    result['containers']={}
    for name in sorted(set(x['container'] for x in resources)):
        rows=[x for x in resources if x['container']==name and r.get('started_at',0)<=x['time']*1000<=r.get('ended_at',0)]
        if len(rows)<2:continue
        a,b=rows[0],rows[-1];ia,ib=total_io(a),total_io(b)
        result['containers'][name.rsplit('-',1)[-1]]={'sampled_seconds':b['time']-a['time'],'cpu_seconds':(b['cpu_ns']-a['cpu_ns'])/1e9,'ram_mean':statistics.mean(x['memory_bytes'] for x in rows),'ram_max':max(x['memory_bytes'] for x in rows),'working_mean':statistics.mean(x['working_bytes'] for x in rows),'io_bytes':{k:ib.get(k,0)-ia.get(k,0) for k in ib}}
    if label.startswith('bulk'):
        batches=[]
        for line in (root/(label+'.log')).read_text().splitlines():
            try:v=json.loads(line)
            except ValueError:continue
            if v.get('event')=='text_bulk':batches.append(v)
        result['stages']={k:sum(x[k] for x in batches) for k in ['claimed','acknowledged','requests','bytes','http_ms','prepare_ms','claim_ms','ack_ms','failures']}
    return result
report={'schema':'palimora.performance-p2a.v1','status':'P2A complete; P2B and P2C not started','scope':'Full-text reindex of unchanged documents; no ingest or P2C end-to-end campaign','end_to_end_after':None,'durability':{'fsync':True,'synchronous_commit':'on','full_page_writes':True},'baseline_commit':'16a018bef7a8ec777ac7ab2c66abc5938b141020','baseline_search_js_sha256':'0f49f6843c709add3969ceb559590b1a0b830694315cca50e17a094b4c562890','corpus':{'works':11032,'source':'Retained P1B.1d B cold PostgreSQL copy; unchanged canonical PackStore mounted read-only'},'historical_baseline':{'fulltext_seconds':411.849,'end_to_end_seconds':434.043,'end_to_end_documents_per_second':25.417,'put_requests':11032,'put_seconds':163.287,'residual_seconds':248.562},'first_legacy_control':run('old-16-first'),'runs':[run(x) for x in ['old-16','bulk-16','bulk-64','bulk-128']],'validation':json.loads((root/'faults.json').read_text()),'limits':['Shared host, uncontrolled caches, sequential subsystem runs; no end-to-end acceleration claim.','Direct projectText engine timing includes durable claims, preparation, publication and ACK; scheduler operational wrappers are tested separately.','64/128 runs precede the final conflict-only flush barrier; all timed requests succeeded without conflicts. Final16 was rerun on the final engine.','RSS is sampled every 100ms and container resources every second. Server SQL aggregates include observer queries; client SQL counts are isolated application calls.','First legacy run populates the empty index. Subsequent runs replace existing documents; matched legacy repeat and final bulk16 use this same condition.','Transient overload and lost-response probes inject transport faults around real OpenSearch operations; they do not claim a measured server overload threshold.','Default remains 16 documents; no default tuning based on these measurements.','Cgroup CPU and I/O cover first-to-last samples (about one second less than each stage). WAL includes background activity.','Preparation retains per-document SQL/PackStore reads. New preparation includes its read transaction; legacy timing starts after dequeue and ends before PUT. Neither is pure CPU.','Transactions include instrumented BEGIN plus one autocommit ACK per confirmed bulk; all timed runs have zero retries.','Lease crash probes force expiry in SQL after SIGKILL rather than waiting five minutes.','No P2B, P2C, P3, P4 or P5 work.']}
if (root/'retry-durability.json').exists(): report['validation']['retry_durability']=json.loads((root/'retry-durability.json').read_text())
if (root/'checks.json').exists(): report['validation'].update(json.loads((root/'checks.json').read_text()))
print(json.dumps(report,indent=2))
