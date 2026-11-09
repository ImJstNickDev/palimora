"""Sample apparent/allocated staging bytes in explicitly named private fixtures."""
import json,os,pathlib,sys,time
roots=[pathlib.Path(p) for p in sys.argv[1:]]
assert all(str(p).startswith('/mnt/sdb/palimora-p3a-') for p in roots)
for _ in range(1800):
    done=True
    for root in roots:
        if not (root/'results').exists():done=False;continue
        if (root/'results/end-to-end.json').exists():continue
        done=False;size=allocated=0
        for directory,_,files in os.walk(root/'storage/main/staging'):
            for f in files:
                try:
                    s=os.stat(os.path.join(directory,f));size+=s.st_size;allocated+=s.st_blocks*512
                except FileNotFoundError:pass
        with (root/'results/staging-samples.jsonl').open('a') as out:out.write(json.dumps(dict(time=time.time(),bytes=size,allocated_bytes=allocated))+'\n')
    if done:break
    time.sleep(1)
