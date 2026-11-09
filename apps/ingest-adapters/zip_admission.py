"""Read only ZIP/ZIP64 end records via CPython; never materialize ZipInfo here.
Large directories are exclusive source barriers. Limits precede allocation;
unknown/corrupt headers remain exclusive and are classified by the adapter.
"""
import json,sys,zipfile,pathlib,resource

def inspect(path):
    try:
        with open(path,'rb') as f:e=zipfile._EndRecData(f)
        if not e:raise zipfile.BadZipFile()
        count=e[zipfile._ECD_ENTRIES_TOTAL];size=e[zipfile._ECD_SIZE]
        exclusive=count>100000 or size>16*1024**2
        try:
            raw=pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip()
            quota=int(raw) if raw!='max' else None
        except (OSError,ValueError):quota=None
        return dict(exclusive=exclusive,
                    allowed=count<=3000000 and size<=512*1024**2 and (not exclusive or quota is None or quota>=6*1024**3),
                    members=count,central_bytes=size)
    except (OSError,zipfile.BadZipFile):
        return dict(exclusive=True,allowed=True,unknown=True)
if __name__=='__main__':
    print(json.dumps([inspect(p) for p in sys.argv[1:]]))


def open_zip(path):
    """Bound allocation while CPython materializes the directory, then restore limits.
    MemoryError is capacity pressure, never a corrupt-source classification.
    The ordinary ZipFile implementation still owns ZIP64, names, offsets and CRC.
    """
    info=inspect(path)
    if not info['allowed']:
        raise OSError(12,'ZIP central directory exceeds validated memory/quota envelope')
    old=resource.getrlimit(resource.RLIMIT_AS)
    ceiling=(3*1024**3 if info['exclusive'] else 384*1024**2)
    soft=ceiling if old[0]==resource.RLIM_INFINITY else min(old[0],ceiling)
    resource.setrlimit(resource.RLIMIT_AS,(soft,old[1]))
    try:
        return zipfile.ZipFile(path)
    except MemoryError as error:
        raise OSError(12,'ZIP central directory memory admission exceeded') from error
    finally:
        resource.setrlimit(resource.RLIMIT_AS,old)
