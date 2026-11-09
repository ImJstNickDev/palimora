#!/usr/bin/env python3
"""Distinct synthetic works, bounded at 70,000 records; never a real-dump rate."""
import hashlib,io,json,pathlib,random,sys,zipfile
root=pathlib.Path(sys.argv[1]);rng=random.Random(9337);n=70000
vocabulary=['token'+str(i) for i in range(2048)]
outputs=[zipfile.ZipFile(root/f'synthetic-{i}.zip','x',compression=zipfile.ZIP_DEFLATED,compresslevel=3) for i in range(4)]
raw=0
try:
 for i in range(n):
  body=' '.join(rng.choices(vocabulary,k=1024))+' unique-record-'+str(i)
  data=f'Synthetic work {i}\nby Synthetic author\nStory URL: https://archiveofourown.org/works/{900000000000+i}\nLanguage: English\nChapters: 1\n\n\n\n{body}'.encode();outputs[i%4].writestr(f'{i}.txt',data);raw+=len(data)
finally:
 for z in outputs:z.close()
# Explicit synthetic edge cases: media, long work, repeated identity and changed revision.
for revision in [0,1]:
 with zipfile.ZipFile(root/f'edge-{revision}.zip','x',compression=zipfile.ZIP_DEFLATED) as outer:
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as ep:
   ep.writestr('META-INF/container.xml','<container><rootfile full-path="content.opf"/></container>')
   items=''.join(f'<item id="c{i}" href="chapter{i}.xhtml"/>' for i in range(256))
   spine=''.join(f'<itemref idref="c{i}"/>' for i in range(256))
   ep.writestr('content.opf',f'<package><metadata><source>https://archiveofourown.org/works/899999999999</source><title>Conflict {revision}</title></metadata><manifest>{items}<item id="img" href="image.png"/></manifest><spine>{spine}</spine></package>')
   for i in range(256):ep.writestr(f'chapter{i}.xhtml',f'<html><body class="fff_chapter"><p>Chapter {i} revision {revision if i==0 else 0}</p><img src="image.png"/></body></html>')
   ep.writestr('image.png',hashlib.shake_256(b'fixture media').digest(1024*1024))
  outer.writestr('media.epub',b.getvalue())
(root/'synthetic-manifest.json').write_text(json.dumps({'works':n,'chapters':n,'uncompressed_bytes':raw,'source_bytes':sum((root/f'synthetic-{i}.zip').stat().st_size for i in range(4)),'seed':9337,'distinct_identity_and_body':True}))
