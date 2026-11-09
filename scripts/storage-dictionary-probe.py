#!/usr/bin/env python3
"""Bounded, disjoint-object dictionary probe; input packs are always read-only.

This is not a representative work-level holdout or an end-to-end format test.
At most 1000 training and 1000 validation objects per kind, each <=16 KiB.
"""
import ctypes as C, ctypes.util, hashlib, json, pathlib, struct, sys, time
z=C.CDLL(ctypes.util.find_library('zstd'));size=C.c_size_t;ptr=C.c_void_p
def bind(name,args,result=size):
 f=getattr(z,name);f.argtypes=args;f.restype=result;return f
bound=bind('ZSTD_compressBound',[size]);compress=bind('ZSTD_compress',[ptr,size,ptr,size,C.c_int]);decompress=bind('ZSTD_decompress',[ptr,size,ptr,size])
train=bind('ZDICT_trainFromBuffer',[ptr,size,ptr,C.POINTER(size),C.c_uint]);err=bind('ZSTD_isError',[size],C.c_uint)
cc=bind('ZSTD_createCCtx',[],ptr)();dc=bind('ZSTD_createDCtx',[],ptr)()
encode=bind('ZSTD_compress_usingDict',[ptr,ptr,size,ptr,size,ptr,size,C.c_int]);decode=bind('ZSTD_decompress_usingDict',[ptr,ptr,size,ptr,size,ptr,size])
samples={k:[[],[]] for k in ['metadata','notes_html','chapter_html','document_html','package_metadata']};seen=set();start=time.monotonic()
for file in sorted(pathlib.Path(sys.argv[1]).glob('*.pmpack')):
 with file.open('rb') as f:
  assert f.read(8)==b'PMPACK01'
  while prefix:=f.read(4):
   n=struct.unpack('<I',prefix)[0];assert n<=65536;h=json.loads(f.read(n));kind=h['kind'];bucket=int(h['hash'][-1],16)%2
   if kind not in samples or h['size']>16384 or h['hash'] in seen or len(samples[kind][bucket])>=1000:
    f.seek(h['length'],1);continue
   payload=f.read(h['length']);assert hashlib.sha256(payload).hexdigest()==h['checksum']
   if h['codec']=='raw':raw=payload
   else:
    target=C.create_string_buffer(h['size']);length=decompress(target,len(target),payload,len(payload));assert not err(length) and length==h['size'];raw=target.raw[:length]
   assert hashlib.sha256(raw).hexdigest()==h['hash'];seen.add(h['hash']);samples[kind][bucket].append(raw)
out={}
for kind,(training,validation) in samples.items():
 if len(training)<100 or len(validation)<100:continue
 dictionary=C.create_string_buffer(16384);data=b''.join(training);lengths=(size*len(training))(*map(len,training));n=train(dictionary,len(dictionary),data,lengths,len(training));assert not err(n)
 totals=dict(training_objects=len(training),validation_objects=len(validation),dictionary_bytes=n,raw_bytes=0,baseline_payload_bytes=0,dictionary_payload_bytes=0)
 t=time.process_time()
 for raw in validation:
  target=C.create_string_buffer(bound(len(raw)));a=compress(target,len(target),raw,len(raw),3);assert not err(a)
  b=encode(cc,target,len(target),raw,len(raw),dictionary,n,3);assert not err(b)
  decoded=C.create_string_buffer(len(raw));r=decode(dc,decoded,len(decoded),target,b,dictionary,n);assert not err(r) and decoded.raw[:r]==raw
  totals['raw_bytes']+=len(raw);totals['baseline_payload_bytes']+=min(a,len(raw));totals['dictionary_payload_bytes']+=min(b,len(raw))
 totals['dictionary_plus_payload_bytes']=totals['dictionary_bytes']+totals['dictionary_payload_bytes'];totals['roundtrip_probe_cpu_seconds']=time.process_time()-t;out[kind]=totals
bind('ZSTD_freeCCtx',[ptr])(cc);bind('ZSTD_freeDCtx',[ptr])(dc)
print(json.dumps(dict(kinds=out,seconds=time.monotonic()-start,adopted=False,holdout='Disjoint hashes, bounded first objects in physical pack order; not independent works or statistical sample.')))
