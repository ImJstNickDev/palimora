#!/usr/bin/env python3
"""Aggregate content-free P2C measurements; active times are never added as wall time."""
import collections, hashlib, json, pathlib, statistics, sys
N = 11032
MIB = 1048576

def read(root, name, default=None):
    p = root / name
    return json.loads(p.read_text()) if p.exists() else default

def lines(path):
    return [json.loads(s) for s in path.read_text().splitlines()] if path.exists() else []

def resources(rows):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r['container'].rsplit('-', 1)[-1]].append(r)
    result = {}
    for name, rs in groups.items():
        if len(rs) < 2: continue
        a, b = rs[0], rs[-1]; seconds = b['time']-a['time']
        cpu = (b['cpu_ns']-a['cpu_ns'])/1e9
        def io(op):
            if a['io'] is None or b['io'] is None: return None
            return sum(x['value'] for x in b['io'] if x['op'].lower()==op)-sum(x['value'] for x in a['io'] if x['op'].lower()==op)
        def net(key):
            return sum(x[key] for x in b['network'].values())-sum(x[key] for x in a['network'].values())
        result[name] = dict(seconds=seconds, cpu_seconds=cpu, cpu_mean_percent=100*cpu/seconds,
            cpu_max_percent=max(100*(y['cpu_ns']-x['cpu_ns'])/1e9/(y['time']-x['time']) for x,y in zip(rs,rs[1:]) if y['time']>x['time']),
            working_mean_mib=statistics.mean(r['working_bytes'] for r in rs)/MIB,
            working_peak_mib=max(r['working_bytes'] for r in rs)/MIB,
            memory_mean_mib=statistics.mean(r['memory_bytes'] for r in rs)/MIB,
            memory_peak_mib=max(r['memory_bytes'] for r in rs)/MIB,
            disk_read_bytes=io('read'), disk_write_bytes=io('write'), network_rx_bytes=net('rx_bytes'), network_tx_bytes=net('tx_bytes'))
    # One observation per container in each sampler cycle; sample times differ slightly.
    latest = {}; peak = 0
    for r in rows:
        latest[r['container']] = r['working_bytes']
        if len(latest)==len(groups): peak=max(peak,sum(latest.values()))
    return dict(containers=result, cpu_total_seconds=sum(r['cpu_seconds'] for r in result.values()), simultaneous_peak_working_mib=peak/MIB)

def intervals(events, kinds):
    points=[]
    for e in events:
        if e.get('kind') in kinds and e.get('rows',0)>0:
            points += [(e['start'], e['kind'], 1), (e['end'], e['kind'], -1)]
    state=collections.Counter(); durations=collections.Counter(); previous=0
    for t,k,delta in sorted(points):
        active=tuple(sorted(k for k,v in state.items() if v))
        if active: durations['+'.join(active)] += (t-previous)/1000
        state[k]+=delta;previous=t
    return dict(durations)

