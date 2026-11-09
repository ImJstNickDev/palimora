#!/usr/bin/env python3
"""Read-only first-ingest gate. Never prints expanded Compose or secret values."""
import argparse, json, os, pathlib, subprocess, sys

def inspect(config, required_bytes):
    checks = []
    def check(name, ok, detail):
        checks.append(dict(check=name, status='PASS' if ok else 'FAIL', detail=detail))
    services = config.get('services', {})
    check('services', all(s in services for s in ['ingest','projection','postgres','redis','opensearch']), 'Required pipeline services')
    devices = {}
    for name, s in services.items():
        check(name+'.ports', not s.get('ports'), 'No published host ports')
        check(name+'.limits', float(s.get('cpus',0)) > 0 and int(s.get('mem_limit',0)) > 0, 'Finite CPU and RAM limits')
        networks = s.get('networks', {})
        frontend = [n for n in networks if config.get('networks',{}).get(n,{}).get('name') == 'prod-frontend']
        check(name+'.network', not frontend or name=='gateway', 'Frontend only on gateway')
        for v in s.get('volumes', []):
            target=v.get('target',''); source=v.get('source','')
            check(name+'.bind.'+target,v.get('type')=='bind','Persistent mounts must be binds')
            p=pathlib.Path(source)
            check(name+'.exists.'+target,p.exists(),'Host mount source exists')
            if target.startswith('/dumps'):
                check(name+'.dump_readonly',v.get('read_only') is True,'Dump must be read-only')
            if target.startswith('/run/secrets'):
                check(name+'.secret.'+target,p.is_file() and os.access(p,os.R_OK) and p.stat().st_size>0,'Nonempty readable secret; value never read')
            if p.is_dir() and not v.get('read_only'):
                st=p.stat(); fs=os.statvfs(p)
                devices[st.st_dev]={'path':str(p),'available_bytes':fs.f_bavail*fs.f_frsize}
    env=services.get('ingest',{}).get('environment',{})
    check('dump_mount',any(v.get('target','').startswith('/dumps') and v.get('read_only') for v in services.get('ingest',{}).get('volumes',[])),'Ingest needs a read-only source mount')
    for key in ['INGEST_DISK_RESERVE_GIB','INGEST_BACKLOG_GIB','INGEST_STAGING_GIB']:
        try: ok=float(env.get(key,0))>0
        except (ValueError,TypeError): ok=False
        check(key,ok,'Positive explicit capacity budget')
    check('pressure',env.get('INGEST_PRESSURE_MODE')=='throughput-first','P4 throughput-first baseline')
    check('projection',services.get('api',{}).get('environment',{}).get('PROJECTION_MODE')=='isolated','Dedicated projection role')
    check('facets',str(services.get('api',{}).get('environment',{}).get('SEARCH_PARALLEL_FACETS','0'))=='0','Keep parallel facets disabled')
    check('capacity_model',required_bytes>0,'Operator must supply prudent additional working capacity, excluding backup')
    for dev,fs in devices.items():
        check('capacity.'+str(dev),required_bytes>0 and fs['available_bytes']>=required_bytes,fs)
    # These cannot safely be inferred from a static Compose configuration.
    manual=[
        'Inspect effective container mounts, UID permissions, filesystem identity and disk quotas.',
        'Verify PostgreSQL/Redis/OpenSearch health, connection headroom, WAL retention and projection heartbeat.',
        'Verify no running/pending ingest or automatic source selection in the target database.',
        'Verify backup target identity, separate capacity, secrets recovery and successful isolated fixture restore.',
        'Complete P5 sustained A/B/C, heterogeneous integrity and backlog recovery evidence before launch.',
    ]
    return dict(schema='palimora.first-ingest-preflight.v1',decision='NO-GO',checks=checks,filesystems=devices,mandatory_manual_checks=manual,
                reason='Manual gates are unresolved; static checks alone cannot authorize ingest.')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file',required=True)
    p.add_argument('--compose',default='infra/compose.yaml')
    p.add_argument('--required-gib',required=True,type=float)
    a=p.parse_args()
    try:
        r=subprocess.run(['docker','compose','--env-file',a.env_file,'-f',a.compose,'config','--format','json'],capture_output=True,text=True,timeout=30)
        if r.returncode: raise ValueError('Compose validation failed; inspect configuration locally (output suppressed to protect secrets)')
        report=inspect(json.loads(r.stdout),int(a.required_gib*2**30))
    except Exception as e:
        report=dict(decision='NO-GO',error=type(e).__name__,reason='Configuration unavailable or invalid; no ingest authorized')
    print(json.dumps(report,indent=2));return 2
if __name__=='__main__':sys.exit(main())
