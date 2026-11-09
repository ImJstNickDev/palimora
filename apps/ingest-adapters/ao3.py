"""AO3 dump v4: bounded transport, CRC verification, read-only SQLite, exact locators."""
import sys, os, json, sqlite3, zipfile, io, re, base64, hashlib, traceback, tempfile, shutil, html, posixpath, glob, csv, zlib, struct
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor
import multiprocessing
import time
import fcntl
from urllib.parse import unquote
if os.environ.get('PALIMORA_HTML_SCANNER') == 'python':
    from html_fragments import notes, notes_and_resources, resource_urls, chapters as html_chapters
else:
    from native_fragments import notes, notes_and_resources, resource_urls, chapters as html_chapters
VERSION='ao3-dump-5'
CHUNK=8*1024*1024
STAGING=os.environ.get('PALIMORA_ADAPTER_STAGING')
active_dir=None
segment=None
segment_offset=0
GROUP_SIZE=max(1,min(1024,int(os.environ.get('PALIMORA_ADAPTER_GROUP_SIZE','1'))))
GROUP_BYTES=max(1,int(os.environ.get('PALIMORA_ADAPTER_GROUP_BYTES',str(16*1024*1024))))
pending_records=[]
pending_dirs=set()
pending_bytes=0
pending_started=0
GROUP_SECONDS=0.5
inflight=[]
parsing_dirs=set()
space_checked=0.0
space_budget=0
PREFETCH=max(1,min(8,int(os.environ.get('PALIMORA_ADAPTER_PREFETCH','1'))))
cache_input=os.fdopen(int(os.environ['PALIMORA_CACHE_FD'])) if os.environ.get('PALIMORA_CACHE_FD') and multiprocessing.current_process().name=='MainProcess' else None
class Unsupported(Exception): pass
def wire(v,ack=True):
    print(json.dumps(v,separators=(',',':'),ensure_ascii=False),flush=True)
    if ack and os.environ.get('PALIMORA_ADAPTER_ACK')=='1' and not sys.stdin.readline(): raise SystemExit(0)
def retained(directory):
    return directory in parsing_dirs or directory in pending_dirs or any(directory in group for group in inflight)
def acknowledge():
    if os.environ.get('PALIMORA_ADAPTER_ACK')=='1' and not sys.stdin.readline():raise SystemExit(0)
    directories=inflight.pop(0)
    for directory in directories:
        if directory!=active_dir and not retained(directory):cleanup_staging(directory)
def drain():
    while inflight:acknowledge()
def flush_records():
    global pending_records,pending_bytes
    if not pending_records:return
    print('{"schema":"palimora.ingest.group.v1","parser":'+json.dumps(VERSION)+',"records":['+','.join(item[0] for item in pending_records)+']}',flush=True)
    inflight.append(set(pending_dirs));pending_dirs.clear()
    pending_records=[];pending_bytes=0
    if len(inflight)>=PREFETCH:acknowledge()
def emit(v):
    global pending_bytes,pending_started
    close_segment()
    envelope=dict(schema='palimora.ingest.v1',parser=VERSION,**v)
    if GROUP_SIZE>1 and ('record' in v or 'tag' in v):
        if pending_records and pending_records[0][1]!=('tag' in v):flush_records()
        if not pending_records:pending_started=time.monotonic()
        encoded=json.dumps(envelope,separators=(',',':'),ensure_ascii=False)
        pending_records.append((encoded,'tag' in v))
        pending_bytes+=len(encoded.encode())+sum(o.get('size',0) for o in v.get('record',{}).get('objects',[]))
        if active_dir:pending_dirs.add(active_dir)
        if len(pending_records)>=GROUP_SIZE or pending_bytes>=GROUP_BYTES or time.monotonic()-pending_started>=GROUP_SECONDS:flush_records()
    else:
        flush_records();drain()
        wire(envelope)
def identity(s):
    m=re.search(r'https?://(?:www\.)?archiveofourown\.org/works/(\d+)',str(s or ''))
    return m.group(1) if m else None
def ensure_space(size):
    global space_checked,space_budget
    if not STAGING:return
    now=time.monotonic()
    # At most 8 MiB / 250 ms between filesystem checks per parser. Actual write
    # failures still propagate; the core independently reserves space for packs.
    if size>space_budget or now-space_checked>=0.25:
        free=shutil.disk_usage(STAGING).free-int(os.environ.get('ARCHIVE_RESERVE_BYTES','268435456'))
        if free<size:raise OSError(28,'Insufficient archive staging space')
        space_budget=min(free,max(size,8*1024*1024));space_checked=now
    space_budget-=size
    reserve_staging(size)
