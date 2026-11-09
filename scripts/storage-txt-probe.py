#!/usr/bin/env python3
"""Re-read only the 160 P5 TXT samples, validate hashes and measure derived duplication."""
import base64,ctypes,ctypes.util,hashlib,json,pathlib,sys,zipfile
sys.path.insert(0,'/app/apps/ingest-adapters')
from ao3 import text_record
lib=ctypes.CDLL(ctypes.util.find_library('zstd'))
lib.ZSTD_compressBound.argtypes=[ctypes.c_size_t];lib.ZSTD_compressBound.restype=ctypes.c_size_t
lib.ZSTD_compress.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int];lib.ZSTD_compress.restype=ctypes.c_size_t
samples=json.loads(pathlib.Path('/manifest/sample-private-manifest.json').read_text())['categories']['txt'];out={}
assert len(samples)==160 and {s['source'] for s in samples}=={'ao3_old_files_part17.zip'}
with zipfile.ZipFile('/input/ao3_old_files_part17.zip') as z:
 for s in samples:
  data=z.read(s['member']);assert hashlib.sha256(data).hexdigest()==s['sha256']
  parsed=text_record(data)
  for o in parsed['objects']:
   b=base64.b64decode(o['data']);buf=ctypes.create_string_buffer(lib.ZSTD_compressBound(len(b)));n=lib.ZSTD_compress(buf,len(buf),b,len(b),3);assert n<=len(buf)
   row=out.setdefault(o['kind'],dict(objects=0,raw=0,payload=0));row['objects']+=1;row['raw']+=len(b);row['payload']+=min(n,len(b))
print(json.dumps(out))
