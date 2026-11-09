"""Final filesystem bytes, including WAL/translog, on private test bind mounts."""
import json,pathlib,subprocess,sys
code='''import os,json
result={}
for component in ['storage','postgres','search','redis']:
 size=allocated=files=0
 for root,_,names in os.walk('/fixture/'+component):
  for name in names:
   try:
    s=os.stat(os.path.join(root,name));size+=s.st_size;allocated+=s.st_blocks*512;files+=1
   except FileNotFoundError:pass
 result[component]=dict(apparent_bytes=size,allocated_bytes=allocated,files=files)
print(json.dumps(result))
'''
for value in sys.argv[1:]:
 root=pathlib.Path(value)
 assert str(root).startswith('/mnt/sdb/palimora-p3a-') and (root/'results/p3a-storage.json').exists()
 result=subprocess.check_output(['docker','run','--rm','--network','none','--user','0','--entrypoint','python3','--mount',f'type=bind,source={root},destination=/fixture,readonly','palimora-p3a-api','-c',code],text=True)
 (root/'results/p3a-disk.json').write_text(result)
