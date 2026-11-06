"""Read-only differential and timed comparison against the shipped AO3 adapter."""
import sys,os,zipfile,io,json,hashlib,time,random,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/ingest-adapters'))
os.environ['PALIMORA_HTML_SCANNER']='python'
import ao3,html_fragments as reference,native_fragments as native
source=sys.argv[1]
with zipfile.ZipFile(source) as z:payloads=[(e.filename,z.read(e)) for e in z.infolist() if e.filename.lower().endswith('.epub')]
texts=[]
for _,data in payloads:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        texts.extend(z.read(e).decode('utf-8') for e in z.namelist() if e.endswith(('.xhtml','.html')))
# Meaningful edge cases: offsets, tolerant syntax, nested/mismatched tags, raw text,
# escaped attributes, Unicode whitespace and URL extraction from attributes/CSS.
cases=[
    '<p>à🐈\u2028</p><div class=notes>è<br/>n</div >',
    '<div class="story"><div class=notes>A</div><p>B</div>',
    '<div id="chapters"><div class="userstuff">c</div></div>',
    '<div class="notes"><div class="notes">n</div></div>',
    '<div class="notes"><span>x</div></span>',
    '<!-- <div class=notes>x</div> --><div id=endnotes3>x</div>',
    '<script style="color:red">"<div class=notes>x</div>"</script><img src="https://a/b.png">',
    '<style>div:before{content:"<b>"}x{background:url(https://a/b.png)}</style>',
    '<div class="not&#101;s">x</div><div class="a\u00a0notes">n</div>',
    '<img src="https://a/b?a=1&amp;b=2" srcset="https://a/x 1x, //a/y 2x"><a download href="//a/z">d</a>',
    '<a href="https://a/work">x</a><a href="//a/file.PDF?q=1">f</a>',
    '<div class=notes/>x</div><div class="notes"/>y',
    '<div id=endnotes class=other class=notes>x</div>',
    '<!doctype html><?pi x?><div class=notes>x</div>',
    '<div class=notes>unfinished',
    '<!-- a --   ><div class=notes>x</div><!-- y -->',
    '<script class=notes>x</script\u00a0>',
    'x < y <div class=notes>x</div>',
]
rng=random.Random(1928)
for i in range(1000):
    tag=rng.choice(['div','span','section','p','script','style'])
    attrs=rng.choice([' class=notes',' id=endnotes2',' class="a notes"',' class=notes/',' class="not&#101;s"',' class="notes" id="endnotes"',' style="background:url(https://a/b)"',' class="story"',' class="userstuff"',''])
    closing=rng.choice(['</'+tag+'>','</'+tag+' >','</div>',''])
    cases.append(rng.choice(['','<div id=chapters>','<div class=notes>','<!-- x -->'])+'à<'+tag+attrs+'>'+rng.choice(['a','🐈','<b>a</b>','<img src="//a/x">'])+closing)
edge_counts=None
for i,text in enumerate(cases+texts):
    if i==len(cases):edge_counts=dict(native.counts)
    for method in ['notes_and_resources','chapters']:
        a=getattr(reference,method)(text);b=getattr(native,method)(text)
        if a!=b:raise AssertionError({'document':i,'method':method,'reference':str(a)[:500],'native':str(b)[:500]})
print(json.dumps({'parity_documents':len(texts),'edge_cases':len(cases),'native':native.counts,'edge_counts':edge_counts}),flush=True)
parity_counts=dict(native.counts)
reports=[]
for repetition in range(3):
    for name,module in ([('current',reference),('native',native)] if repetition%2==0 else [('native',native),('current',reference)]):
        start=time.perf_counter();cpu=time.process_time()
        for text in texts:module.notes_and_resources(text)
        reports.append({'stage':'html_scan','implementation':name,'repetition':repetition,'seconds':time.perf_counter()-start,'cpu_seconds':time.process_time()-cpu,'documents':len(texts)})
original={name:getattr(ao3,name) for name in ['notes','notes_and_resources','html_chapters','resource_urls']}
hashes={}
for repetition in range(3):
    for name in (['current','native'] if repetition%2==0 else ['native','current']):
        if name=='native':native.install()
        else:
            for k,v in original.items():setattr(ao3,k,v)
        elapsed=0;cpu=0;digests=[]
        for member,data in payloads:
            start=time.perf_counter();c=time.process_time();record=ao3.epub(io.BytesIO(data));elapsed+=time.perf_counter()-start;cpu+=time.process_time()-c
            digests.append(hashlib.sha256(json.dumps(record,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest())
        digest=hashlib.sha256(''.join(digests).encode()).hexdigest();hashes[name]=digest
        assert len(set(hashes.values()))==1,'Changed parsed result across implementations/repetitions'
        reports.append({'stage':'epub_parse_inline','implementation':name,'repetition':repetition,'seconds':elapsed,'cpu_seconds':cpu,'records':len(payloads),'rate':len(payloads)/elapsed,'results_hash':digest})
        print(json.dumps(reports[-1]),flush=True)
assert hashes['current']==hashes['native']
report={'source':os.path.basename(source),'records':len(payloads),'html_documents':len(texts),'edge_cases':len(cases),'native_counts':native.counts,'parity_counts':parity_counts,'edge_counts':edge_counts,'results_hash':hashes['current'],'measurements':reports}
output=os.environ.get('PALIMORA_NATIVE_REPORT')
if output:Path(output).write_text(json.dumps(report,indent=2))
for stage in ['html_scan','epub_parse_inline']:
    medians={name:statistics.median(r['seconds'] for r in reports if r['stage']==stage and r['implementation']==name) for name in ['current','native']}
    print(json.dumps({'stage':stage,'median_seconds':medians,'speedup':medians['current']/medians['native']}),flush=True)
