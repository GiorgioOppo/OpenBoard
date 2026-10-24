#!/usr/bin/env python3
"""Replace vulnerable pip-vendored code from verified, pinned upstream sources.

Keep pip's pure Python msgpack implementation, its namespace isolation, licenses,
vendor requirements, BOM and installed-file RECORD. The remaining setuptools
component is the real upstream pkg_resources subset; its metadata is not hidden.
"""
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import urllib.request
import zipfile

import pip._vendor

ARTIFACTS = {
    'msgpack': {
        'version': '1.2.3',
        'url': 'https://files.pythonhosted.org/packages/0a/e7/bb605a7bab2d8425a64b3fa762b39dc1bf1c7e3f11ba6fb5413d6db0ff8c/msgpack-1.2.3.tar.gz',
        'sha256': '32edb81a2b5eb7cd7c9d941b2bfbbb082fd2cd09e0e725930316af6b708db186',
        'format': 'tar',
    },
    'urllib3': {
        'version': '2.8.0',
        'url': 'https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl',
        'sha256': '0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3',
        'format': 'zip',
    },
}


def archive_files(data, kind):
    if kind == 'zip':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                if not member.is_dir():
                    yield member.filename, archive.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for member in archive.getmembers():
                if member.isfile():
                    yield member.name, archive.extractfile(member).read()


def replace_references(value, replacements):
    if isinstance(value, dict):
        return {key: replace_references(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_references(item, replacements) for item in value]
    return replacements.get(value, value) if isinstance(value, str) else value


def main():
    if importlib.metadata.version('pip') != '26.2.2':
        raise SystemExit('Expected pip 26.2.2; review vendoring before changing the base')
    vendor = Path(pip._vendor.__file__).parent
    bom = json.loads((vendor / 'bom.cdx.json').read_text())
    requirements = (vendor / 'vendor.txt').read_text()
    replacements = {}
    for name, artifact in ARTIFACTS.items():
        with urllib.request.urlopen(artifact['url'], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != artifact['sha256']:
            raise SystemExit(f'Upstream artifact checksum mismatch: {name}')
        component = next(item for item in bom['components'] if item['name'] == name)
        old_purl = component['purl']
        old_version = component['version']
        target = vendor / name
        shutil.rmtree(target)
        target.mkdir()
        count = 0
        for filename, content in archive_files(data, artifact['format']):
            parts = Path(filename).parts
            if name == 'msgpack':
                parts = parts[1:]  # sdist's versioned root directory
            if parts and parts[0] == name and filename.endswith('.py'):
                relative = Path(*parts[1:])
                if '..' in relative.parts:
                    raise SystemExit('Unsafe path in verified upstream archive')
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = content.decode('utf-8')
                # Match pip's own vendoring transformation: qualify absolute
                # imports while preserving all relative imports and APIs.
                source = re.sub(r'(?m)^(\s*from )' + name + r'(?=[.\s])',
                                r'\1pip._vendor.' + name, source)
                source = re.sub(r'(?m)^(\s*)import ' + name + r'\s*$',
                                r'\1from pip._vendor import ' + name, source)
                destination.write_text(source)
                count += 1
            if Path(filename).name in ('LICENSE', 'LICENSE.txt', 'COPYING'):
                (target / 'LICENSE').write_bytes(content)
        if not count or not (target / '__init__.py').is_file() or not (target / 'LICENSE').is_file():
            raise SystemExit(f'Incomplete vendored replacement: {name}')
        version = artifact['version']
        requirements = requirements.replace(f'{name}=={old_version}', f'{name}=={version}')
        component['version'] = version
        replacements[old_purl] = f'pkg:pypi/{name}@{version}'
        component.setdefault('externalReferences', []).append({
            'type': 'distribution', 'url': artifact['url'],
            'hashes': [{'alg': 'SHA-256', 'content': artifact['sha256']}],
        })
        print(f'Vendored {name} {old_version} -> {version}: {count} Python modules')
    bom = replace_references(bom, replacements)
    bom['version'] += 1
    bom['metadata'].setdefault('tools', []).append({'name': 'OpenBoard-pip-vendor-patch', 'version': '1'})
    (vendor / 'bom.cdx.json').write_text(json.dumps(bom, indent=2) + '\n')
    (vendor / 'vendor.txt').write_text(requirements)
    (vendor / 'OPENBOARD_PATCHES.json').write_text(json.dumps(ARTIFACTS, indent=2) + '\n')
    # Remove bytecode for the replaced code and refresh every pip-owned file's
    # recorded checksum. Preserve the RECORD entry itself with empty hash/size.
    for directory in vendor.rglob('__pycache__'):
        shutil.rmtree(directory)
    distribution = importlib.metadata.distribution('pip')
    base = Path(distribution.locate_file(''))
    record = Path(distribution._path) / 'RECORD'
    with record.open(newline='') as handle:
        paths = {row[0] for row in csv.reader(handle) if (base / row[0]).is_file()}
    paths.update(str(path.relative_to(base)) for path in vendor.rglob('*') if path.is_file())
    rows = []
    for name in sorted(paths):
        path = base / name
        if path.resolve() == record.resolve():
            rows.append((name, '', ''))
        else:
            content = path.read_bytes()
            digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b'=').decode()
            rows.append((name, f'sha256={digest}', len(content)))
    with record.open('w', newline='') as handle:
        csv.writer(handle).writerows(rows)


if __name__ == '__main__':
    main()
