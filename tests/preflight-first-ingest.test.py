import importlib.util,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('preflight',pathlib.Path(__file__).parents[1]/'scripts/preflight-first-ingest.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Preflight(unittest.TestCase):
    def test_missing_config_fails_closed(self):
        r=m.inspect({},1)
        self.assertEqual(r['decision'],'NO-GO')
        self.assertTrue(any(c['status']=='FAIL' for c in r['checks']))
        self.assertTrue(r['mandatory_manual_checks'])
    def test_rw_dump_and_capacity_fail(self):
        with tempfile.TemporaryDirectory() as d:
            r=m.inspect({'services':{'ingest':{'cpus':2,'mem_limit':1024,'volumes':[{'type':'bind','source':d,'target':'/dumps/ao3_stories','read_only':False}]} }},2**100)
            failures={c['check'] for c in r['checks'] if c['status']=='FAIL'}
            self.assertIn('ingest.dump_readonly',failures)
            self.assertTrue(any(c.startswith('capacity.') for c in failures))
            self.assertEqual(list(pathlib.Path(d).iterdir()),[])

class ComponentBudgets(unittest.TestCase):
    def test_same_device_adds_components_and_reserves_once(self):
        with tempfile.TemporaryDirectory() as d:
            services={name:dict(cpus=1,mem_limit=6*2**30,volumes=[]) for name in ['api','ingest','projection','postgres','redis','opensearch']}
            services['api']['environment']={'PROJECTION_MODE':'isolated','SEARCH_PARALLEL_FACETS':'0'}
            services['ingest']['environment']={'INGEST_PRESSURE_MODE':'throughput-first','INGEST_DISK_RESERVE_GIB':'8','INGEST_BACKLOG_GIB':'8','INGEST_STAGING_GIB':'4'}
            services['ingest']['volumes']=[dict(type='bind',source=d,target='/dumps/ao3_stories',read_only=True),dict(type='bind',source=d,target='/storage')]
            secret=pathlib.Path(d)/'secret';secret.write_text('test-only')
            for service in ['api','ingest','projection']:
                services[service]['volumes'].extend(dict(type='bind',source=str(secret),target='/run/secrets/'+key,read_only=True) for key in ['auth','database'])
            names=['pack','postgres','search','staging','wal','backlog','maintenance','metadata_cache','backup','restore']
            plan={'components':[dict(component=n,path=d,required_gib=1) for n in names], 'reserves':[dict(path=d,gib=8),dict(path=d,gib=8)]}
            core={'pack':'ingest','staging':'ingest','metadata_cache':'ingest','postgres':'postgres','wal':'postgres','backlog':'postgres','search':'opensearch'}
            for service in ['postgres','opensearch']:services[service]['volumes']=[dict(type='bind',source=d,target='/storage')]
            for item in plan['components']:
                if item['component'] in core:item.update(service=core[item['component']],target='/storage')
            r=m.inspect({'services':services},plan=plan,evidence=dict(technical_status='complete',restore_verified=True))
            self.assertEqual(r['static_result'],'GO');self.assertEqual(r['decision'],'NO-GO');self.assertFalse(r['operational_authorized'])
            self.assertEqual(len(r['filesystems']),1)
            fs=next(iter(r['filesystems'].values()));self.assertEqual(fs['required_bytes'],10*2**30);self.assertEqual(fs['reserve_bytes'],8*2**30)
            plan['components'][0].update(service='ingest',target='/storage',path=d+'/wrong')
            r=m.inspect({'services':services},plan=plan)
            self.assertIn('layout.pack',r['blockers']['configuration_backup'])
            self.assertEqual([p.name for p in pathlib.Path(d).iterdir()],['secret'])

if __name__=='__main__':unittest.main()
