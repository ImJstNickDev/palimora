#!/usr/bin/env python3
"""Run the bounded P5 heterogeneous portion on owned disposable containers."""
import json,pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]);assert 'storage-overhaul' in str(root)
name=(root/'name').read_text().strip();assert name.startswith('palimora-release-test-')
def docker(*args,**kwargs):return subprocess.run(['docker',*args],check=True,text=True,**kwargs)
for role in ['worker','pg','search','redis','projection']:
 c=json.loads(docker('inspect',name+'-'+role,capture_output=True).stdout)[0];assert c['Config']['Labels'].get('palimora.test')=='true'
results=root/'results';collect_only='--collect-only' in sys.argv;log=(results/('collection.log' if collect_only else 'campaign.log')).open('w');last=0
for _ in range(90):
 ready=subprocess.run(['docker','exec',name+'-search','curl','-fsS','localhost:9200/_cluster/health?wait_for_status=green&timeout=1s'],capture_output=True)
 if ready.returncode==0 and not json.loads(ready.stdout)['timed_out']:break
 time.sleep(1)
else:raise RuntimeError('Search readiness timeout')
sampler=subprocess.Popen(['python3','scripts/benchmark-resources.py',str(results/('collection-resources.jsonl' if collect_only else 'storage-resources.jsonl')),*[name+'-'+r for r in ['worker','pg','search','redis','projection']]])
child=subprocess.Popen(['true'] if '--collect-only' in sys.argv else ['docker','exec','-e','STORAGE_OVERHAUL_ONLY=1',name+'-worker','node','scripts/p5-campaign.cjs'],stdout=log,stderr=subprocess.STDOUT)
try:
 start=time.monotonic()
 while child.poll() is None:
  if time.monotonic()-start>1800:raise RuntimeError('Bounded campaign timeout')
  try:r=json.loads((results/'control.json').read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.2);continue
  if r['id']==last:time.sleep(.2);continue
  assert r['action'] in ['projection-start','projection-stop']
  docker('start' if r['action']=='projection-start' else 'stop',name+'-projection',stdout=subprocess.DEVNULL)
  last=r['id'];temp=results/'control-ack.tmp';temp.write_text(json.dumps({'id':last,'ok':True}));temp.replace(results/'control-ack.json')
 assert child.returncode==0,'See private campaign.log'
 for script in ['collect-p3a-storage','normalize-p3a-observations','normalize-p3a-catalog']:
  with (results/(script+'.log')).open('w') as f:docker('exec','-e','STORAGE_OMIT_SEARCH_TEXT=1',name+'-worker','node','scripts/'+script+'.cjs',stdout=f,stderr=subprocess.STDOUT)
 with (results/'components.log').open('w') as f:
  docker('exec',name+'-worker','node','scripts/p5-components.cjs',stdout=f,stderr=subprocess.STDOUT)
 with (results/'category-search.log').open('w') as f:
  docker('exec',name+'-worker','node','scripts/p5-components.cjs','storage-search',stdout=f,stderr=subprocess.STDOUT)
 with (results/'post-analysis.log').open('w') as f:
  docker('exec','-e','OPENSEARCH_URL=http://opensearch:9200',name+'-worker','node','scripts/storage-post-analysis.cjs',stdout=f,stderr=subprocess.STDOUT)
 physical_code="import os,json; out={};\nfor root in ['/postgres','/search']:\n apparent=allocated=0\n for base,dirs,files in os.walk(root):\n  allocated+=os.stat(base).st_blocks*512\n  for name in files:\n   try:s=os.stat(os.path.join(base,name));apparent+=s.st_size;allocated+=s.st_blocks*512\n   except FileNotFoundError:pass\n out[root[1:]]=dict(apparent=apparent,allocated=allocated)\nprint(json.dumps(out))"
 sizes=docker('run','--rm','--network','none','--memory','128m','--mount',f'type=bind,source={root}/postgres,destination=/postgres,readonly','--mount',f'type=bind,source={root}/search,destination=/search,readonly','python:3.12-slim','python','-c',physical_code,capture_output=True)
 (results/'physical-services.json').write_text(sizes.stdout)
finally:
 sampler.terminate();sampler.wait(timeout=30)
 if child.poll() is None:child.terminate()
 for role in ['projection','worker','pg','search','redis']:subprocess.run(['docker','stop',name+'-'+role],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log.close()
