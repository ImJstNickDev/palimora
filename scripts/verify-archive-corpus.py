#!/usr/bin/env python3
"""Read-only schema and ZIP sampling; output contains counts, never work content."""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/ingest-adapters'))
import ao3

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('root', type=Path)
group = p.add_mutually_exclusive_group(required=True)
group.add_argument('--zip')
group.add_argument('--all-zips', action='store_true')
p.add_argument('--csv', action='store_true', help='Verify every row of bibliographic CSV indexes too')
a = p.parse_args()
csv.field_size_limit(sys.maxsize)
for name in ('ao3.sqlite3', 'ao3_deduped.sqlite3', 'ao3_old_files.sqlite3'):
    path = a.root / name
    if not path.exists():
        print(json.dumps(dict(file=name, state='missing_source')), flush=True)
        continue
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as c:
        c.execute('PRAGMA query_only=ON')
        print(json.dumps(dict(file=name, tables=c.execute("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall())), flush=True)

files = sorted(a.root.glob('*.zip')) if a.all_zips else [a.root / a.zip]
for path in files:
    with zipfile.ZipFile(path) as z:
        entries = z.infolist()
        candidates = [e for e in entries if e.filename.lower().endswith(('.epub', '.txt', '.html', '.htm')) and not Path(e.filename).name.startswith(('log_', 'manifest_', 'last_good', 'screen_', 'README', 'readme'))]
        selected = sorted({0, len(candidates)//2, len(candidates)-1}) if candidates else []
        result = dict(file=path.name, entries=len(entries), samples=0, chapters=0, notes=0, states={})
        for index in selected:
            e = candidates[index]
            with tempfile.TemporaryDirectory(prefix='palimora-corpus-') as staging:
                ao3.STAGING = staging
                ao3.active_dir = str(Path(staging) / 'objects')
                os.mkdir(ao3.active_dir)
                with tempfile.TemporaryFile(dir=staging) as source:
                    with z.open(e) as member:
                        shutil.copyfileobj(member, source, 8*1024*1024)
                    source.seek(0)
                    if e.filename.lower().endswith('.epub'):
                        r = ao3.epub(source)
                    elif e.filename.lower().endswith('.txt'):
                        r = ao3.text_record(source.read())
                    else:
                        r = ao3.html_record(source.read())
                objects = {o['name']: o for o in r['objects']}
                reconstructed = {}
                for chapter in r['chapters']:
                    body = Path(objects[chapter['name']]['path']).read_bytes()
                    for note in chapter.get('notes', []):
                        fragment = Path(objects[note['name']]['path']).read_bytes()
                        assert len(fragment) == note['length']
                        body = body[:note['offset']] + fragment + body[note['offset']:]
                        result['notes'] += 1
                    if chapter.get('source_html_sha256'):
                        assert hashlib.sha256(body).hexdigest() == chapter['source_html_sha256']
                    reconstructed[chapter['name']] = body
                if r.get('document'):
                    document=r['document']
                    body=Path(objects[document['shell']]['path']).read_bytes()
                    for fragment in document['fragments']:
                        value=reconstructed.get(fragment['name'])
                        if value is None:value=Path(objects[fragment['name']]['path']).read_bytes()
                        assert len(value)==fragment['length']
                        body=body[:fragment['offset']]+value+body[fragment['offset']:]
                    assert hashlib.sha256(body).hexdigest()==document['source_html_sha256']
                result['samples'] += 1
                result['chapters'] += len(r['chapters'])
                result['states'][r['state']] = result['states'].get(r['state'], 0) + 1
        if a.csv:
            result['csv_rows'] = 0
            for e in entries:
                if not e.filename.lower().endswith('.csv'):
                    continue
                with z.open(e) as member:
                    reader = csv.DictReader(io.TextIOWrapper(member, encoding='utf-8-sig', newline=''), strict=True)
                    assert {'Path', 'Title', 'Author', 'Story URL'}.issubset(reader.fieldnames or [])
                    for row in reader:
                        assert None not in row and all(v is not None for v in row.values())
                        result['csv_rows'] += 1
        print(json.dumps(result), flush=True)
