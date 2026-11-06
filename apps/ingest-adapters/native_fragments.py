"""Offset-preserving native scan; original parser handles ambiguous HTML."""
import ctypes,os
from pathlib import Path
from html.parser import HTMLParser
import html_fragments as reference

class Item(ctypes.Structure):_fields_=[('kind',ctypes.c_size_t),('start',ctypes.c_size_t),('end',ctypes.c_size_t)]
class Result(ctypes.Structure):_fields_=[('status',ctypes.c_int),('count',ctypes.c_size_t),('items',ctypes.POINTER(Item))]
lib=ctypes.CDLL(os.environ.get('PALIMORA_NATIVE_SCAN_LIBRARY', str(Path(__file__).parent/'native/build/html_scan.so')))
lib.palimora_scan.argtypes=[ctypes.c_char_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_int]
lib.palimora_scan.restype=ctypes.POINTER(Result)
lib.palimora_scan_free.argtypes=[ctypes.POINTER(Result)]
counts={'calls':0,'fallbacks':0}
class Attributes(HTMLParser):
    def __init__(self,resources):super().__init__(convert_charrefs=False);self.resources=resources
    def handle_starttag(self,tag,attrs):self.resources.visit(tag,dict(attrs))
    def handle_startendtag(self,tag,attrs):self.handle_starttag(tag,attrs)
def analyze(text,mode,with_resources):
    counts['calls']+=1
    encoded=text.encode('utf-8');raw=lib.palimora_scan(encoded,len(encoded),mode,with_resources)
    if not raw:raise MemoryError('Native scan allocation')
    try:
        result=raw.contents
        if result.status==2:raise MemoryError('Native scan allocation')
        if result.status==1:
            counts['fallbacks']+=1
            if mode==1:return reference.notes_and_resources(text) if with_resources else reference.notes(text)
            if mode==2:return reference.chapters(text)
            return reference.resource_urls(text)
        positions=[];resources=reference.Resources() if with_resources else None
        parser=Attributes(resources) if resources else None
        byte_ranges=[]
        for i in range(result.count):
            item=result.items[i]
            if item.kind==0:byte_ranges.append((item.start,item.end))
            elif parser:
                parser.reset();parser.feed(encoded[item.start:item.end].decode('utf-8'))
        # Convert only the few captured boundaries; no per-character Python map.
        boundary=sorted({p for pair in byte_ranges for p in pair});mapping={};previous=0;characters=0
        for p in boundary:
            characters+=len(encoded[previous:p].decode('utf-8'));mapping[p]=characters;previous=p
        positions=sorted((mapping[start],mapping[end]) for start,end in byte_ranges)
        if resources:
            found=resources.finish(text)
            return (positions,found) if mode==1 else found
        return positions
    finally:lib.palimora_scan_free(raw)
def notes(text):return analyze(text,1,False)
def notes_and_resources(text):return analyze(text,1,True)
def chapters(text):return analyze(text,2,False)
def resource_urls(text):return analyze(text,0,True)
def install():
    import ao3
    ao3.notes=notes;ao3.notes_and_resources=notes_and_resources;ao3.html_chapters=chapters;ao3.resource_urls=resource_urls
