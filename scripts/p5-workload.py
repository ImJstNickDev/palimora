#!/usr/bin/env python3
"""Bounded P5 source inspection; official input must be mounted read-only."""
import argparse,json,pathlib,resource,time,zipfile,subprocess,sys,os,collections,gc,sqlite3

def memory(path,adapter):
    start=time.monotonic()
    if adapter:
        p=subprocess.Popen([sys.executable,'-u',adapter,str(path),'0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PALIMORA_ADAPTER_ACK':'1'})
        first=json.loads(p.stdout.readline());p.stdin.close();p.wait(timeout=30)
        assert 'total' in first and p.returncode==0,first
        count=first['total'];rss=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    else:
        with zipfile.ZipFile(path) as z:count=len(z.infolist())
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return dict(source=path.name,mode='adapter_inventory' if adapter else 'zipfile_only',members=count,seconds=time.monotonic()-start,peak_rss_kib=rss)

def inventory(root):
    out=[]
    for path in sorted(root.glob('*.zip')):
        try:
            with path.open('rb') as f:e=zipfile._EndRecData(f)
            if not e:raise zipfile.BadZipFile()
            out.append(dict(source=path.name,bytes=path.stat().st_size,members=e[zipfile._ECD_ENTRIES_TOTAL],central_directory_bytes=e[zipfile._ECD_SIZE]))
        except (OSError,zipfile.BadZipFile):out.append(dict(source=path.name,error='unreadable_directory'))
    return out
def distributions(root):
    out=[]
    deadline=time.monotonic()+1200
    for path in sorted(root.glob('*.zip')):
        if time.monotonic()>deadline:raise RuntimeError('Metadata inventory deadline')
        groups=collections.defaultdict(lambda:dict(members=0,compressed_bytes=0,expanded_bytes=0))
        with zipfile.ZipFile(path) as z:
            for e in z.infolist():
                ext=pathlib.Path(e.filename).suffix.lower()
                group=ext.lstrip('.') or 'other'
                if ext=='.epub':group+='-'+('small' if e.file_size<16384 else 'medium' if e.file_size<131072 else 'large' if e.file_size<1048576 else 'huge')
                g=groups[group];g['members']+=1;g['compressed_bytes']+=e.compress_size;g['expanded_bytes']+=e.file_size
        out.append(dict(source=path.name,groups=dict(groups)))
        del z;gc.collect()
    sql=[]
    for path in sorted(root.glob('*.sqlite3')):
        c=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON')
        try:stats=c.execute('SELECT tbl,idx,stat FROM sqlite_stat1 LIMIT 30').fetchall()
        except sqlite3.OperationalError:stats=[]
        sql.append(dict(source=path.name,planner_statistics=stats));c.close()
    return dict(zip_distributions=out,sqlite_planner_statistics=sql)

def csv_sample(root,dest):
    import io,csv,hashlib
    dest.mkdir(mode=0o700);start=time.monotonic()
    with zipfile.ZipFile(root/'gap_filled.zip') as z:
        e=next(e for e in z.infolist() if e.filename.endswith('.csv'))
        with z.open(e) as f:b=f.read(2*1024**2)
    rows=list(csv.reader(io.StringIO(b.decode('utf-8-sig'))))[:65]
    assert len(rows)==65
    out=io.StringIO();csv.writer(out).writerows(rows);data=out.getvalue().encode()
    with zipfile.ZipFile(dest/'csv.zip','x',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('sample.csv',data)
    result=dict(rows=64,member_prefix_read_bytes=len(b),fixture_bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),seconds=time.monotonic()-start,whole_original_crc_verified=False)
    (dest/'sample.json').write_text(json.dumps(result));return result

def metadata_cache(root,dest):
    sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'apps/ingest-adapters'))
    from metadata_index import indexed_rows
    dest.mkdir(mode=0o700);out=[]
    for name in ['sample_ao3.sqlite3','sample_ao3_deduped.sqlite3','sample_ao3_old_files.sqlite3']:
        path=root/name;c=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
        for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ao3_metadata','metadata_full_old','stories')"):
            table=row[0];target=dest/(name+'-'+table);target.mkdir();os.environ['PALIMORA_METADATA_CACHE']=str(target);t=time.monotonic()
            list(indexed_rows(c,str(path),table,0,[],[],lambda x:None))
            seconds=time.monotonic()-t;f=next(target.glob('*.sqlite3'));cache=sqlite3.connect(f)
            n,logical=cache.execute('select count(*),sum(length(cast(evidence as blob))+coalesce(length(url),0)+coalesce(length(prefix),0)) from metadata').fetchone()
            out.append(dict(source=name,table=table,rows=n,logical_bytes=logical,physical_bytes=f.stat().st_size,seconds=seconds));cache.close()
        c.close()
    return out

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['memory','inventory','distributions','csv','metadata-cache']);p.add_argument('path');p.add_argument('--adapter');p.add_argument('--output');a=p.parse_args();root=pathlib.Path(a.path)
    if a.mode in ['csv','metadata-cache']:
        if not a.output:p.error('--output must name a new private directory')
        result=(csv_sample if a.mode=='csv' else metadata_cache)(root,pathlib.Path(a.output))
    else:result=memory(root,a.adapter) if a.mode=='memory' else distributions(root) if a.mode=='distributions' else inventory(root)
    print(json.dumps(result,indent=2))