def campaign(root):
    result={'timing':read(root,'end-to-end.json'), 'verification':read(root,'verification.json'),
        'equivalence':read(root,'p2c-equivalence.json'), 'integration':read(root,'integration.json')}
    scenario=result['timing']['scenario']; label='api-profile' if scenario=='B' else 'projection-profile'
    profile=read(root,label+'.json')['totals']; bib=read(root,label+'-bibliography.json')
    events=lines(root/(label+'-p2c-events.jsonl'))
    text=[e for e in events if e['kind']=='bulk_pass']
    summed=['claimed','acknowledged','requests','bytes','http_ms','prepare_ms','claim_ms','ack_ms','failures','conflict_flushes','lease_renewals','lease_expired','lease_rejected','renewal_queries','cancelled','producer_wait_ms','consumer_idle_ms','queue_wait_ms','prepare_wall_ms','http_wall_ms','overlap_ms','groups','group_total_ms','publication_total_ms','wall_ms','preparation_inactive_wall_ms','http_inactive_wall_ms','exceptional_preparations']
    peaks=['queue_wait_max_ms','preparation_concurrency_max','http_concurrency_max','buffered_documents_max','ndjson_bytes_max','reserved_bytes_max','claimed_documents_max','group_max_ms','exceptional_input_bytes_max']
    result['bulk']={k:sum(e[k] for e in text) for k in summed}
    result['bulk'].update({k:max((e[k] for e in text),default=0) for k in peaks})
    result['bulk']['options']=text[0]['options']
    result['bulk']['overlap_percent']=100*result['bulk']['overlap_ms']/result['bulk']['wall_ms']
    result['preparation_inputs']=[e for e in events if e['kind']=='preparation_inputs']
    result['phases']={k:profile.get(k) for k in ['projectCatalog','projectText','plain','http.bulk','http.document','http.other']}
    result['bibliography_slices']={k:v for k,v in bib['totals'].items() if 'slice' in k}
    result['sql']={phase:{'queries':sum(v['calls'] for k,v in profile.items() if k.startswith(phase+'.sql.')), 'seconds':sum(v['ms'] for k,v in profile.items() if k.startswith(phase+'.sql.'))/1000} for phase in ['projectCatalog','projectText','other']}
    for phase, values in result['sql'].items():
        for command in ['BEGIN','COMMIT','ROLLBACK']:
            statement='BEGIN; SET LOCAL default_toast_compression=lz4' if command=='BEGIN' else command
            key=phase+'.sql.'+hashlib.sha256(statement.encode()).hexdigest()[:16]
            values[command.lower()]=profile.get(key,{}).get('calls',0)
    result['full_text_documents_per_active_second']=N/(profile['projectText']['ms']/1000)
    worker=read(root,'worker-profile.json')
    result['client_queries_api_and_worker']=sum(v['calls'] for k,v in profile.items() if '.sql.' in k)+(sum(v['calls'] for k,v in worker['totals'].items() if '.sql.' in k) if worker else 0)
    result['profile_process_cpu_seconds']={label:sum(read(root,label+'.json')['cpu'].values())/1e6}
    if worker: result['profile_process_cpu_seconds']['worker-profile']=sum(worker['cpu'].values())/1e6
    all_events=events+lines(root/'worker-profile-p2c-events.jsonl')
    result['productive_stage_overlap_seconds']=intervals(all_events, {'current','historical','text','canonical_commit'})
    result['productive_stage_spans']={}
    origin=result['timing'].get('started_at_ms',min(e['start'] for e in all_events if 'start' in e))
    for kind in ['current','historical','text','canonical_commit']:
        es=[e for e in all_events if e['kind']==kind and e.get('rows',0)>0]
        if es: result['productive_stage_spans'][kind]={'start_seconds':(min(e['start'] for e in es)-origin)/1000,'end_seconds':(max(e['end'] for e in es)-origin)/1000,'rows':sum(e['rows'] for e in es)}
    before=read(root,'before.json');after=read(root,'after.json' if scenario=='B' else 'after-projection.json')
    result['postgres']={'wal_bytes':int(after['wal'][0]['wal_bytes'])-int(before['wal'][0]['wal_bytes']),
        'database_deltas':{k:float(v)-float(before['database'][0][k]) for k,v in after['database'][0].items()},
        'queue_departures':after['queue_departures'],'settings':after['settings']}
    settings=next(iter(after.get('search_settings',{}).values()),{})
    effective={**settings.get('defaults',{}),**settings.get('settings',{})}
    result['postgres']['search_settings']={k:effective.get(k) for k in ['index.number_of_shards','index.number_of_replicas','index.refresh_interval','index.translog.durability','index.translog.flush_threshold_size']}
    result['search_index_stats']={k:after.get('search',{}).get('_all',{}).get('primaries',{}).get(k) for k in ['docs','indexing','refresh','flush','merges','store']}
    result['postgres']['server_sql_calls']=sum(int(r['calls']) for r in after['queries'])-sum(int(r['calls']) for r in before['queries'])
    resource_rows=[]
    for name in (['operational-resources.jsonl'] if scenario=='B' else ['ingest-default-resources.jsonl','projection-resources.jsonl']):resource_rows+=lines(root/name)
    result['resources']=resources(resource_rows)
    result['resources']['scope']='Container samples around operational runner including API/worker startup and shutdown' if scenario=='B' else 'Ingest/projection sample envelope; verification API not sampled'
    os=lines(root/'opensearch-samples.jsonl');os=[r for r in os if 'nodes' in r]
    if len(os)>1:
        first,last=os[0]['nodes'][0],os[-1]['nodes'][0]
        result['opensearch']={'sample_seconds':(os[-1]['time']-os[0]['time'])/1000,
          'indices_deltas':{group:{k:v-first['indices'][group].get(k,0) for k,v in last['indices'][group].items() if isinstance(v,(float,int))} for group in ['indexing','refresh','flush','merges']},
          'heap_peak_mib':max(r['nodes'][0]['jvm']['mem']['heap_used_in_bytes'] for r in os)/MIB,
          'write_rejected':last['thread_pool']['write']['rejected']-first['thread_pool']['write']['rejected']}
    samples=lines(root/'processes.jsonl')
    if samples:
        previous={};cpu=collections.Counter();rss=collections.defaultdict(list)
        for s in samples:
            sums=collections.Counter()
            for r in s['processes']:
                sums[r['kind']]+=r['rss_bytes'];cpu[r['kind']]+=max(0,r['cpu_seconds']-previous.get(r['pid'],r['cpu_seconds']));previous[r['pid']]=r['cpu_seconds']
            for kind in ['api','ingest','python']:rss[kind].append(sums[kind]/MIB)
        result['processes']={k:dict(cpu_seconds_lower_bound=cpu[k],rss_mean_mib=statistics.mean(v),rss_peak_mib=max(v)) for k,v in rss.items()}
    timeline=read(root,'timeline.json')
    if timeline:
        last=timeline[-1]
        ingest_event={'kind':'ingest','start':float(last['processing_started_at_ms']),'end':float(last['processing_finished_at_ms']),'rows':N}
        result['ingest_wall_and_projection_overlap_seconds']=intervals(events+[ingest_event], {'ingest','current','historical','text'})
        result['queues']={k:dict(peak=max(r[k] for r in timeline),residence_seconds_per_input_work_including_service=sum((a[k]+b[k])/2*(b['seconds']-a['seconds']) for a,b in zip(timeline,timeline[1:]))/N) for k in ['catalog','historical','text']}
        start=result['timing']['started_at_ms']/1000;end=result['timing']['ended_at_ms']/1000
        result['timer_window_resources']=resources([r for r in resource_rows if start<=r['time']<=end])
    return result