# Ephemeral reservations, not canonical state. Every write/copy is charged
# before it starts; all children share the same flock-protected directory ledger.
# Credits amortize ledger I/O over 8 MiB. ACK cleanup releases the whole directory.
staging_credit=0
staging_credit_dir=None
def staging_ledger(change):
    with open(os.path.join(STAGING,'.quota'),'r+') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        try:data=json.load(f)
        except (ValueError,TypeError):raise OSError(28,'Staging reservation ledger unavailable')
        change(data)
        f.seek(0);json.dump(data,f,separators=(',',':'));f.truncate()
def reserve_staging(size):
    global staging_credit,staging_credit_dir
    quota=int(os.environ.get('PALIMORA_STAGING_BYTES','0'))
    if not quota or not size:return
    if staging_credit_dir!=active_dir:
        staging_credit=0;staging_credit_dir=active_dir
    if staging_credit<size:
        requested=size-staging_credit
        granted=0
        def reserve(data):
            nonlocal granted
            remaining=quota-sum(data.values())
            if remaining<requested:raise OSError(28,'Staging reservation budget exhausted')
            granted=min(remaining,max(requested,8*1024*1024))
            key=os.path.basename(active_dir)
            data[key]=data.get(key,0)+granted
        staging_ledger(reserve)
        staging_credit+=granted
    staging_credit-=size
def cleanup_staging(directory,**kwargs):
    shutil.rmtree(directory,**kwargs)
    if int(os.environ.get('PALIMORA_STAGING_BYTES','0')):
        staging_ledger(lambda data:data.pop(os.path.basename(directory),None))
def close_segment():
    global segment
    if segment:segment.close();segment=None
def obj(name,kind,data):
    global segment,segment_offset
    if STAGING:
        path=os.path.join(active_dir,'objects.segment' if multiprocessing.current_process().name=='MainProcess' else 'objects-'+str(os.getpid())+'.segment')
        ensure_space(len(data))
        if segment is None:
            segment=open(path,'ab',buffering=1024*1024);segment_offset=segment.tell()
        offset=segment_offset;segment.write(data);segment_offset+=len(data)
        return dict(name=name,kind=kind,path=path,offset=offset,size=len(data),hash=hashlib.sha256(data).hexdigest())
    return dict(name=name,kind=kind,data=base64.b64encode(data).decode())
def asset(z,name,kind):
    parts=[];size=0;digest=hashlib.sha256()
    with z.open(name) as f:
        while True:
            b=f.read(CHUNK)
            if not b: break
            digest.update(b);size+=len(b);parts.append(obj(name+'#'+str(len(parts)),kind,b))
    if len(parts)<=1:
        if not parts: parts=[obj(name,kind,b'')]
        parts[0]['name']=name
        return parts
    manifest=dict(schema='palimora-chunks-v1',size=size,sha256=digest.hexdigest(),chunks=[dict(hash=p.get('hash') or hashlib.sha256(base64.b64decode(p['data'])).hexdigest(),size=p.get('size') or len(base64.b64decode(p['data']))) for p in parts])
    return parts+[obj(name,'chunk_manifest',json.dumps(manifest,sort_keys=True,separators=(',',':')).encode())]
def safe_xml(b):
    if b'<!ENTITY' in b: raise Unsupported('XML entities are unsupported')
    return ET.fromstring(b)
