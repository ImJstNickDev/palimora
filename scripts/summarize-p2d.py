#!/usr/bin/env python3
"""Aggregate the shared P2C probes, separating HTTP and projection processes."""
import importlib.util,json,pathlib,sys,statistics,collections
spec=importlib.util.spec_from_file_location('p2c',pathlib.Path(__file__).with_name('summarize-p2c.py'))
p2c=importlib.util.module_from_spec(spec);spec.loader.exec_module(p2c)
MIB=1048576
def percentile(values,p):
 return sorted(values)[min(len(values)-1,int((len(values)-1)*p))] if values else None
def windows(root,label,start,end):
 rows=p2c.lines(root/(label+'-p2d-events.jsonl'))
 selected=[r for r in rows if r['kind']=='process' and start<=r['end']<=end]
 loop=[r for r in p2c.lines(root/(label+'-p2c-events.jsonl')) if r['kind']=='event_loop' and r.get('samples',0)>0 and start<=r['end']<=end]
 result={}
 if selected:
  cpu=sum(r['cpu_us'] for r in selected)/1e6;duration=sum(r['end']-r['start'] for r in selected)/1000
  result['process']={'sample_seconds':duration,'cpu_seconds':cpu,'cpu_mean_percent':100*cpu/duration,'cpu_max_percent':max(r['cpu_us']/(r['end']-r['start'])/10 for r in selected if r['end']>r['start']),'rss_mean_mib':statistics.mean(r['rss_bytes'] for r in selected)/MIB,'rss_peak_mib':max(r['rss_bytes'] for r in selected)/MIB,'lifetime_rss_peak_mib':max(r['max_rss_bytes'] for r in selected)/MIB,'heap_peak_mib':max(r['heap_bytes'] for r in selected)/MIB,'sql_calls':sum(r['sql_calls'] for r in selected),'sql_seconds':sum(r['sql_ms'] for r in selected)/1000,'sql_max_ms':max(r['sql_max_ms'] for r in selected),'pool_acquisitions':sum(r['pool_calls'] for r in selected),'pool_wait_seconds':sum(r['pool_ms'] for r in selected)/1000}
 if loop:
  result['event_loop']={'bins':len(loop),'samples':sum(r['samples'] for r in loop),'weighted_mean_ms':sum(r['mean_ms']*r['samples'] for r in loop)/sum(r['samples'] for r in loop),'median_bin_p95_ms':statistics.median(r['p95_ms'] for r in loop),'max_bin_p95_ms':max(r['p95_ms'] for r in loop),'max_ms':max(r['max_ms'] for r in loop)}
 result['http']={}
 for kind in ['search','bulk']:
  req=[r for r in rows if r['kind']=='http' and r['operation']==kind and start<=r['start'] and r['end']<=end]
  times=[r['ms'] for r in req]
  if times:result['http'][kind]={'calls':len(times),'mean_ms':statistics.mean(times),'p50_ms':percentile(times,.5),'p95_ms':percentile(times,.95),'max_ms':max(times),'total_seconds':sum(times)/1000,'errors':sum(r['status'] is None or r['status']>=400 for r in req)}
 return result

def waits(root,start,end):
 samples=[r for r in p2c.lines(root/'postgres-activity.jsonl') if start<=r['time']<=end]
 counter=collections.Counter();peaks=collections.Counter();blocked=0;oldest=0
 for sample in samples:
  for r in sample.get('rows',[]):
   key=' / '.join(str(r[k]) for k in ['application_name','state','wait_event_type','wait_event'])
   counter[key]+=r['connections'];peaks[key]=max(peaks[key],r['connections']);blocked+=r['blocked'];oldest=max(oldest,r['oldest_active_seconds'] or 0)
 return {'samples':len(samples),'errors':sum(r.get('error',False) for r in samples),'connection_observations':dict(counter),'peak_connections_by_class':dict(peaks),'blocked_connection_observations':blocked,'oldest_active_seconds':oldest}

def run(directory):
 root=directory/'results';latency=(root/'latency-load.json').exists()
 if latency:
  report=p2c.latency(root)
  report['role_windows']={}
  a,b=report['load']['idle']['started_at'],report['load']['idle']['ended_at']
  report['idle_role_window']={'api':windows(root,'latency-api-profile',a,b),'projection':windows(root,'latency-projection-profile',a,b),'postgres':waits(root,a,b)}
  for state in ['idle','backlog']:
   report['role_windows'][state]={}
   for endpoint,w in report[state]['windows'].items():
    a,b=w['started_at'],w['ended_at']
    report['role_windows'][state][endpoint]={'api':windows(root,'latency-api-profile',a,b),'projection':windows(root,'latency-projection-profile',a,b),'postgres':waits(root,a,b)}
  events=p2c.lines(root/'latency-api-profile-p2c-events.jsonl');report['api_projection_calls']=sum(e['kind'] in ['current','historical','text'] for e in events)
 else:
  isolated=(root/'projection-profile.json').exists()
  report=p2c.campaign(root,'projection-profile' if isolated else 'api-profile',('api-profile',) if isolated else ())
  report['mode']='isolated' if isolated else 'inline'
  a,b=report['timing']['started_at_ms'],report['timing']['ended_at_ms']
  report['role_window']={k:windows(root,k+'-profile',a,b) for k in ['api','projection','worker']};report['postgres_activity']=waits(root,a,b)
  api=p2c.read(root,'api-profile.json')['totals'];report['api_projection_calls']={k:api.get(k,{}).get('calls',0) for k in ['projectCatalog','projectText']}
  if isolated:assert not any(report['api_projection_calls'].values())
  assert report['bulk']['claimed']==report['bulk']['acknowledged']==11032
 report['evidence_root']=str(directory);report['image_id']=(root/'image-id.txt').read_text().strip()
 (root/'p2d-summary.json').write_text(json.dumps(report,indent=2)+'\n')
 return report
if __name__=='__main__':print(json.dumps(run(pathlib.Path(sys.argv[1])),indent=2))
