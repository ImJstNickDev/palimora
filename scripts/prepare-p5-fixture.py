#!/usr/bin/env python3
"""Stratified bounded copy; input read-only. No entire source is imported.
Limits: 1 GiB member bytes, 1800 members, 900 s; ZIP directory memory 6 GiB cgroup.
Output private manifest contains original locators and must never be published.
"""
import collections,hashlib,heapq,io,json,os,pathlib,random,sqlite3,sys,time,zipfile
root=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2]);dest.mkdir(mode=0o700)
start=time.monotonic();used=0;members=0;rng=random.Random(20261109);manifest={'categories':{},'directories':[],'limits':{'bytes':2**30,'members':1800,'seconds':900}}
outputs={}
def output(category):
    if category not in outputs:outputs[category]=zipfile.ZipFile(dest/(category+'.zip'),'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)
    return outputs[category]
def keep(z,e,category,source):
    global used,members
    if used+e.file_size>2**30 or members>=1800 or time.monotonic()-start>900:raise RuntimeError('Sampling budget exhausted')
    if e.file_size>24*2**20:return
    b=z.read(e);name=source+'/'+e.filename
    output(category).writestr(name,b);used+=len(b);members+=1
    manifest['categories'].setdefault(category,[]).append(dict(source=source,member=e.filename,compressed_bytes=e.compress_size,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
try:
 for filename in (sys.argv[3].split(',') if len(sys.argv)>3 else ['queue73.zip','queue100.zip','queue03.zip','queue22.zip','ao3_old_files_part17.zip']):
    with zipfile.ZipFile(root/filename) as z:
        reservoirs={};seen=collections.Counter();totals=collections.defaultdict(lambda:dict(members=0,compressed=0,expanded=0));largest=[]
        for e in z.infolist():
            ext=pathlib.Path(e.filename).suffix.lower()
            if ext not in ['.epub','.txt','.html']:continue
            category=('epub-small' if e.file_size<16384 else 'epub-medium' if e.file_size<131072 else 'epub-large') if ext=='.epub' else ext[1:]
            t=totals[category];t['members']+=1;t['compressed']+=e.compress_size;t['expanded']+=e.file_size
            if e.file_size>24*2**20:continue
            seen[category]+=1;sample=reservoirs.setdefault(category,[]);limit=(8 if len(sys.argv)>3 else 48) if ext=='.epub' else 160
            if len(sample)<limit:sample.append(e)
            else:
                j=rng.randrange(seen[category])
                if j<limit:sample[j]=e
            if ext=='.epub':
                item=(e.file_size,e.filename,e)
                if len(largest)<4:heapq.heappush(largest,item)
                elif item[:2]>largest[0][:2]:heapq.heapreplace(largest,item)
        manifest['directories'].append(dict(source=filename,categories=dict(totals)))
        selected=set()
        for category,sample in reservoirs.items():
            for e in sample:keep(z,e,category,filename);selected.add(e.filename)
        for _,_,e in largest:
            if e.filename not in selected:keep(z,e,'epub-extreme',filename)
        print(json.dumps({'sampled':filename,'bytes':used,'members':members}),flush=True)
 for filename in ([] if len(sys.argv)>3 else ['ao3.sqlite3','ao3_deduped.sqlite3','ao3_old_files.sqlite3']):
    source=sqlite3.connect((root/filename).as_uri()+'?mode=ro',uri=True);source.execute('PRAGMA query_only=ON');target=sqlite3.connect(dest/('sample_'+filename));tables=[]
    for name,sql in source.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('ao3_metadata','metadata_full_old','stories','ao3_tags')"):
        target.execute(sql);maximum=source.execute('SELECT max(rowid) FROM '+name).fetchone()[0] or 0;copied=set()
        for fraction in [0,.25,.5,.75,.99]:
            for row in source.execute('SELECT rowid,* FROM '+name+' WHERE rowid>=? ORDER BY rowid LIMIT 12',(int(maximum*fraction),)):
                if row[0] in copied:continue
                copied.add(row[0]);target.execute('INSERT INTO '+name+' VALUES('+','.join('?' for _ in row[1:])+')',row[1:])
        tables.append(dict(table=name,max_rowid=maximum,sampled_rows=len(copied)))
    target.commit();target.close();source.close();manifest.setdefault('sqlite',[]).append(dict(source=filename,tables=tables))
finally:
 for z in outputs.values():z.close()
manifest.update(sampled_bytes=used,sampled_members=members,seconds=time.monotonic()-start)
(dest/'private-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({k:v for k,v in manifest.items() if k!='categories'},indent=2))
