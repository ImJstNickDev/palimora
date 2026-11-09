import importlib.util,pathlib,tempfile,unittest,zipfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('admission',pathlib.Path(__file__).parents[1]/'apps/ingest-adapters/zip_admission.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Admission(unittest.TestCase):
 def test_zip64_and_unknown_do_not_skip(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'many.zip'
   with zipfile.ZipFile(p,'w',allowZip64=True) as z:
    for i in range(65536):z.writestr(str(i),'')
   r=m.inspect(p);self.assertEqual(r['members'],65536);self.assertTrue(r['allowed'])
   p.write_bytes(b'broken');self.assertTrue(m.inspect(p)['exclusive']);self.assertTrue(m.inspect(p)['unknown'])
 def test_large_directory_fails_closed_on_small_quota(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'one.zip'
   with zipfile.ZipFile(p,'w') as z:z.writestr('one','')
   with p.open('rb') as f:e=zipfile._EndRecData(f)
   e[zipfile._ECD_ENTRIES_TOTAL]=2308264;e[zipfile._ECD_SIZE]=402089061
   with patch.object(zipfile,'_EndRecData',return_value=e):
    with patch.object(pathlib.Path,'read_text',return_value=str(3*1024**3)):self.assertFalse(m.inspect(p)['allowed'])
    with patch.object(pathlib.Path,'read_text',return_value=str(6*1024**3)):self.assertTrue(m.inspect(p)['allowed']);self.assertTrue(m.inspect(p)['exclusive'])
    e[zipfile._ECD_ENTRIES_TOTAL]=3000001
    self.assertFalse(m.inspect(p)['allowed'])
 def test_directory_allocation_failure_preserves_limits(self):
  import resource
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'small.zip'
   with zipfile.ZipFile(p,'w') as z:z.writestr('x','valid')
   old=resource.getrlimit(resource.RLIMIT_AS)
   with m.open_zip(p) as z:self.assertEqual(z.read('x'),b'valid')
   self.assertEqual(resource.getrlimit(resource.RLIMIT_AS),old)
   with patch.object(zipfile,'ZipFile',side_effect=MemoryError()):
    with self.assertRaises(OSError) as caught:m.open_zip(p)
    self.assertEqual(caught.exception.errno,12)
   self.assertEqual(resource.getrlimit(resource.RLIMIT_AS),old)
if __name__=='__main__':unittest.main()
