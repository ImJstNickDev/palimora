"""Offset-preserving scanner using CPython's native regular-expression engine.

Only well-formed lexical tokens take the fast path. Unusual or ambiguous HTML is
handed back to HTMLParser, which remains the reference for tolerant parsing.
"""
import re
import html
from html.parser import attrfind_tolerant

TOKEN=re.compile(r'''<!--.*?--\s*>|<![^>]*>|<\?[^>]*>|</?([a-zA-Z][a-zA-Z0-9:_-]*)(\s+(?:[^<>"']|"[^"]*"|'[^']*')*|\s*/?)>''',re.S)
ATTR=re.compile(r'\b(?:class|id|src|poster|srcset|data|href|download|style)\b',re.I)
RAW_END={tag:re.compile(r'</'+tag+r'\s*>',re.I) for tag in ('script','style')}
VOID={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
INTERESTING={'img','audio','video','source','track','embed','iframe','object','a'}
class Fallback(Exception):pass

def scan(text,predicate=None,resources=None):
    stack=[];ranges=[];captured=0;pos=0
    while True:
        left=text.find('<',pos)
        if left<0:break
        token=TOKEN.match(text,left)
        if not token:raise Fallback()
        end=token.end();tag=token[1];pos=end
        if not tag:
            # HTMLParser has special treatment for malformed comments/declarations.
            if text.startswith('<!--',left):
                if not text[left:end].endswith('-->'):raise Fallback()
            elif not re.match(r'<!DOCTYPE\s',text[left:end],re.I) and not text.startswith('<?',left):raise Fallback()
            continue
        tag=tag.lower()
        if text[left+1]=='/':
            if token[2].strip():raise Fallback()
            index=next((i for i in range(len(stack)-1,-1,-1) if stack[i][0]==tag),None)
            if index is not None:
                opened=stack[index]
                captured-=sum(1 for item in stack[index:] if item[2]);del stack[index:]
                if opened[2]:ranges.append((opened[1],end))
            continue
        raw=token[2];selfclosing=raw.endswith('/')
        if selfclosing and len(raw)>1 and not (raw[-2].isspace() or raw[-2] in ('\"',"'")):raise Fallback()
        attrs={}
        # Predicates need class/id only, resources need a small subset of attrs.
        if (predicate and ('class' in raw.lower() or 'id' in raw.lower())) or (resources and (tag in INTERESTING or 'style' in raw.lower())):
            offset=left+1+len(token[1])
            while offset<end-1 and text[offset].isspace():offset+=1
            while offset<end-1:
                match=attrfind_tolerant.match(text,offset)
                if not match:
                    if text[offset:end-1].strip() not in ('','/'):raise Fallback()
                    break
                name,equals,value=match.group(1,2,3)
                if not equals:value=None
                elif value and value[:1]==value[-1:] and value[:1] in ('"',"'"):value=value[1:-1]
                if value:value=html.unescape(value)
                attrs[name.lower()]=value;offset=match.end()
        if resources:resources.visit(tag,attrs)
        if selfclosing or tag in VOID:continue
        capture=bool(predicate and not captured and predicate(tag,attrs,stack))
        stack.append((tag,left if capture else 0,capture,attrs));captured+=int(capture)
        if tag in RAW_END:
            ending=RAW_END[tag].search(text,pos)
            if not ending:break
            pos=ending.start()
    return sorted(ranges)
