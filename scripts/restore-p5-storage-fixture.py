#!/usr/bin/env python3
"""Recover the bounded P5 sample from private manifests, validating every member hash."""
import hashlib,json,pathlib,sqlite3,sys,zipfile,collections
root=pathlib.Path('/input');dest=pathlib.Path('/output/fixture');dest.mkdir(mode=0o700)
for filename,prefix in [('sample-private-manifest.json',''),('media-private-manifest.json','media-')]:
 manifest=json.loads((pathlib.Path('/manifest')/filename).read_text());outputs={}
 try:
  bysource=collections.defaultdict(list)
  for category,entries in manifest['categories'].items():
   outputs[category]=zipfile.ZipFile(dest/(prefix+category+'.zip'),'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6)
   for entry in entries:bysource[entry['source']].append((category,entry))
  for source,entries in bysource.items():
   with zipfile.ZipFile(root/source) as archive:
    for category,e in entries:
     b=archive.read(e['member']);assert hashlib.sha256(b).hexdigest()==e['sha256'];outputs[category].writestr(source+'/'+e['member'],b)
   print(source,len(entries),flush=True)
 finally:
  for z in outputs.values():z.close()
for filename in ['ao3.sqlite3','ao3_deduped.sqlite3','ao3_old_files.sqlite3']:
 source=sqlite3.connect((root/filename).as_uri()+'?mode=ro',uri=True);source.execute('PRAGMA query_only=ON');source.execute('PRAGMA cache_size=-8192');target=sqlite3.connect(dest/('sample_'+filename))
 for name,sql in source.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('ao3_metadata','metadata_full_old','stories','ao3_tags')"):
  target.execute(sql);maximum=source.execute('SELECT max(rowid) FROM '+name).fetchone()[0] or 0;copied=set()
  for fraction in [0,.25,.5,.75,.99]:
   for row in source.execute('SELECT rowid,* FROM '+name+' WHERE rowid>=? ORDER BY rowid LIMIT 12',(int(maximum*fraction),)):
    if row[0] in copied:continue
    copied.add(row[0]);target.execute('INSERT INTO '+name+' VALUES('+','.join('?' for _ in row[1:])+')',row[1:])
 target.commit();target.close();source.close()
# Reuse the exact P5 edge generator without generating its unrelated 70k workload.
script=pathlib.Path('/app/scripts/prepare-p5-synthetic.py').read_text();body=script.split('# Explicit synthetic edge cases:')[1].split("(root/'synthetic-manifest.json')")[0]
import io
exec(body.split('\n',1)[1],dict(root=dest,io=io,zipfile=zipfile,hashlib=hashlib))
