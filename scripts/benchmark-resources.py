#!/usr/bin/env python3
"""Sample only named disposable release containers via Docker's local API."""
import http.client, socket, json, time, sys, signal
class Docker(http.client.HTTPConnection):
    def __init__(self): super().__init__('localhost', timeout=5)
    def connect(self): self.sock=socket.socket(socket.AF_UNIX); self.sock.connect('/var/run/docker.sock')
active=True
def stop(*_):
    global active
    active=False
signal.signal(signal.SIGTERM,stop)
names=sys.argv[2:]
if not names or any(not n.startswith('palimora-release-test-') for n in names): raise SystemExit('Release test containers only')
with open(sys.argv[1],'w') as out:
    while active:
        started=time.monotonic()
        for name in names:
            c=Docker()
            try:
                c.request('GET',f'/containers/{name}/stats?stream=false&one-shot=true'); r=c.getresponse(); v=json.load(r)
                if r.status==200:
                    m=v.get('memory_stats',{}); cache=m.get('stats',{}).get('inactive_file',0)
                    out.write(json.dumps(dict(time=time.time(),container=name,cpu_ns=v['cpu_stats']['cpu_usage']['total_usage'],memory_bytes=m.get('usage',0),working_bytes=max(0,m.get('usage',0)-cache),io=v.get('blkio_stats',{}).get('io_service_bytes_recursive',[]),network=v.get('networks',{})))+'\n');out.flush()
            except (OSError,ValueError,KeyError): pass
            finally:c.close()
        time.sleep(max(.05,1-(time.monotonic()-started)))
