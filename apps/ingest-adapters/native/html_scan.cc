// Offset-preserving HTML fast path. No DOM rewriting.
// Ambiguous lexical forms return FALLBACK for the existing Python parser.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <new>
#include <string>
#include <string_view>
#include <vector>
using View=std::string_view;
struct Item {size_t kind,start,end;};
struct Result {int status;size_t count;Item* items;};
struct Frame {std::string tag;size_t start;bool capture;bool chapters;};
static bool ws(unsigned char c){return c==' '||(c>=9&&c<=13)||(c>=28&&c<=31);}
static bool alpha(unsigned char c){return (c>='a'&&c<='z')||(c>='A'&&c<='Z');}
static bool namechar(unsigned char c){return alpha(c)||(c>='0'&&c<='9')||c==':'||c=='_'||c=='-';}
static unsigned char lower(unsigned char c){return c>='A'&&c<='Z'?c+32:c;}
static bool equal(View a,View b){if(a.size()!=b.size())return false;for(size_t i=0;i<a.size();i++)if(lower(a[i])!=b[i])return false;return true;}
static std::string lowered(View a){std::string s(a);for(char& c:s)c=lower(c);return s;}
static bool token(View value,View word){size_t pos=0;while(pos<value.size()){while(pos<value.size()&&ws(value[pos]))pos++;size_t start=pos;while(pos<value.size()&&!ws(value[pos]))pos++;if(value.substr(start,pos-start)==word)return true;}return false;}
static bool plain(View a){for(unsigned char c:a)if(c>=128||c=='&')return false;return true;}
static bool noteid(View s){if(s.substr(0,8)!="endnotes")return false;for(size_t n=8;n<s.size();n++)if(s[n]<'0'||s[n]>'9')return false;return true;}
static bool voidtag(View tag){return tag=="area"||tag=="base"||tag=="br"||tag=="col"||tag=="embed"||tag=="hr"||tag=="img"||tag=="input"||tag=="link"||tag=="meta"||tag=="param"||tag=="source"||tag=="track"||tag=="wbr";}
static bool resource(View tag){return tag=="img"||tag=="audio"||tag=="video"||tag=="source"||tag=="track"||tag=="embed"||tag=="iframe"||tag=="object"||tag=="a";}
static bool scan(View s,int mode,bool resources,std::vector<Item>& out){
 std::vector<Frame> stack;stack.reserve(64);size_t position=0,captured=0;
 while(true){
  const size_t left=s.find('<',position);if(left==View::npos)return true;
  size_t p=left+1;if(p>=s.size())return false;
  if(s.substr(left,4)=="<!--") {auto end=s.find("--",left+4);if(end==View::npos||end+2>=s.size()||s[end+2]!='>')return false;
   position=end+3;continue;}
  if(s[p]=='!'||s[p]=='?'){
   if(s[p]=='!'&&!(s.size()>p+8&&equal(s.substr(p+1,7),"doctype")&&ws(s[p+8])))return false;
   auto end=s.find('>',p+1);if(end==View::npos)return false;
   position=end+1;continue;
  }
  bool closing=s[p]=='/';if(closing)p++;
  if(p>=s.size()||!alpha(s[p]))return false;
  size_t name=p++;while(p<s.size()&&namechar(s[p]))p++;
  const auto tag=lowered(s.substr(name,p-name));
  if(p<s.size()&&!ws(s[p])&&s[p]!='>'&&s[p]!='/')return false;
  if(closing){
   while(p<s.size()&&ws(s[p]))p++;
   if(p>=s.size()||s[p]!='>')return false;
   position=p+1;
   for(size_t i=stack.size();i>0;i--)if(stack[i-1].tag==tag){
    const auto opened=stack[i-1];if(opened.capture)out.push_back({0,opened.start,position});
    for(size_t j=i-1;j<stack.size();j++)captured-=stack[j].capture;
    stack.resize(i-1);break;
   }
   continue;
  }
  View classes,id;bool style=false,selfclosing=false,ended=false;
  while(p<s.size()){
   while(p<s.size()&&ws(s[p]))p++;
   if(p>=s.size())return false;
   if(s[p]=='>'){p++;ended=true;break;}
   if(s[p]=='/'&&p+1<s.size()&&s[p+1]=='>'){p+=2;selfclosing=true;ended=true;break;}
   size_t attr=p;while(p<s.size()&&namechar(s[p]))p++;
   if(attr==p)return false;
   const View attrname=s.substr(attr,p-attr);
   while(p<s.size()&&ws(s[p]))p++;
   View value;
   if(p<s.size()&&s[p]=='='){
    p++;while(p<s.size()&&ws(s[p]))p++;if(p>=s.size()||s[p]=='=')return false;
    if(s[p]=='\''||s[p]=='"'){
     const char quote=s[p++];size_t value_start=p;auto end=s.find(quote,p);if(end==View::npos)return false;
     value=s.substr(value_start,end-value_start);p=end+1;
    }else{
     size_t value_start=p;while(p<s.size()&&!ws(s[p])&&s[p]!='>'){if(s[p]=='<'||s[p]=='\''||s[p]=='"')return false;p++;}
     if(p==value_start)return false;
     value=s.substr(value_start,p-value_start);
    }
   }
   if(equal(attrname,"class")){if(!plain(value))return false;classes=value;}
   if(equal(attrname,"id")){if(!plain(value))return false;id=value;}
   if(equal(attrname,"style"))style=true;
  }
  if(!ended)return false;
   position=p;
  if(resources&&(resource(tag)||style))out.push_back({1,left,p});
  if(selfclosing||voidtag(tag))continue;
  bool capture=false;
  if(!captured){
   if(mode==1)capture=noteid(id)||token(classes,"notes")||token(classes,"endnotes")||token(classes,"fff_chapter_notes")||token(classes,"fff_head_notes")||token(classes,"fff_foot_notes");
   if(mode==2)capture=tag=="div"&&(token(classes,"story")||(token(classes,"userstuff")&&!stack.empty()&&stack.back().chapters));
  }
  if(mode){stack.push_back({tag,left,capture,id=="chapters"});captured+=capture;if(stack.size()>65536)return false;}
  if(tag=="script"||tag=="style"){
   size_t next=position;
   while(true){next=s.find("</",next);if(next==View::npos)return true;size_t end=next+2+tag.size();
    if(end<=s.size()&&equal(s.substr(next+2,tag.size()),tag)){
     size_t q=end;while(q<s.size()&&ws(s[q]))q++;if(q<s.size()&&static_cast<unsigned char>(s[q])>=128)return false;if(q<s.size()&&s[q]=='>'){position=next;break;}
    }
    next+=2;
   }
  }
 }
}
extern "C" Result* palimora_scan(const char* text,size_t size,int mode,int resources){
 Result* r=new(std::nothrow) Result{2,0,nullptr};if(!r)return nullptr;
 try {std::vector<Item> items;if(!scan(View(text,size),mode,resources,items)){r->status=1;return r;}
  r->items=new Item[items.size()];std::copy(items.begin(),items.end(),r->items);r->count=items.size();r->status=0;
 } catch(...){r->status=2;}
 return r;
}
extern "C" void palimora_scan_free(Result* r){if(r){delete[] r->items;delete r;}}
