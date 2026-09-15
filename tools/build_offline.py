#!/usr/bin/env python3
"""Deterministically rebuild the checked-in offline bundle."""
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "tools" / "offline_template.html"
OUTPUT = ROOT / "ИГРАТЬ.html"
data = TEMPLATE.read_bytes()
if not data:
    raise SystemExit("empty offline template")
OUTPUT.write_bytes(data)
print(hashlib.sha256(data).hexdigest())