def epub(data):
    objects=[];chapters=[];media=set();partial=False;issues=[]
    with zipfile.ZipFile(data if hasattr(data,'read') else io.BytesIO(data)) as z:
        rootfile=safe_xml(z.read('META-INF/container.xml'))
        opf=next(e.attrib['full-path'] for e in rootfile.iter() if e.tag.endswith('rootfile'))
        root=safe_xml(z.read(opf));base=posixpath.dirname(opf);metadata={};work_id=None
        for e in root.iter():
            key=e.tag.split('}')[-1]
            if key in ('title','creator','language','description','subject','date','identifier','source') and e.text:
                metadata.setdefault(key,[]).append(e.text)
                if key in ('identifier','source'): work_id=work_id or identity(e.text)
        items={e.attrib['id']:e.attrib for e in root.iter() if e.tag.split('}')[-1]=='item'}
        used=set()
        for e in root.iter():
            if e.tag.split('}')[-1]!='itemref': continue
            it=items[e.attrib['idref']];name=posixpath.normpath(posixpath.join(base,unquote(it['href'])));used.add(name)
            try: b=z.read(name)
            except (KeyError,zipfile.BadZipFile,EOFError): partial=True;issues.append(dict(member=name,code='missing_or_corrupt_member'));continue
            try:text=b.decode('utf-8')
            except UnicodeDecodeError:partial=True;issues.append(dict(member=name,code='invalid_utf8'));continue
            if 'fff_titlepage' in text:
                for field,value in re.findall(r'<b>([^<]+):</b>\s*(.*?)(?=<b>|</body>)',text,re.S):
                    value=re.sub(r'<br\s*/?>\s*$','',value.strip(),flags=re.I)
                    metadata[field]=html.unescape(re.sub('<[^>]+>','',value)).strip() if field!='Summary' else value
            is_chapter=bool(re.search(r'class=["\'][^"\']*\bfff_chapter\b',text)) or bool(re.search(r'(?:^|/)chapter\d+\.x?html$',name))
            if is_chapter:
                url=re.search(r'name=["\']chapterurl["\'][^>]*content=["\']([^"\']+)',text)
                fragments,urls=notes_and_resources(text);media.update(urls);note_refs=[];pieces=[];end=0
                for index,(start,stop) in enumerate(fragments):
                    pieces.append(text[end:start]);note_name=name+'#note'+str(index);fragment=text[start:stop].encode();objects.append(obj(note_name,'notes_html',fragment));note_refs.append(dict(name=note_name,offset=len(text[:start].encode()),length=len(fragment)));end=stop
                pieces.append(text[end:])
                chapters.append(dict(name=name,source_url=html.unescape(url[1]) if url else None,notes=note_refs,source_html_sha256=hashlib.sha256(b).hexdigest()))
                if fragments:b=''.join(pieces).encode()

            if not is_chapter:media.update(resource_urls(text))
            objects.append(obj(name,'chapter_html' if is_chapter else 'document_html',b))
        for it in items.values():
            name=posixpath.normpath(posixpath.join(base,unquote(it['href'])))
            if name not in used:
                try: objects.extend(asset(z,name,'css' if it.get('media-type')=='text/css' else 'asset'))
                except (KeyError,zipfile.BadZipFile,EOFError): partial=True;issues.append(dict(member=name,code='missing_or_corrupt_member'))
        # Source package metadata remains independently recoverable.
        objects.extend([obj(opf,'package_metadata',z.read(opf)),obj('META-INF/container.xml','package_metadata',z.read('META-INF/container.xml'))])
        if not chapters and not partial: raise Unsupported('Unsupported EPUB chapter structure')
        expected=str(metadata.get('Chapters','')).split('/')[0].replace(',','').strip()
        if expected.isdigit() and int(expected)!=len(chapters):partial=True;issues.append(dict(code='chapter_count_mismatch',expected=int(expected),preserved=len(chapters)))
        return dict(external_id=work_id,metadata=metadata,chapters=chapters,objects=objects,state='partial' if partial else 'valid',observed_at=None,media_urls=sorted(media),issues=issues)
def text_record(data):
    text=data.decode('utf-8-sig');header,_,body=text.partition('\n\n\n\n')
    # FanFicFare text exports have a bibliographic header followed by blank lines.
    url=re.search(r'^Story URL: (.+)$',text,re.M)
    if not url: raise Unsupported('Unsupported text header')
    header_end=text.find('\n\n\n\n',url.end())
    if header_end<0: header_end=url.end()
    header=text[:header_end];body=text[header_end:].strip()
    fields=dict(re.findall(r'^([A-Za-z][A-Za-z ]+): (.*)$',header,re.M)); fields['Title']=next((s.strip() for s in header.splitlines() if s.strip()),'')
    author=re.search(r'^by (.+)$',header,re.M)
    if author:fields['Author']=author[1]
    # Preserve a full-work document when the lossy TXT format has no reliable chapter delimiters.
    objects=[obj('original.txt','source_text',data)]
    # Freeze Python's header/strip decision as an exact byte interval, including BOM.
    prefix=len(text[:header_end].encode())+(3 if data.startswith(b'\xef\xbb\xbf') else 0)
    tail=text[header_end:]
    offset=prefix+len(tail[:len(tail)-len(tail.lstrip())].encode())
    rendered=('<pre>'+html.escape(body)+'</pre>').encode()
    recipe=dict(schema='palimora-text-html-v1',offset=offset,length=len(body.encode()),size=len(data),output_size=len(rendered))
    derived=hashlib.sha256(rendered).hexdigest()
    return dict(external_id=identity(url[1]),metadata=fields,chapters=[dict(name='work.html',source_object='original.txt',transform=recipe,source_html_sha256=derived,source_url=None,scope='entire_work',source_chapter_count=fields.get('Chapters'))],objects=objects,state='valid' if body else 'partial',observed_at=None)
