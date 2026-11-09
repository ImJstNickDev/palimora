"""Supplementary pack composition and SQL heap/index/TOAST after equal replay."""
import json,pathlib,struct,subprocess,sys
root=pathlib.Path(sys.argv[1])
assert str(root).startswith('/mnt/sdb/palimora-p3-final-')
name=(root/'name').read_text().strip()
assert name.startswith('palimora-release-test-')
kinds={}
for pack in (root/'storage/main/packs').glob('*.pmpack'):
 with pack.open('rb') as f:
  assert f.read(8)==b'PMPACK01'
  while raw:=f.read(4):
   assert len(raw)==4
   n=struct.unpack('<I',raw)[0];assert 2<=n<=65536
   h=json.loads(f.read(n))
   v=kinds.setdefault(h['kind'],dict(records=0,raw_bytes=0,payload_bytes=0,header_bytes=0))
   v['records']+=1;v['raw_bytes']+=h['size'];v['payload_bytes']+=h['length'];v['header_bytes']+=4+n
   f.seek(h['length'],1)
sql="""SELECT coalesce(json_agg(x),'[]') FROM (
SELECT c.relname,pg_relation_size(c.oid) heap_bytes,pg_indexes_size(c.oid) index_bytes,
CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END toast_bytes,
pg_total_relation_size(c.oid) total_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname) x"""
tables=json.loads(subprocess.check_output(['docker','exec',name+'-pg','psql','-U','postgres','-d','palimora_release_test','-Atc',sql],text=True))
result={'measurement_point':'supplementary after one full replay in every profile; headline storage was captured before replay',
 'pack_composition_including_physical_duplicates':kinds,'postgres_relations':tables,
 'postgres_totals':{k:sum(t[k] for t in tables) for k in ['heap_bytes','index_bytes','toast_bytes','total_bytes']}}
(root/'results/p4-storage-detail.json').write_text(json.dumps(result,indent=2)+'\n')
