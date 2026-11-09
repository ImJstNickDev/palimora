#!/usr/bin/env python3
"""Run the existing projection role in an isolated fixture's read-only PackStore."""
import json, pathlib, subprocess, sys, time
root=pathlib.Path(sys.argv[1]); action=sys.argv[2]
name=(root/'name').read_text().strip()
assert name.startswith('palimora-release-test-')
worker=name+'-worker'; projection=name+'-projection'
def run(*args, **kw):return subprocess.run(['docker',*args],check=True,text=True,**kw)
if action=='create':
 c=json.loads(run('inspect',worker,capture_output=True).stdout)[0]
 assert c['Config']['Labels']['palimora.test']=='true'
 env=dict(x.split('=',1) for x in c['Config']['Env'])
 env.update(PROJECTION_MODE='isolated',PGAPPNAME='palimora-projection',P0_PROFILE='/results/'+sys.argv[3]+'.json',NODE_OPTIONS='--require=/app/scripts/performance-p2d.cjs')
 args=['create','--name',projection,'--network',name,'--label','palimora.test=true','--init','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true','--stop-timeout','60']
 for m in c['Mounts']:
  if m['Destination'] not in ['/benchmark','/results','/app/scripts','/app/apps/api/migrations']:continue
  ro=m['Destination']!='/results'
  args+=['--mount',f"type=bind,source={m['Source']},destination={m['Destination']}"+(',readonly' if ro else '')]
 for k,v in env.items():args+=['-e',k+'='+v]
 run(*args,c['Config']['Image'],'node','apps/api/dist/projection-worker.js',stdout=subprocess.DEVNULL)
elif action=='start':
 run('start',projection,stdout=subprocess.DEVNULL)
 for _ in range(60):
  state=json.loads(run('inspect',projection,capture_output=True).stdout)[0]['State']
  if not state['Running']:raise RuntimeError('Projection process exited before readiness')
  logs=run('logs','--since',state['StartedAt'],projection,capture_output=True)
  if 'projection_worker_ready' in logs.stdout:break
  time.sleep(1)
 else:raise RuntimeError('Projection readiness timeout')
elif action=='stop':
 run('stop',projection,stdout=subprocess.DEVNULL)
 logs=run('logs',projection,capture_output=True)
 (root/'results/projection-container.log').write_text(logs.stdout+logs.stderr)
else:raise ValueError(action)