def html_record(data):
    text=data.decode('utf-8');metadata={}
    for field,value in re.findall(r'<b>([^<]+):</b>\s*</td>\s*<td>(.*?)</td>\s*</tr>',text,re.S|re.I):
        metadata[field]=value if field=='Summary' else html.unescape(re.sub('<[^>]+>','',value)).strip()
    canonical=re.search(r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)',text,re.I)
    preface=re.search(r'<div[^>]+id=["\']preface["\'][^>]*>.*?<p[^>]+class=["\']message["\'][^>]*>(.*?)</p>',text,re.S|re.I)
    work_id=identity(metadata.get('Story URL') or (canonical[1] if canonical else preface[1] if preface else None))
    if not work_id or not re.search(r'\buserstuff\b',text):raise Unsupported('Unsupported AO3 HTML structure')
    title=re.search(r'<title[^>]*>(.*?)</title>',text,re.S|re.I)
    if title:metadata['title']=[html.unescape(re.sub('<[^>]+>','',title[1]))]
    objects=[];chapter_refs=[];fragments=[];chapter_ranges=html_chapters(text)
    if not chapter_ranges:
        if not re.search('</html>',text,re.I) and re.search(r'<div[^>]+class=["\'][^"\']*\bstory\b',text,re.I):
            return dict(external_id=work_id,metadata=metadata,chapters=[],objects=[obj('document.html','document_html',data)],state='partial',observed_at=None)
        raise Unsupported('Unsupported AO3 HTML chapter structure')
    for index,(start,stop) in enumerate(chapter_ranges):
        original=text[start:stop];name='chapter'+str(index+1)+'.html';note_refs=[];pieces=[];end=0
        for n,(left,right) in enumerate(notes(original)):
            pieces.append(original[end:left]);note_name=name+'#note'+str(n);fragment=original[left:right].encode()
            objects.append(obj(note_name,'notes_html',fragment));note_refs.append(dict(name=note_name,offset=len(original[:left].encode()),length=len(fragment)));end=right
        pieces.append(original[end:]);objects.append(obj(name,'chapter_html',''.join(pieces).encode()))
        chapter_refs.append(dict(name=name,source_url=None,notes=note_refs,source_html_sha256=hashlib.sha256(original.encode()).hexdigest()))
        fragments.append((start,stop,name,'chapter_html'))
    for start,stop in notes(text):
        if any(start<b and stop>a for a,b,_,_ in fragments):continue
        name='work-note'+str(len(fragments))+'.html';objects.append(obj(name,'notes_html',text[start:stop].encode()));fragments.append((start,stop,name,'notes_html'))
    for index,style in enumerate(re.finditer(r'<style[^>]*>(.*?)</style>',text,re.S|re.I)):
        start,stop=style.span(1)
        if any(start<b and stop>a for a,b,_,_ in fragments):continue
        name='style'+str(index)+'.css';objects.append(obj(name,'css',style[1].encode()));fragments.append((start,stop,name,'css'))
    pieces=[];layout=[];end=0
    for start,stop,name,kind in sorted(fragments):
        pieces.append(text[end:start]);end=stop
        layout.append(dict(name=name,kind=kind,offset=len(text[:start].encode()),length=len(text[start:stop].encode())))
    pieces.append(text[end:]);objects.append(obj('document.html','document_html',''.join(pieces).encode()))
    expected=str(metadata.get('Chapters','')).split('/')[0].replace(',','').strip()
    partial=not re.search('</html>',text,re.I) or (expected.isdigit() and int(expected)!=len(chapter_refs))
    return dict(external_id=work_id,metadata=metadata,chapters=chapter_refs,objects=objects,state='partial' if partial else 'valid',observed_at=None,media_urls=sorted(resource_urls(text)),document=dict(schema='palimora-html-layout-v1',shell='document.html',source_html_sha256=hashlib.sha256(data).hexdigest(),fragments=layout))

