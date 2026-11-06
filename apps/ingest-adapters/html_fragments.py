"""Exact-byte extraction with a shared HTML pass. No HTML execution or serialization."""
from html.parser import HTMLParser
import re
VOID={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
NOTE_CLASSES={'notes','endnotes','fff_chapter_notes','fff_head_notes','fff_foot_notes'}
ENDNOTES=re.compile(r'endnotes[0-9]*')
EXTERNAL=re.compile(r'^(?:https?:)?//')
CSS_URL=re.compile(r'url\(\s*["\x27]?([^\)"\x27]+)')
MEDIA_EXT=re.compile(r'\.(?:png|jpe?g|gif|webp|svg|avif|mp[34]|m4a|ogg|wav|webm|pdf)$',re.I)
class Resources:
    def __init__(self):self.found=set()
    def add(self,value):
        if value and EXTERNAL.match(value):self.found.add(value)
    def visit(self,tag,a):
        if not a:return
        if tag in {'img','audio','video','source','track','embed','iframe'}:
            self.add(a.get('src'));self.add(a.get('poster'))
            for candidate in (a.get('srcset') or '').split(','):
                if candidate.strip():self.add(candidate.strip().split()[0])
        if tag=='object':self.add(a.get('data'))
        if tag=='a':
            href=a.get('href') or ''
            if 'download' in a or MEDIA_EXT.search(href.split('?',1)[0].split('#',1)[0]):self.add(href)
        if a.get('style'):
            for match in CSS_URL.finditer(a['style']):self.add(match[1].strip())
    def finish(self,text):
        for match in CSS_URL.finditer(text):self.add(match[1].strip())
        return self.found

def reference_ranges(text,predicate,resources=None):
    offsets=[0]
    for line in text.split('\n'):offsets.append(offsets[-1]+len(line)+1)
    class Parser(HTMLParser):
        def __init__(self):super().__init__(convert_charrefs=False);self.stack=[];self.ranges=[]
        def absolute_position(self):row,col=self.getpos();return offsets[row-1]+col
        def handle_starttag(self,tag,attrs):
            attrs=dict(attrs)
            if resources:resources.visit(tag,attrs)
            if tag in VOID:return
            capture=bool(predicate and predicate(tag,attrs,self.stack)) and not any(x[2] for x in self.stack)
            self.stack.append((tag,self.absolute_position() if capture else 0,capture,attrs))
        def handle_startendtag(self,tag,attrs):
            if resources:resources.visit(tag,dict(attrs))
        def handle_endtag(self,tag):
            if self.stack and self.stack[-1][0]==tag:opened=self.stack.pop()
            else:
                index=next((i for i in range(len(self.stack)-1,-1,-1) if self.stack[i][0]==tag),None)
                if index is None:return
                opened=self.stack[index];self.stack=self.stack[:index]
            if opened[2]:self.ranges.append((opened[1],text.index('>',self.absolute_position())+1))
    p=Parser();p.feed(text);return sorted(p.ranges)
def ranges(text,predicate,resources=None):
    from html_scan import scan, Fallback
    try:return scan(text,predicate,resources)
    except Fallback:
        if resources:resources.found.clear()
        return reference_ranges(text,predicate,resources)
def is_note(tag,attrs,parents):
    return bool(attrs.get('class') and NOTE_CLASSES.intersection(attrs['class'].split())) or bool(attrs.get('id') and ENDNOTES.fullmatch(attrs['id']))
def notes(text):return ranges(text,is_note)
def notes_and_resources(text):
    resources=Resources()
    fragments=ranges(text,is_note,resources)
    return fragments,resources.finish(text)
def chapters(text):
    return ranges(text,lambda tag,attrs,parents: tag=='div' and ('story' in (attrs.get('class') or '').split() or ('userstuff' in (attrs.get('class') or '').split() and bool(parents) and parents[-1][3].get('id')=='chapters')))
def resource_urls(text):
    resources=Resources()
    ranges(text,None,resources)
    return resources.finish(text)
