#!/usr/bin/env python3
"""Read-only static capacity/layout checks, distinct from operational authorization."""
import argparse,json,math,os,pathlib,subprocess,sys
GIB=2**30

def inspect(config,required_bytes=0,plan=None,evidence=None):
 checks=[];devices={};blockers={k:[] for k in ['software','memory','capacity','configuration_backup']}
 def check(name,ok,detail,group='configuration_backup'):
  checks.append(dict(check=name,status='PASS' if ok else 'FAIL',detail=detail,group=group))
  if not ok:blockers[group].append(name)
 def directory(p):
  p=pathlib.Path(p)
  if not p.is_dir():return None
  st=p.stat();v=os.statvfs(p);key=str(st.st_dev)
  devices.setdefault(key,dict(paths=[],available_bytes=v.f_bavail*v.f_frsize,required_bytes=0,reserve_bytes=0,components=[]))
  if str(p) not in devices[key]['paths']:devices[key]['paths'].append(str(p))
  return key
 services=config.get('services',{})
 check('services',all(s in services for s in ['ingest','projection','postgres','redis','opensearch']),'Required pipeline services')
 for name,s in services.items():
  check(name+'.ports',not s.get('ports'),'No published host ports')
  check(name+'.limits',float(s.get('cpus',0))>0 and int(s.get('mem_limit',0))>0,'Finite CPU/RAM quotas','memory')
  frontend=[n for n in s.get('networks',{}) if config.get('networks',{}).get(n,{}).get('name')=='prod-frontend']
  check(name+'.network',not frontend or name=='gateway','Frontend only on gateway')
  for v in s.get('volumes',[]):
   target=v.get('target','');p=pathlib.Path(v.get('source',''))
   check(name+'.bind.'+target,v.get('type')=='bind','Persistent bind mount')
   check(name+'.exists.'+target,p.exists(),'Mount source exists')
   if target.startswith('/dumps'):check(name+'.dump_readonly',v.get('read_only') is True,'Read-only original sources')
   if target.startswith('/run/secrets'):check(name+'.secret.'+target,p.is_file() and os.access(p,os.R_OK) and p.stat().st_size>0,'Readable nonempty secret; contents never read')
   if p.is_dir() and not v.get('read_only'):directory(p)
 for name in ['api','ingest','projection']:
  targets={v.get('target') for v in services.get(name,{}).get('volumes',[]) if v.get('read_only')}
  check(name+'.required_secrets',{'/run/secrets/auth','/run/secrets/database'}.issubset(targets),'Auth and database secret mounts required')
 env=services.get('ingest',{}).get('environment',{})
 check('dump_mount',any(v.get('target','').startswith('/dumps') and v.get('read_only') for v in services.get('ingest',{}).get('volumes',[])),'Read-only dump bind required')
 for key in ['INGEST_DISK_RESERVE_GIB','INGEST_BACKLOG_GIB','INGEST_STAGING_GIB']:
  try:ok=math.isfinite(float(env.get(key,0))) and float(env.get(key,0))>0
  except (TypeError,ValueError):ok=False
  check(key,ok,'Positive finite capacity budget','capacity')
 check('pressure',env.get('INGEST_PRESSURE_MODE')=='throughput-first','Throughput-first profile')
 check('large_zip_memory',int(services.get('ingest',{}).get('mem_limit',0))>=6*GIB,'Large-ZIP exclusive admission requires at least 6 GiB','memory')
 check('projection',services.get('api',{}).get('environment',{}).get('PROJECTION_MODE')=='isolated','Isolated projection process')
 check('facets',str(services.get('api',{}).get('environment',{}).get('SEARCH_PARALLEL_FACETS','0'))=='0','Parallel facets remain disabled')
 if plan is None:
  check('component_plan',False,'Supply --capacity-plan; a single total cannot validate a multi-filesystem layout','capacity')
  for dev,item in devices.items():
   item['required_bytes']=required_bytes
   check('capacity.'+dev,required_bytes>0 and item['available_bytes']>=required_bytes,item,'capacity')
 else:
  names=set()
  core={'pack':'ingest','staging':'ingest','metadata_cache':'ingest','postgres':'postgres','wal':'postgres','backlog':'postgres','search':'opensearch'}
  for item in plan.get('components',[]):
   name=item.get('component','');service=item.get('service');target=item.get('target');source=item.get('path')
   check('component.'+name,bool(name) and name not in names,'Unique component budget','capacity');names.add(name)
   if name in core:
    check('binding.'+name,service==core[name] and bool(target),'Core component must declare its effective service bind')
   if service:
    mounts=[v for v in services.get(service,{}).get('volumes',[]) if v.get('target')==target and v.get('type')=='bind' and not v.get('read_only')]
    match=len(mounts)==1 and (source is None or os.path.abspath(source)==os.path.abspath(mounts[0]['source']))
    check('layout.'+name,match,'Declared component must match the effective writable Compose bind')
    if not match:continue
    source=mounts[0]['source']
   amount=item.get('required_gib')
   valid=isinstance(amount,(int,float)) and not isinstance(amount,bool) and math.isfinite(amount) and amount>=0
   check('budget.'+name,valid,'Additional capacity in GiB, excluding per-device reserve','capacity')
   dev=directory(source) if source else None
   check('path.'+name,dev is not None,'Existing directory on the declared destination')
   if dev is not None and valid:
    devices[dev]['required_bytes']+=math.ceil(amount*GIB);devices[dev]['components'].append(name)
  check('component_coverage',{'pack','postgres','search','staging','wal','backlog','maintenance','metadata_cache','backup','restore'}.issubset(names),'All capacity components must be declared','capacity')
  for reserve in plan.get('reserves',[]):
   dev=directory(reserve.get('path',''));amount=reserve.get('gib');valid=isinstance(amount,(int,float)) and not isinstance(amount,bool) and math.isfinite(amount) and amount>0
   check('reserve.'+str(reserve.get('path')),dev is not None and valid,'Positive reserve on an existing filesystem','capacity')
   if dev is not None and valid:devices[dev]['reserve_bytes']=max(devices[dev]['reserve_bytes'],math.ceil(amount*GIB))
  for dev,item in devices.items():
   if not item['components']:continue
   configured=float(env.get('INGEST_DISK_RESERVE_GIB',8))*GIB
   check('reserve_budget.'+dev,item['reserve_bytes']>=configured,'Reserve must cover the configured ingest stop threshold','capacity')
   need=item['required_bytes']+item['reserve_bytes'];item['deficit_bytes']=max(0,need-item['available_bytes'])
   check('capacity.'+dev,need<=item['available_bytes'],dict(required_with_reserve_bytes=need,available_bytes=item['available_bytes'],deficit_bytes=item['deficit_bytes']),'capacity')
 manual=['Inspect effective container mount identity, UID permissions and filesystem quotas.','Verify PostgreSQL/Redis/OpenSearch health, connection headroom, WAL retention and projection heartbeat.','Verify absence of concurrent ingest and automatic source selection.','Verify production backup destination/device/marker, credentials and restore procedure.','Operator must approve the declared layout and explicitly authorize ingest.']
 if evidence is not None:evidence=evidence.get('completion',evidence)
 if evidence is None:manual.append('Supply the completed P5 technical evidence and isolated restore report.')
 else:
  check('technical_evidence',evidence.get('technical_status')=='complete','P5 technical validation complete','software')
  check('fixture_restore',evidence.get('restore_verified') is True,'Isolated full restore verified')
 static=not any(c['status']=='FAIL' for c in checks)
 return dict(schema='palimora.first-ingest-preflight.v2',static_result='GO' if static else 'NO-GO',decision='NO-GO',operational_authorized=False,checks=checks,filesystems=devices,blockers=blockers,mandatory_manual_checks=manual,reason='Static validation does not authorize ingest; mandatory operational checks remain pending.')

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--env-file',required=True);p.add_argument('--compose',default='infra/compose.yaml');g=p.add_mutually_exclusive_group(required=True);g.add_argument('--required-gib',type=float);g.add_argument('--capacity-plan');p.add_argument('--technical-evidence');a=p.parse_args()
 try:
  r=subprocess.run(['docker','compose','--env-file',a.env_file,'-f',a.compose,'config','--format','json'],capture_output=True,text=True,timeout=30)
  if r.returncode:raise ValueError('Invalid Compose')
  plan=json.loads(pathlib.Path(a.capacity_plan).read_text()) if a.capacity_plan else None
  evidence=json.loads(pathlib.Path(a.technical_evidence).read_text()) if a.technical_evidence else None
  report=inspect(json.loads(r.stdout),int((a.required_gib or 0)*GIB),plan,evidence)
 except Exception as e:report=dict(schema='palimora.first-ingest-preflight.v2',decision='NO-GO',static_result='NO-GO',operational_authorized=False,error=type(e).__name__,blockers=dict(software=[],memory=[],capacity=[],configuration_backup=['configuration_unavailable']),mandatory_manual_checks=['Supply and review the definitive Compose environment and component capacity plan.'],reason='Invalid or unavailable configuration; output suppressed to protect secrets')
 print(json.dumps(report,indent=2));return 0 if report.get('static_result')=='GO' else 2
if __name__=='__main__':sys.exit(main())
