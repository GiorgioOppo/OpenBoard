#!/usr/bin/env python3
"""Verify the vendored upstream files locally; never downloads or rewrites."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
metadata = json.loads((ROOT / 'SOURCE.json').read_text())
assert metadata['release'] == 'v2.12.0'
assert metadata['commit'] == '79cdd5ab40c79afa559f689ffc13b76812dee1ac'
assert metadata['unicode_version'] == '18.0.0'
assert set(metadata['files']) == {'utf8proc.c', 'utf8proc.h', 'utf8proc_data.c', 'LICENSE.md'}
for name, expected in metadata['files'].items():
    data = (ROOT / name).read_bytes()
    if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
        raise SystemExit(f'Vendored source mismatch: {name}')
print('utf8proc v2.12.0: four unmodified pinned files verified (Unicode 18.0.0).')
