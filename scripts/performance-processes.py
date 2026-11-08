#!/usr/bin/env python3
"""Private /proc sampling inside the benchmark container, without command lines."""
import glob, json, os, signal, time
active = True
def stop(*_):
    global active
    active = False
signal.signal(signal.SIGTERM, stop)
hz = os.sysconf('SC_CLK_TCK')
page = os.sysconf('SC_PAGE_SIZE')
with open('/results/processes.jsonl', 'w') as out:
    while active:
        rows = []
        for directory in glob.glob('/proc/[0-9]*'):
            try:
                command = open(directory+'/cmdline', 'rb').read().replace(b'\0', b' ')
                kind = ('api' if b'apps/api/dist/main.js' in command else
                        'ingest' if b'apps/api/dist/ingest-worker.js' in command else
                        'python' if b'ao3.py' in command or b'multiprocessing.spawn' in command else None)
                if kind is None:
                    continue
                fields = open(directory+'/stat').read().rsplit(')', 1)[1].split()
                rows.append(dict(pid=int(directory.split('/')[-1]), kind=kind,
                                 cpu_seconds=(int(fields[11])+int(fields[12]))/hz,
                                 rss_bytes=int(fields[21])*page))
            except (OSError, ValueError, IndexError):
                pass
        out.write(json.dumps(dict(time=time.monotonic(), processes=rows))+'\n')
        out.flush()
        time.sleep(1)
