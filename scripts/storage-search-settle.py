#!/usr/bin/env python3
"""Only named isolated benchmark indices; ordinary settlement and diagnostic merge separate."""
import json,pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]); container='palimora-storage-search'
def request(path,method='GET'):
 r=subprocess.run(['docker','exec',container,'curl','-fsS','-X',method,'http://localhost:9200'+path],capture_output=True,text=True,check=True);return json.loads(r.stdout)
def files(index):
 uuid=request('/'+index+'/_settings')[index]['settings']['index']['uuid']
 command='cpath=$(printf "%s:" /usr/share/opensearch/lib/*.jar /usr/share/opensearch/plugins/*/*.jar); /usr/share/opensearch/jdk/bin/java -cp "/tmp:$cpath" StorageIndexFiles /usr/share/opensearch/data/nodes/0/indices/'+uuid+'/0/index'
 r=subprocess.run(['docker','exec',container,'bash','-c',command],capture_output=True,text=True,check=True)
 return json.loads(r.stdout[r.stdout.index('{"source_raw_bytes"'):])
out=json.loads((root/'search-settled.json').read_text()) if '--finalize-only' in sys.argv else []
for row in ([] if '--finalize-only' in sys.argv else json.loads((root/'search.json').read_text())):
 index='storage-bench-'+row['name'];assert index.startswith('storage-bench-')
 request('/'+index+'/_refresh','POST');request('/'+index+'/_flush','POST')
 before=request('/'+index+'/_stats')['_all']['primaries'];detail=files(index)
 start=time.monotonic()
 uuid=request('/'+index+'/_settings')[index]['settings']['index']['uuid']
 directory=root/'search/nodes/0/indices'/uuid
 def physical():
  total=0
  for path in directory.rglob('*'):
   try:
    if path.is_file():total+=path.stat().st_size
   except FileNotFoundError:pass
  return total
 initial=physical();peak=initial
 merge=subprocess.Popen(['docker','exec',container,'curl','-fsS','-X','POST','http://localhost:9200/'+index+'/_forcemerge?max_num_segments=1&flush=true'],stdout=subprocess.DEVNULL)
 while merge.poll() is None:
  peak=max(peak,physical());time.sleep(.5)
 assert merge.returncode==0
 peak=max(peak,physical())
 after=request('/'+index+'/_stats')['_all']['primaries']
 out.append(dict(name=row['name'],ordinary=before,ordinary_files=detail,benchmark_only_force_merge=after,merged_files=files(index),merge_seconds=time.monotonic()-start,merge_peak_physical_bytes=peak,merge_extra_sampled_bytes=peak-initial))
 (root/'search-settled.json').write_text(json.dumps(out,indent=2));print(row['name'],before['store']['size_in_bytes'],after['store']['size_in_bytes'],flush=True)

# A completed merge may still have obsolete files pinned by an old searcher.
# Preserve its immediate size, then observe ordinary refresh/flush cleanup.
for row in out:
 index='storage-bench-'+row['name']
 row.setdefault('immediate_after_force_merge',row['benchmark_only_force_merge'])
 request('/'+index+'/_refresh','POST');request('/'+index+'/_flush','POST')
 previous=None;stable=0
 for _ in range(30):
  current=request('/'+index+'/_stats')['_all']['primaries']
  size=current['store']['size_in_bytes']
  stable=stable+1 if size==previous and current['merges']['current']==0 else 0
  if stable>=2:break
  previous=size;time.sleep(1)
 row['benchmark_only_force_merge']=current
(root/'search-settled.json').write_text(json.dumps(out,indent=2))
