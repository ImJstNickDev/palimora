#!/usr/bin/env python3
"""Full restore check on the owned storage candidate, after performance capture."""
import json,pathlib,subprocess,sys,time,os,concurrent.futures
root=pathlib.Path(sys.argv[1]);assert 'storage-overhaul' in str(root)
name=(root/'name').read_text().strip();assert name.startswith('palimora-release-test-')
def docker(*args,**kwargs):return subprocess.run(['docker',*args],check=True,text=True,**kwargs)
for role in ['worker','pg','search','redis']:
 info=json.loads(docker('inspect',name+'-'+role,capture_output=True).stdout)[0];assert info['Config']['Labels']['palimora.test']=='true'
 docker('start',name+'-'+role,stdout=subprocess.DEVNULL)
dest=root/'restore-search';dest.mkdir();dest.chmod(0o777)
docker('run','-d','--name',name+'-restore-search','--label','palimora.test=true','--network',name,'--network-alias','restore-search','--cpus','2','--memory','3g','--mount',f'type=bind,source={dest},destination=/usr/share/opensearch/data','-e','discovery.type=single-node','-e','node.store.allow_mmap=false','-e','DISABLE_INSTALL_DEMO_CONFIG=true','-e','DISABLE_SECURITY_PLUGIN=true','-e','OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g','opensearchproject/opensearch:2.19.4',stdout=subprocess.DEVNULL)
try:
 for _ in range(180):
  r=subprocess.run(['docker','exec',name+'-restore-search','curl','-fsS','localhost:9200/_cluster/health?wait_for_status=green&timeout=1s'],capture_output=True)
  if r.returncode==0 and not json.loads(r.stdout)['timed_out']:break
  time.sleep(1)
 else:raise RuntimeError('Restore search readiness timeout')
 if os.environ.get('FINAL_CANONICAL_VALIDATION')=='1':
  with (root/'results/canonical-downloads.log').open('w') as f:docker('exec',name+'-worker','node','scripts/benchmark-canonical-downloads.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=300)
 started=time.monotonic()
 def verify_text():
  if os.environ.get('FINAL_CANONICAL_VALIDATION')=='1':
   with (root/'results/canonical-search-text.log').open('w') as f:docker('exec',name+'-worker','node','scripts/verify-canonical-search-text.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=600)
 # Read-only source verification overlaps the isolated backup/restore, bounded by worker quotas.
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  verification=executor.submit(verify_text)
  with (root/'results/storage-backup.log').open('w') as f:docker('exec','-e','STORAGE_OVERHAUL_ONLY=1','-e','FINAL_CANONICAL_VALIDATION='+os.environ.get('FINAL_CANONICAL_VALIDATION','0'),name+'-worker','node','scripts/p5-backup.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=1200)
  verification.result()
 report=root/'results/backup-restore.json';evidence=json.loads(report.read_text());evidence['backup_restore_rebuild_verify_wall_seconds']=time.monotonic()-started;evidence['rebuild']=json.loads((root/'results/restored.json').read_text());report.write_text(json.dumps(evidence,indent=2))
 with (root/'results/readers.log').open('w') as f:
  docker('exec',name+'-worker','node','scripts/p5-verify.cjs','readers','/results/source-readers.json',stdout=f,stderr=subprocess.STDOUT)
  docker('exec','-e','DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_p5_restore_test','-e','ARCHIVE_ROOT=/benchmark/restored','-e','OPENSEARCH_URL=http://restore-search:9200',name+'-worker','node','scripts/p5-verify.cjs','readers','/results/restored-readers.json',stdout=f,stderr=subprocess.STDOUT)
 assert json.loads((root/'results/source-readers.json').read_text())==json.loads((root/'results/restored-readers.json').read_text()),'Restored reader content differs'
 with (root/'results/restore-immutable-signatures.log').open('w') as f:docker('exec',name+'-worker','node','scripts/storage-restore-signatures.cjs',stdout=f,stderr=subprocess.STDOUT)
 if os.environ.get('FINAL_CANONICAL_VALIDATION')=='1':
  with (root/'results/canonical-export.log').open('w') as f:docker('exec',name+'-worker','node','scripts/verify-final-canonical-export.cjs',stdout=f,stderr=subprocess.STDOUT,timeout=600)
  docker('exec',name+'-pg','psql','-U','postgres','-c','CREATE DATABASE palimora_csv_test',stdout=subprocess.DEVNULL)
  with (root/'results/csv.log').open('w') as f:docker('exec','-e','DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_csv_test','-e','ARCHIVE_ROOT=/benchmark/csv',name+'-worker','node','scripts/p5-campaign.cjs','csv',stdout=f,stderr=subprocess.STDOUT,timeout=180)
finally:
 for role in ['worker','pg','search','redis','restore-search']:subprocess.run(['docker','stop',name+'-'+role],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
