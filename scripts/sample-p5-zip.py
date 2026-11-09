#!/usr/bin/env python3
"""Bounded metadata/member inspection; run with the dump mounted read-only."""
import collections,io,json,pathlib,resource,sys,zipfile
root=pathlib.Path(sys.argv[1]);results=[]
for name in ['queue119_archive05.zip','queue73.zip','queue100.zip','queue03.zip','queue22.zip','ao3_old_files_part17.zip']:
    with zipfile.ZipFile(root/name) as z:
        entries=z.infolist(); eligible=[e for e in entries if e.filename.lower().endswith(('.epub','.txt','.html','.csv')) and 0<e.file_size<=24*2**20]
        selected={e.filename:e for e in eligible[:4]+eligible[-4:]+sorted(eligible,key=lambda e:e.file_size)[-2:]}
        out={'source':name,'members':len(entries),'central_directory_process_peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'sampled_bytes':0,'samples':[]}
        for e in selected.values():
            if out['sampled_bytes']+e.file_size>64*2**20:continue
            b=z.read(e);out['sampled_bytes']+=len(b);item={'extension':pathlib.Path(e.filename).suffix,'bytes':len(b),'crc_verified':True}
            if e.filename.endswith('.epub'):
                with zipfile.ZipFile(io.BytesIO(b)) as ep:
                    names=ep.infolist();item.update(chapter_filename_matches=sum('chapter' in a.filename.lower() and a.filename.endswith(('.html','.xhtml')) for a in names),inner_bytes=sum(a.file_size for a in names),media_bytes=sum(a.file_size for a in names if pathlib.Path(a.filename).suffix.lower() in ['.png','.jpg','.jpeg','.gif','.webp','.svg']))
            out['samples'].append(item)
        results.append(out)
        print(json.dumps(out),flush=True)