def latency(root):
    load=read(root,'latency-load.json');rows=lines(root/'latency-resources.jsonl')
    result={k:read(root,f'http-{k}.json') for k in ['idle','backlog']};result['load']=load
    a,b=load['idle']['started_at']/1000,load['idle']['ended_at']/1000
    result['empty_queue_resources']=resources([r for r in rows if a<=r['time']<=b])
    events=lines(root/'latency-api-profile-p2c-events.jsonl')
    result['empty_queue_calls']=dict(collections.Counter(e['kind'] for e in events if e.get('start',0)>=a*1000 and e.get('end',0)<=b*1000))
    def drained(before, after, current):
        c=before[current]-after[current]
        return {'current':c,'historical':before['historical']-after['historical'],
            'text':before['text']+c-after['text']}
    result['drained_during_probe']=drained(load['before'],load['after'],'catalog')
    result['endpoint_drained']={k:drained(v['before'],v['after'],'current') for k,v in result['backlog']['windows'].items()}
    result['endpoint_resources']={k:resources([r for r in rows if v['started_at']/1000<=r['time']<=v['ended_at']/1000]) for k,v in result['backlog']['windows'].items()}
    if any(e['kind']=='event_loop' for e in events):
        result['event_loop_windows']={}
        for state in ['idle','backlog']:
            result['event_loop_windows'][state]={}
            for k,w in result[state]['windows'].items():
                es=[e for e in events if e['kind']=='event_loop' and e.get('samples',0)>0 and w['started_at']<=e['end']<=w['ended_at']]
                if es: result['event_loop_windows'][state][k]={'seconds':len(es),'max_ms':max(e['max_ms'] for e in es), 'mean_ms':sum(e['mean_ms']*e['samples'] for e in es)/sum(e['samples'] for e in es),'html_ms':sum(e['html_ms'] for e in es),'html_max_ms':max(e['html_max_ms'] for e in es),'encoding_ms':sum(e['encoding_ms'] for e in es),'encoding_max_ms':max((e['encoding_max_ms'] for e in es if 'encoding_max_ms' in e),default=None)}
    result['resources']=read(root,'resources-summary.json')
    return result

if __name__=='__main__':
    root=pathlib.Path(sys.argv[1])/'results'
    result=latency(root) if (root/'latency-load.json').exists() else campaign(root)
    (root/'p2c-summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
