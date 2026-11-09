#!/usr/bin/env python3
"""Read-only identity census. Fixed 128 MiB identity bitmap; no member bodies.
ZIP suffix identities are candidates, not verified canonical identities.
Use a read-only bind mount for input (including SQLite WAL sidecars).
"""
import json,pathlib,re,resource,sqlite3,struct,sys,time,zipfile
root=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2]); start=time.monotonic()
limit=128*1024*1024; masks=bytearray(limit); result={'sources':[], 'zip_identity_authority':'filename candidate only; missing IDs are unknown, not new works'}
url=re.compile(r'https?://(?:www\.)?archiveofourown\.org/works/(\d+)')
suffix=re.compile(r' - (\d+)\.(?:epub|html?|txt)$',re.I)
def count(rows,bit,name):
 n=missing=duplicates=outside=within=0; local=bytearray(limit//8)
 for value in rows:
  n+=1
  if value is None:missing+=1;continue
  i=int(value)
  if not 0<i<limit:outside+=1;continue
  if local[i//8] & (1<<(i%8)):within+=1
  local[i//8] |= 1<<(i%8)
  if masks[i]&bit:duplicates+=1
  masks[i]|=bit
 item=dict(source=name,records=n,without_identity=missing,out_of_bitmap=outside,duplicate_identified_records_in_source=within,duplicate_identified_records_in_source_group=duplicates,unique_identified_in_source=n-missing-outside-within,additional_identified_in_source_group=n-missing-outside-duplicates)
 result['sources'].append(item);print(json.dumps(item),flush=True)
for bit,name in enumerate([] if '--zip-only' in sys.argv else ['ao3.sqlite3','ao3_deduped.sqlite3','ao3_old_files.sqlite3']):
 c=sqlite3.connect((root/name).as_uri()+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON');c.execute('PRAGMA cache_size=-8192')
 tables=[('metadata_full_old','StoryURL'),('stories','storyurl')] if bit==2 else [('ao3_metadata','Story_URL')]
 for table,col in tables:
  def ids():
   for (v,) in c.execute('SELECT "'+col+'" FROM '+table):
    m=url.search(str(v or ''));yield m[1] if m else None
  count(ids(),1<<bit,name+':'+table)
 if name=='ao3_deduped.sqlite3':
  total,mergers=c.execute('SELECT count(*),count(merger_id) FROM ao3_tags').fetchone()
  result['ancillary_tags']={'rows':total,'nonnull_merger_id':mergers,'identity':'Integer primary key; not work identities or acquisitions'}
 c.close()
# Stream central directories directly: ZipFile would materialize millions of names.
for p in sorted(root.glob('*.zip')):
 def ids():
  with p.open('rb') as f:
   e=zipfile._EndRecData(f)
   if not e:raise ValueError('Missing ZIP directory')
   f.seek(e[zipfile._ECD_OFFSET])
   for _ in range(e[zipfile._ECD_ENTRIES_TOTAL]):
    h=f.read(46)
    if h[:4]!=b'PK\x01\x02':raise ValueError('Invalid central directory')
    n,x,k=struct.unpack_from('<HHH',h,28);name=f.read(n).decode('utf-8' if struct.unpack_from('<H',h,8)[0]&2048 else 'cp437');f.seek(x+k,1)
    if name.endswith('/'):continue
    m=suffix.search(name);yield m[1] if m else None
 count(ids(),8,p.name)
hist=[0]*16
for m in masks:hist[m]+=1
result.update(identity_membership_histogram={str(i):n for i,n in enumerate(hist) if i},unique_identified_union=sum(hist[1:]),seconds=time.monotonic()-start,peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,bitmap_limit=limit)
out.write_text(json.dumps(result,indent=2))
