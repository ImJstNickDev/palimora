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
if __name__=='__main__':unittest.main()
