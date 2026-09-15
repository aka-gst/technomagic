#!/usr/bin/env python3
from pathlib import Path
import hashlib, subprocess, sys
root=Path(__file__).resolve().parents[1]
out=root/'ИГРАТЬ.html'
old=hashlib.sha256(out.read_bytes()).hexdigest()
for _ in range(2): subprocess.run([sys.executable, str(root/'tools/build_offline.py')], check=True, stdout=subprocess.DEVNULL)
new=hashlib.sha256(out.read_bytes()).hexdigest()
assert old==new, (old,new)
s=out.read_text()
assert 'window.__OFFLINE_RESOURCES__' in s
assert 'R0lGODlhAQABAAD' not in s
print('offline builder deterministic',new)
