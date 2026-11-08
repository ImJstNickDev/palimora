#!/usr/bin/env python3
import json,sys,collections,statistics,pathlib
root=pathlib.Path(sys.argv[1]);result={}
for path in root.glob('*-resources.jsonl'):
    groups=collections.defaultdict(list)
    for line in path.read_text().splitlines():
        r=json.loads(line);groups[r['container']].append(r)
    result[path.stem]={}
    for name,rows in groups.items():
        if len(rows)<2:continue
        a,b=rows[0],rows[-1];seconds=b['time']-a['time']
        def io_delta(op):return None if a['io'] is None or b['io'] is None else (sum(v['value'] for v in b['io'] if v['op'].lower()==op)-sum(v['value'] for v in a['io'] if v['op'].lower()==op))/1048576
        def net(row,key):return sum(v[key] for v in row['network'].values())
        cpu=(b['cpu_ns']-a['cpu_ns'])/1e9
        result[path.stem][name.rsplit('-',1)[-1]]={'samples':len(rows),'seconds':seconds,'cpu_seconds':cpu,'cpu_mean_percent':100*cpu/seconds,'cpu_max_percent':max(100*(y['cpu_ns']-x['cpu_ns'])/1e9/(y['time']-x['time']) for x,y in zip(rows,rows[1:]) if y['time']>x['time']),'working_mean_mib':statistics.mean(r['working_bytes'] for r in rows)/1048576,'working_max_mib':max(r['working_bytes'] for r in rows)/1048576,'memory_max_mib':max(r['memory_bytes'] for r in rows)/1048576,'read_mib':io_delta('read'),'write_mib':io_delta('write'),'rx_mib':(net(b,'rx_bytes')-net(a,'rx_bytes'))/1048576,'tx_mib':(net(b,'tx_bytes')-net(a,'tx_bytes'))/1048576}
(root/'resources-summary.json').write_text(json.dumps(result,indent=2))
