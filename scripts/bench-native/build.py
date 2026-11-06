"""Build the isolated experiment; never change the deployed adapter or image."""
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
output = ROOT / '.local/native-parser'
output.mkdir(parents=True, exist_ok=True)
subprocess.run([
    os.environ.get('CXX', 'c++'), '-std=c++17', '-O3', '-shared', '-fPIC',
    '-Wall', '-Wextra', '-Werror', str(ROOT / 'apps/ingest-adapters/native/html_scan.cc'),
    '-o', str(output / 'html_scan.so'),
], check=True)
shutil.copytree(ROOT / 'apps/ingest-adapters', output / 'adapters',
                dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
print(output)
