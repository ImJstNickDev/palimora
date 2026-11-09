"""Private partitions of the authorized reference ZIP, not a dump-wide sample."""
import hashlib,json,pathlib,sys,zipfile
source=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2])
with source.open('rb') as f:
    assert hashlib.file_digest(f,'sha256').hexdigest()=='fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429'
dest.mkdir(mode=0o700)
outputs=[zipfile.ZipFile(dest/f'part{i}.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) for i in range(4)]
try:
    with zipfile.ZipFile(source) as z:
        for i,entry in enumerate(z.infolist()):outputs[i%4].writestr(entry,z.read(entry))
finally:
    for z in outputs:z.close()
# Existing benchmark harness validates the original reference without selecting it.
(dest/source.name).symlink_to(source)
print(json.dumps({'sources':[f'part{i}.zip' for i in range(4)],'compressed_bytes':sum((dest/f'part{i}.zip').stat().st_size for i in range(4))}))
