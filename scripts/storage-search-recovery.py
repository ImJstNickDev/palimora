#!/usr/bin/env python3
"""Crash only the isolated storage benchmark container after a translog ACK."""
import json,pathlib,subprocess,sys,time
name='palimora-storage-search';root=pathlib.Path(sys.argv[1]);index='storage-bench-d-zstd3'
info=json.loads(subprocess.check_output(['docker','inspect',name]))[0];assert info['Config']['Labels']['palimora.test']=='true'
def req(path,body=None,method='GET'):
 args=['docker','exec','-i',name,'curl','-fsS','-X',method,'-H','Content-Type: application/json','http://localhost:9200'+path]
 if body is not None:args+=['--data-binary','@-']
 r=subprocess.run(args,input=json.dumps(body) if body is not None else None,capture_output=True,text=True,check=True);return json.loads(r.stdout)
expected=req('/'+index+'/_count')['count']
req('/'+index+'/_settings',{'index.refresh_interval':'-1'},'PUT')
req('/'+index+'/_doc/storage-recovery-proof',{'id':'storage-recovery-proof','generation':'proof','text':{'en':'palimora durable recovery phrase'}},'PUT')
subprocess.run(['docker','kill','--signal','KILL',name],check=True,capture_output=True)
subprocess.run(['docker','start',name],check=True,capture_output=True)
for _ in range(90):
 try:req('/_cluster/health');break
 except subprocess.CalledProcessError:time.sleep(1)
else:raise RuntimeError('Restart timeout')
req('/'+index+'/_refresh',{},'POST')
result=req('/'+index+'/_search',{'query':{'match_phrase':{'text.en':'palimora durable recovery phrase'}}},'POST')
assert result['hits']['total']['value']==1
assert 'text' not in result['hits']['hits'][0]['_source']
req('/'+index+'/_doc/storage-recovery-proof',method='DELETE')
req('/'+index+'/_settings',{'index.refresh_interval':'1s'},'PUT')
# This disposable benchmark index must not retain the fault-test document in
# subsequent density measurements. Never apply this diagnostic merge to live indices.
req('/'+index+'/_refresh',{},'POST');req('/'+index+'/_flush',{},'POST')
req('/'+index+'/_settings',{'index.merge.policy.expunge_deletes_allowed':0},'PUT')
try:req('/'+index+'/_forcemerge?only_expunge_deletes=true&flush=true',{},'POST')
finally:req('/'+index+'/_settings',{'index.merge.policy.expunge_deletes_allowed':None},'PUT')
req('/'+index+'/_refresh',{},'POST')
assert req('/'+index+'/_stats')['_all']['primaries']['docs']=={'count':expected,'deleted':0}
(root/'search-recovery.json').write_text(json.dumps({'acknowledged_write_survived_sigkill':True,'phrase_query_passed':True,'stored_text_absent':True,'refresh_disabled_only_during_fault':True,'fsync_not_disabled':True,'benchmark_proof_document_expunged':True}))
