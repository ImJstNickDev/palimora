"""Resumable derived URL/path index. Original dump databases remain read-only."""
import hashlib,json,os,sqlite3,shutil,re

def indexed_rows(source,path,table,start,scope,ids,progress):
    root=os.environ.get('PALIMORA_METADATA_CACHE')
    if not root:
        raise RuntimeError('Metadata cache directory is required for scoped SQLite ingestion')
    os.makedirs(root,exist_ok=True)
    stat=os.stat(path)
    identity=json.dumps([os.path.realpath(path),stat.st_size,stat.st_mtime_ns,table,'metadata-index-2'])
    cache_path=os.path.join(root,hashlib.sha256(identity.encode()).hexdigest()+'.sqlite3')
    try:cache=sqlite3.connect(cache_path)
    except sqlite3.Error as error:
        raise OSError(28 if (getattr(error,'sqlite_errorcode',0)&255)==sqlite3.SQLITE_FULL else 5,'Cannot open derived metadata index') from error
    discard=False
    try:
        cache.execute('PRAGMA journal_mode=WAL');cache.execute('PRAGMA synchronous=FULL');cache.execute('PRAGMA cache_size=-32768')
        cache.execute('CREATE TABLE IF NOT EXISTS status(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,complete INTEGER NOT NULL)')
        cache.execute('INSERT OR IGNORE INTO status VALUES(1,0,0)')
        cache.execute('CREATE TABLE IF NOT EXISTS metadata(row_id INTEGER PRIMARY KEY,url TEXT,prefix TEXT,evidence TEXT NOT NULL)')
        cache.execute('CREATE INDEX IF NOT EXISTS metadata_url ON metadata(url,row_id)')
        cache.execute('CREATE INDEX IF NOT EXISTS metadata_prefix ON metadata(prefix,row_id)')
        cache.commit()
        cursor,complete=cache.execute('SELECT cursor,complete FROM status').fetchone()
        # Replay the already indexed prefix before continuing a partial build.
        if ids is not None:
            query='SELECT row_id,evidence FROM metadata WHERE url IN (SELECT value FROM json_each(?)) AND row_id>? ORDER BY row_id';args=(json.dumps(ids),start)
        elif scope:
            query='SELECT row_id,evidence FROM metadata WHERE prefix IN (SELECT value FROM json_each(?)) AND row_id>? ORDER BY row_id';args=(json.dumps(scope),start)
        else:
            query='SELECT row_id,evidence FROM metadata WHERE row_id>? ORDER BY row_id';args=(start,)
        for rowid,evidence in cache.execute(query,args):yield dict(_rowid=rowid,**json.loads(evidence))
        if complete:return
        wanted_ids=set(ids) if ids is not None else None;wanted_prefixes=set(scope)
        try:rows=source.execute('SELECT rowid AS _rowid,* FROM '+table+' WHERE rowid>? AND rowid<1099511627776 ORDER BY rowid',(cursor,))
        except sqlite3.Error as error:
            error.source_database=True;raise
        while True:
            try:batch=rows.fetchmany(4096)
            except sqlite3.Error as error:
                error.source_database=True;raise
            if not batch:break
            if shutil.disk_usage(root).free<int(os.environ.get('ARCHIVE_RESERVE_BYTES','268435456'))+16*1024*1024:raise OSError(28,'Insufficient metadata cache space')
            values=[]
            for row in batch:
                m=dict(row);rowid=m.pop('_rowid');url=m.get('Story_URL') or m.get('StoryURL') or m.get('Story URL');match=re.search(r'https?://(?:www\.)?archiveofourown\.org/works/(\d+)',str(url or ''));url=match[1] if match else None;prefix=(m.get('Path') or '').split('/')[0]
                values.append((rowid,url,prefix,json.dumps(m,separators=(',',':'))))
            with cache:
                cache.executemany('INSERT INTO metadata VALUES(?,?,?,?)',values)
                cache.execute('UPDATE status SET cursor=? WHERE id=1',(values[-1][0],))
            progress(values[-1][0])
            for rowid,url,prefix,evidence in values:
                selected=url in wanted_ids if wanted_ids is not None else (not wanted_prefixes or prefix in wanted_prefixes)
                if rowid>start and selected:yield dict(_rowid=rowid,**json.loads(evidence))
        after=os.stat(path)
        if (stat.st_size,stat.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise OSError('Source changed during metadata indexing')
        with cache:cache.execute('UPDATE status SET complete=1 WHERE id=1')
        cache.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    except sqlite3.Error as error:
        if getattr(error,'source_database',False):raise
        code=getattr(error,'sqlite_errorcode',0)&255
        if code==sqlite3.SQLITE_FULL:raise OSError(28,'Insufficient metadata cache space') from error
        if code in (sqlite3.SQLITE_CORRUPT,sqlite3.SQLITE_NOTADB):
            discard=True
            raise OSError(5,'Derived metadata index damaged; rebuilding on retry') from error
        if code in (sqlite3.SQLITE_IOERR,sqlite3.SQLITE_CANTOPEN):raise OSError(5,'Metadata cache I/O unavailable') from error
        raise RuntimeError('Metadata index failure: '+str(error)) from error
    finally:
        cache.close()
        if discard:
            for suffix in ('','-wal','-shm'):
                try:os.unlink(cache_path+suffix)
                except FileNotFoundError:pass
