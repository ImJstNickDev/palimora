#!/usr/bin/env python3
"""Control only containers owned by a new P5 fixture. No production socket mount."""
import json,os,pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]);assert root.name=='run' and root.parent.name.startswith('palimora-p5-completion-')
name=(root/'name').read_text().strip();assert name.startswith('palimora-release-test-')
def docker(*args,**kwargs):return subprocess.run(['docker',*args],check=True,text=True,**kwargs)
for role in ['worker','pg','search','redis','projection']:
 c=json.loads(docker('inspect',name+'-'+role,capture_output=True).stdout)[0];assert c['Config']['Labels'].get('palimora.test')=='true'
results=root/'results';log=(results/'campaign.log').open('w')
sampler=subprocess.Popen(['python3','scripts/benchmark-resources.py',str(results/'completion-resources.jsonl'),*[name+'-'+r for r in ['worker','pg','search','redis','projection']]])
child=subprocess.Popen(['docker','exec','-e','P5_RESUME='+os.environ.get('P5_RESUME','0'),name+'-worker','node','scripts/p5-campaign.cjs'],stdout=log,stderr=subprocess.STDOUT)
last=json.loads((results/'control-ack.json').read_text())['id'] if os.environ.get('P5_RESUME')=='1' else 0;restore_created=False;start=time.monotonic()
try:
 while child.poll() is None:
  if time.monotonic()-start>3600:raise RuntimeError('One-hour deadline')
  try:request=json.loads((results/'control.json').read_text())
  except (FileNotFoundError,json.JSONDecodeError):time.sleep(.2);continue
  if request['id']==last:time.sleep(.2);continue
  action=request['action'];ok=False
  try:
   if action=='projection-start':docker('start',name+'-projection',stdout=subprocess.DEVNULL)
   elif action=='projection-stop':docker('stop',name+'-projection',stdout=subprocess.DEVNULL)
   elif action=='search-stop':docker('stop',name+'-search',stdout=subprocess.DEVNULL)
   elif action=='search-start':
    docker('start',name+'-search',stdout=subprocess.DEVNULL)
    for _ in range(90):
     r=subprocess.run(['docker','exec',name+'-search','curl','-fsS','localhost:9200/_cluster/health'],capture_output=True)
     if r.returncode==0:break
     time.sleep(1)
    else:raise RuntimeError('Search restart timeout')
   elif action=='heterogeneous-backup':
    dest=root/'restore-search';dest.mkdir();dest.chmod(0o777)
    docker('run','-d','--name',name+'-restore-search','--label','palimora.test=true','--network',name,'--network-alias','restore-search','--cpus','2','--memory','3g','--mount',f'type=bind,source={dest},destination=/usr/share/opensearch/data','-e','discovery.type=single-node','-e','node.store.allow_mmap=false','-e','DISABLE_INSTALL_DEMO_CONFIG=true','-e','DISABLE_SECURITY_PLUGIN=true','-e','OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g','opensearchproject/opensearch:2.19.4',stdout=subprocess.DEVNULL);restore_created=True
    for _ in range(90):
     r=subprocess.run(['docker','exec',name+'-restore-search','curl','-fsS','localhost:9200/_cluster/health'],capture_output=True)
     if r.returncode==0:break
     time.sleep(1)
    with (results/'backup.log').open('w') as f:docker('exec',name+'-worker','node','scripts/p5-backup.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=1200)
    docker('stop',name+'-restore-search',stdout=subprocess.DEVNULL)
   else:raise RuntimeError('Unknown action')
   ok=True
  finally:
   last=request['id'];temp=results/'control-ack.tmp';temp.write_text(json.dumps({'id':last,'ok':ok}));temp.replace(results/'control-ack.json')
 assert child.returncode==0,'Campaign failed; see private campaign.log'
 with (results/'verification.log').open('w') as f:docker('exec',name+'-worker','node','scripts/p5-verify.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=900)
finally:
 sampler.terminate();sampler.wait(timeout=30)
 if child.poll() is None:child.terminate()
 for role in ['projection','worker','pg','search','redis']+(['restore-search'] if restore_created else []):
  subprocess.run(['docker','stop',name+'-'+role],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log.close()