def csv_records(data,entry,cursor,resume_row=0):
    # Original FanFicFare indexes can contain embedded newlines and very long summaries.
    csv.field_size_limit(sys.maxsize)
    reader=csv.DictReader(io.TextIOWrapper(data,encoding='utf-8-sig',newline=''),strict=True)
    if not {'Path','Title','Author','Story URL'}.issubset(reader.fieldnames or []):raise Unsupported('Unsupported CSV metadata columns')
    for row,m in enumerate(reader,1):
        if row<=resume_row:continue
        if None in m or any(v is None for v in m.values()):raise Unsupported('Inconsistent CSV metadata row '+str(row))
        emit(dict(cursor=cursor,checkpoint_detail=dict(row=row),locator=entry+':row:'+str(row),record=dict(external_id=identity(m.get('Story URL')),metadata=m,chapters=[],objects=[],state='metadata_only',observed_at=None,source_entry=m.get('Path') or None)))
def empty_7z(data):
    header=data.read(33)
    return len(header)==32 and header[:6]==b'7z\xbc\xaf\x27\x1c' and zlib.crc32(header[12:32])==struct.unpack('<I',header[8:12])[0] and header[12:]==bytes(20)
def run(path,start):
    global active_dir
    if path.endswith('.sqlite3'):
        c=sqlite3.connect('file:'+path+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON')
        tables={x[0] for x in c.execute("select name from sqlite_master where type='table'")}
        table='ao3_metadata' if 'ao3_metadata' in tables else 'metadata_full_old' if 'metadata_full_old' in tables else None
        if not table:raise Unsupported('Unsupported SQLite schema')
        columns={x[1] for x in c.execute('pragma table_info('+table+')')}
        if not {'Path','Title','Author'}.issubset(columns):raise Unsupported('Unsupported metadata columns')
        scope=json.loads(os.environ.get('PALIMORA_METADATA_SCOPE','[]'))
        condition='';args=[start]
        reconcile_file=os.environ.get('PALIMORA_RECONCILE_FILE')
        if reconcile_file:
            with open(reconcile_file) as f: ids=json.load(f)
            url_column='Story_URL' if 'Story_URL' in columns else 'StoryURL'
            condition=' AND '+url_column+' IN (SELECT value FROM json_each(?))'
            args.append(json.dumps(['https://archiveofourown.org/works/'+x for x in ids]+['http://archiveofourown.org/works/'+x for x in ids]))

        if scope and not reconcile_file:
            condition=' AND ('+' OR '.join('Path LIKE ?' for _ in scope)+')';args += [s+'/%' for s in scope]
        dependencies={}
        rows=c.execute('select rowid as _rowid,* from '+table+' where rowid>? AND rowid<1099511627776'+condition+' order by rowid',args) if start<1099511627776 else []
        if os.environ.get('PALIMORA_METADATA_CACHE') and start<1099511627776:
            from metadata_index import indexed_rows
            rows=indexed_rows(c,path,table,start,scope,ids if reconcile_file else None,lambda cursor:emit(dict(cursor=start,locator='metadata-index',index_progress=cursor)))
        for r in rows:
            m=dict(r);cursor=m.pop('_rowid');prefix=(m.get('Path') or '').split('/')[0];dependency=None
            if re.fullmatch(r'queue[0-9]+',prefix):
                if prefix not in dependencies:dependencies[prefix]=bool(glob.glob(os.path.join(os.path.dirname(path),prefix+'*.zip')))
                if not dependencies[prefix]:dependency=prefix+'.zip'
            emit(dict(cursor=cursor,locator=str(cursor),missing_dependency=dependency,record=dict(external_id=identity(m.get('Story_URL') or m.get('StoryURL')),metadata=m,chapters=[],objects=[],state='metadata_only',observed_at=None,source_entry=m.get('Path'))))
        if 'ao3_tags' in tables and not scope and not reconcile_file:
            for row in c.execute('select * from ao3_tags where id>? order by id',(max(0,start-1099511627776),)) if start<2199023255552 else []:emit(dict(cursor=1099511627776+row['id'],locator='tag:'+str(row['id']),tag=dict(row)))
        if 'stories' in tables and not scope and not reconcile_file:
            for row in c.execute('select rowid,* from stories where rowid>? order by rowid',(max(0,start-2199023255552),)):
                url=row['storyurl'];emit(dict(cursor=2199023255552+row['rowid'],locator='stories:'+str(row['rowid']),record=dict(external_id=identity(url),metadata={'Story URL':url},chapters=[],objects=[],state='metadata_only',observed_at=None,source_entry='stories:'+str(url))))
        return
    if not path.endswith('.zip'):raise Unsupported('Unsupported source')
    run_zip(path,start)

def parse_member(task):
    global active_dir
    i,name,size,digest,payload,directory=task
    active_dir=directory
    data=io.BytesIO(payload) if isinstance(payload,bytes) else open(payload,'rb')
    try:
        ext=name.rsplit('.',1)[-1].lower()
        if ext=='epub':record=epub(data)
        elif ext in ('html','htm'):record=html_record(data.read())
        elif ext=='txt':
            prefix=data.read(131072);data.seek(0)
            if not re.search(rb'^Story URL: https?://',prefix,re.M):
                if not re.match(r'(?:log_|manifest_|last_good|screen_|README|readme)',posixpath.basename(name)):raise Unsupported('Unrecognized text structure')
                return dict(cursor=i+1,locator=name,artifacts=stream_asset(data,name),bytes=size)
            record=text_record(data.read())
        elif ext in ('log','tsv','json') or (ext=='7z' and empty_7z(data)):
            data.seek(0);return dict(cursor=i+1,locator=name,artifacts=stream_asset(data,name),bytes=size)
        else:
            prefix=data.read(131072);data.seek(0)
            if re.search(rb'^Story URL: https?://',prefix,re.M):record=text_record(data.read())
            elif prefix.startswith(b'PK\x03\x04'):record=epub(data)
            elif re.search(rb'<html\b',prefix,re.I):record=html_record(data.read())
            else:raise Unsupported('Unsupported ZIP member structure: '+ext)
        record['source_hash']=digest
        return dict(cursor=i+1,locator=name,record=record,bytes=size)
    except (zipfile.BadZipFile,EOFError,ET.ParseError,UnicodeDecodeError,KeyError) as e:
        return dict(cursor=i+1,locator=name,gap='corrupt_source',detail=str(e))
    except OSError:raise
    except Exception:return dict(cursor=i,locator=name,blocked=dict(code='parser_unsupported',trace=traceback.format_exc()))
    finally:
        data.close();close_segment();active_dir=None

def stream_asset(data,name):
    class Member:
        def open(self,_):return data
    return asset(Member(),name,'source_auxiliary')

def run_zip(path,start):
    global active_dir
    from zip_admission import open_zip
    workers=max(1,min(16,int(os.environ.get('INGEST_PARSER_WORKERS','2'))))
    # The parent reads outer ZIP entries sequentially; processes parse bounded
    # windows concurrently. Results are emitted in source order, never completion order.
    with open_zip(path) as z, ProcessPoolExecutor(max_workers=workers,mp_context=multiprocessing.get_context('spawn')) as executor:
        entries=z.infolist()
        emit(dict(total=None if any(e.filename.lower().endswith('.csv') for e in entries) else len(entries),cursor=start,locator='inventory'))
        window=[];window_bytes=0;window_directory=None
        def consume():
            global active_dir
            if not window:return False
            cache={}
            if os.environ.get('PALIMORA_ADAPTER_CACHE')=='1':
                if not os.environ.get('PALIMORA_CACHE_FD'):flush_records();drain()
                wire(dict(schema='palimora.ingest.cache.v1',parser=VERSION,hashes=[t[3] for t in window]),ack=False)
                line=(cache_input if cache_input else sys.stdin).readline()
                if not line:raise SystemExit(0)
                cache=json.loads(line)
            futures=[None if t[3] in cache else executor.submit(parse_member,t) for t in window]
            try:
                for task,future in zip(window,futures):
                    i,name,size,digest,payload,directory=task
                    active_dir=directory
                    result=future.result() if future else dict(cursor=i+1,locator=name,bytes=size,record=cache[digest])
                    emit(result)
                    if active_dir and not retained(active_dir):cleanup_staging(active_dir)
                    active_dir=None
                    if 'blocked' in result:return True
                for directory in {t[5] for t in window}:
                    parsing_dirs.discard(directory)
                    if not retained(directory):cleanup_staging(directory,ignore_errors=True)
                return False
            finally:
                # Each process owns its segment until its result is consumed.
                for future in futures:
                    if future and not future.done():future.cancel()
        try:
            for i,entry in enumerate(entries):
                if i<start:continue
                special=entry.is_dir() or entry.filename.lower().endswith('.csv')
                if window and (special or len(window)>=GROUP_SIZE or window_bytes+entry.file_size>GROUP_BYTES):
                    if consume():return
                    window=[];window_bytes=0;window_directory=None
                if entry.is_dir():emit(dict(cursor=i+1,locator=entry.filename,skip=True));continue
                if special:
                    directory=tempfile.mkdtemp(prefix='adapter-',dir=STAGING)
                else:
                    if window_directory is None:
                        window_directory=tempfile.mkdtemp(prefix='adapter-',dir=STAGING)
                        parsing_dirs.add(window_directory)
                    directory=window_directory
                active_dir=directory if STAGING else None
                try:
                    # Small members stay in memory; large members spill to disk.
                    with tempfile.SpooledTemporaryFile(max_size=8*1024*1024,dir=directory) as data:
                        digest=hashlib.sha256()
                        with z.open(entry) as src:
                            while True:
                                chunk=src.read(CHUNK)
                                if not chunk:break
                                ensure_space(len(chunk));digest.update(chunk);data.write(chunk)
                        data.seek(0)
                        if special:
                            resume=json.loads(os.environ.get('PALIMORA_ENTRY_CURSOR','{}')).get('row',0) if i==start else 0
                            # csv_records owns its TextIOWrapper; use a separate view.
                            with tempfile.TemporaryFile(dir=directory) as csv_data:
                                ensure_space(entry.file_size);shutil.copyfileobj(data,csv_data);csv_data.seek(0);csv_records(csv_data,entry.filename,i,resume)
                            data.seek(0)
                            emit(dict(cursor=i+1,locator=entry.filename,artifacts=stream_asset(data,entry.filename),bytes=entry.file_size))
                        else:
                            if entry.file_size<=8*1024*1024:payload=data.read()
                            else:
                                payload=os.path.join(directory,'source-'+str(i)+'.member')
                                ensure_space(entry.file_size)
                                with open(payload,'xb') as out:shutil.copyfileobj(data,out)
                            window.append((i,entry.filename,entry.file_size,digest.hexdigest(),payload,directory));window_bytes+=entry.file_size
                except (zipfile.BadZipFile,EOFError,UnicodeDecodeError) as e:
                    if consume():return
                    window=[];window_bytes=0;window_directory=None
                    emit(dict(cursor=i+1,locator=entry.filename,gap='corrupt_source',detail=str(e)))
                except OSError:raise
                except Exception:
                    if consume():return
                    window=[];window_bytes=0;window_directory=None
                    emit(dict(cursor=i,locator=entry.filename,blocked=dict(code='parser_unsupported',trace=traceback.format_exc())));return
                finally:
                    close_segment()
                    if directory and not retained(directory) and not any(t[5]==directory for t in window):cleanup_staging(directory,ignore_errors=True)
                    active_dir=None
            consume()
        finally:
            # Complete/cancel children before unlinking their private staging.
            executor.shutdown(wait=True,cancel_futures=True)
            for directory in list(parsing_dirs):
                parsing_dirs.discard(directory)
                if not retained(directory):cleanup_staging(directory,ignore_errors=True)
            for task in window:
                if not retained(task[5]):cleanup_staging(task[5],ignore_errors=True)
if __name__=='__main__':
    try:
        run(sys.argv[1],int(sys.argv[2]))
        flush_records();drain()
    except (zipfile.BadZipFile,sqlite3.DatabaseError,EOFError) as e:emit(dict(gap='corrupt_source',detail=str(e),cursor=int(sys.argv[2]),locator='source'))
    except FileNotFoundError:emit(dict(gap='missing_source',cursor=int(sys.argv[2]),locator='source'))
    except OSError as e:emit(dict(io_error=e.errno,message=str(e),cursor=int(sys.argv[2]),locator='source'))
    except Exception:emit(dict(blocked=dict(code='parser_unsupported',trace=traceback.format_exc()),cursor=int(sys.argv[2]),locator='source'))
