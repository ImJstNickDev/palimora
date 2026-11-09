"""Bounded read-only TXT compatibility/compression sample; emits aggregates only."""
import base64,ctypes,ctypes.util,hashlib,importlib.util,json,os,random,resource,sys,time,zipfile
os.environ['PALIMORA_HTML_SCANNER']='python'
sys.path.insert(0,'/app/apps/ingest-adapters')
import ao3
spec=importlib.util.spec_from_file_location('baseline','/baseline/apps/ingest-adapters/ao3.py');old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
lib=ctypes.CDLL(ctypes.util.find_library('zstd'))
lib.ZSTD_compressBound.argtypes=[ctypes.c_size_t];lib.ZSTD_compressBound.restype=ctypes.c_size_t
lib.ZSTD_compress.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int];lib.ZSTD_compress.restype=ctypes.c_size_t
def compressed(b):
 out=ctypes.create_string_buffer(lib.ZSTD_compressBound(len(b)));n=lib.ZSTD_compress(out,len(out),b,len(b),3);assert n<=len(out);return min(n,len(b))
result={'seed':20261109,'maximum_member_bytes':4194304,'maximum_records_per_source':128,'sources':[]};start=time.monotonic()
for index,name in enumerate(sys.argv[1:]):
 row={'source_group':index+1,'eligible':0,'oversized':0,'records':0,'source_raw':0,'source_payload':0,'derived_raw':0,'derived_payload':0,'zip_payload':0};rng=random.Random(20261109);sample=[]
 with zipfile.ZipFile('/input/'+name) as z:
  for entry in z.infolist():
   if not entry.filename.lower().endswith('.txt'):continue
   if entry.file_size>4194304:row['oversized']+=1;continue
   row['eligible']+=1
   if len(sample)<128:sample.append(entry)
   else:
    slot=rng.randrange(row['eligible'])
    if slot<128:sample[slot]=entry
  for entry in sample:
   b=z.read(entry);a=old.text_record(b);c=ao3.text_record(b)
   assert len(c['objects'])==1 and base64.b64decode(c['objects'][0]['data'])==b
   derived=base64.b64decode(a['objects'][1]['data']);ch=c['chapters'][0];r=ch['transform'];body=b[r['offset']:r['offset']+r['length']].decode('utf-8');rebuilt=('<pre>'+ao3.html.escape(body)+'</pre>').encode()
   assert rebuilt==derived and hashlib.sha256(rebuilt).hexdigest()==ch['source_html_sha256'] and len(rebuilt)==r['output_size']
   row['records']+=1;row['source_raw']+=len(b);row['source_payload']+=compressed(b);row['derived_raw']+=len(derived);row['derived_payload']+=compressed(derived);row['zip_payload']+=entry.compress_size
 result['sources'].append(row)
result['seconds']=time.monotonic()-start;result['max_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps(result,indent=2))
