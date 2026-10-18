#!/usr/bin/env python3
"""Validate scoped ASVS traceability without executing tests or using the network.

Optionally compare the inventory to a separately obtained, checksum-pinned
official CSV. This checks traceability structure, not security compliance.
"""
import argparse
import ast
from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PINNED_COMMIT = '5cf9b032440be53ce345ab3c130fda46ba1ce7a2'
PINNED_SHA256 = '98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680'
STATUSES = {'partial', 'gap', 'unassessed', 'deployment_required', 'not_applicable'}
# Identifiers/levels from the checksum-pinned ASVS 5.0.0 release. No standard
# requirement prose is copied; see docs/SECURITY_REQUIREMENTS.md for attribution.
PINNED_L1 = set('''
1.2.1 1.2.2 1.2.3 1.2.4 1.2.5 1.3.1 1.3.2 1.5.1
2.1.1 2.2.1 2.2.2 2.3.1
3.2.1 3.2.2 3.3.1 3.4.1 3.4.2 3.5.1 3.5.2 3.5.3
4.1.1 4.4.1 5.2.1 5.2.2 5.3.1 5.3.2
6.1.1 6.2.1 6.2.2 6.2.3 6.2.4 6.2.5 6.2.6 6.2.7 6.2.8
6.3.1 6.3.2 6.4.1 6.4.2
7.2.1 7.2.2 7.2.3 7.2.4 7.4.1 7.4.2
8.1.1 8.2.1 8.2.2 8.3.1
9.1.1 9.1.2 9.1.3 9.2.1
10.4.1 10.4.2 10.4.3 10.4.4 10.4.5
11.3.1 11.3.2 11.4.1
12.1.1 12.2.1 12.2.2 13.4.1 14.2.1 14.3.1
15.1.1 15.2.1 15.3.1
'''.split())
PINNED_ADDITIONAL_LEVELS = {
    '7.3.1': 2, '7.3.2': 2, '8.4.1': 2,
    '11.3.3': 2, '11.4.2': 2, '11.5.1': 2,
    '12.3.1': 2, '12.3.3': 2,
    '15.3.4': 2, '15.3.6': 2, '15.4.2': 3,
    '16.2.5': 2, '16.4.1': 2, '16.5.1': 2, '16.5.2': 2, '16.5.3': 2,
}


class InvalidMatrix(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidMatrix(message)


def present_text(value):
    return isinstance(value, str) and bool(value.strip())


def source_file(relative):
    require(present_text(relative), 'Evidence path must be nonempty text.')
    path = Path(relative)
    require(not path.is_absolute() and '..' not in path.parts,
            'Evidence path must remain relative to the repository.')
    resolved = (ROOT / path).resolve()
    require(resolved.is_relative_to(ROOT) and resolved.is_file(),
            f'Evidence file is missing or outside the repository: {relative}')
    require(resolved.stat().st_size > 0, f'Evidence file is empty: {relative}')
    return resolved


def check(matrix, catalog=None):
    require(matrix.get('schema_version') == 1, 'Unsupported matrix schema.')
    require(present_text(matrix.get('assessment_scope')), 'Assessment scope is required.')
    standard = matrix['standard']
    require(standard['name'] == 'OWASP ASVS' and standard['version'] == '5.0.0',
            'The checker is pinned to OWASP ASVS 5.0.0.')
    require(standard['commit'] == PINNED_COMMIT and standard['sha256'] == PINNED_SHA256,
            'Official standard provenance changed; review the checker and inventory together.')
    require(standard['release_tag'] == 'v5.0.0_release', 'Stable release tag is required.')
    require(standard['catalog_requirement_count'] == 345 and
            standard['level1_requirement_count'] == 70, 'Pinned catalog counts changed.')
    require(standard['source_url'] ==
            f'https://raw.githubusercontent.com/OWASP/ASVS/{PINNED_COMMIT}/5.0/docs_en/'
            'OWASP_Application_Security_Verification_Standard_5.0.0_en.csv',
            'The catalog URL must identify the immutable official CSV.')
    require(standard['license'] == 'CC-BY-SA-4.0', 'Standard attribution is required.')
    chapters = matrix['chapters']
    require(len(chapters) == 17 and {c['id'] for c in chapters} ==
            {f'V{x}' for x in range(1, 18)}, 'All 17 chapter boundaries must be explicit.')
    for chapter in chapters:
        require(present_text(chapter.get('scope')) and chapter.get('assessment') in
                {'scoped', 'unassessed', 'not_applicable'}, 'Invalid chapter scope.')

    controls = matrix['controls']
    require(controls and len({c['id'] for c in controls}) == len(controls),
            'Control IDs must be nonempty and unique.')
    mapped = {}
    python_symbols = {}
    for control in controls:
        cid = control['id']
        require(re.fullmatch(r'OB-C[0-9]{2}', cid), f'Invalid control ID: {cid}')
        require(control['status'] in STATUSES - {'unassessed'}, f'Invalid control status: {cid}')
        for field in ('observation', 'remaining_work', 'owner'):
            require(present_text(control.get(field)), f'{cid} requires {field}.')
        require(isinstance(control['sources'], list) and control['sources'],
                f'{cid} must cite actual source/document evidence.')
        for source in control['sources']:
            source_file(source)
        require(isinstance(control['tests'], list), f'{cid} tests must be an array.')
        for test in control['tests']:
            relative, symbol = test['path'], test['symbol']
            require(relative.startswith('tests/'), f'{cid} test evidence must be under tests/.')
            path = source_file(relative)
            if path.suffix == '.py':
                require(present_text(symbol) and symbol.startswith('test_'),
                        f'{cid} Python test evidence requires a named test method.')
                if relative not in python_symbols:
                    tree = ast.parse(path.read_text(encoding='utf-8'), filename=relative)
                    python_symbols[relative] = {n.name for n in ast.walk(tree)
                                                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
                require(symbol in python_symbols[relative], f'Missing regression: {relative}::{symbol}')
            else:
                require(path.suffix in ('.js', '.mjs') and symbol is None,
                        f'{cid} JavaScript evidence identifies a suite, not an invented method.')
        require(isinstance(control['threats'], list) and control['threats'] and
                all(re.fullmatch(r'TM-(0[1-9]|1[0-7])', t) for t in control['threats']),
                f'{cid} requires known threat IDs.')
        require(isinstance(control['requirements'], list) and control['requirements'],
                f'{cid} requires ASVS mappings.')
        for rid in control['requirements']:
            require(rid not in mapped, f'Duplicate requirement mapping: {rid}')
            mapped[rid] = control

    rows = matrix['requirements']
    require(len({r['id'] for r in rows}) == len(rows), 'Requirement IDs must be unique.')
    require(all(re.fullmatch(r'v5\.0\.0-[1-9][0-9]*\.[1-9][0-9]*\.[1-9][0-9]*', r['id'])
                for r in rows), 'Requirements must use version-qualified numeric identifiers.')
    l1 = {r['id'].removeprefix('v5.0.0-') for r in rows if r['level'] == 1}
    require(l1 == PINNED_L1, 'Level 1 inventory differs from the 70 official pinned IDs.')
    additional = {r['id'].removeprefix('v5.0.0-'): r['level'] for r in rows if r['level'] != 1}
    require(additional == PINNED_ADDITIONAL_LEVELS,
            'Selected additional requirement IDs/levels changed; review their provenance.')
    for row in rows:
        rid = row['id']
        require(type(row['level']) is int and row['level'] in (1, 2, 3), f'Invalid level: {rid}')
        require(row['chapter'] == 'V' + rid.removeprefix('v5.0.0-').split('.')[0],
                f'Wrong chapter: {rid}')
        require(row['status'] in STATUSES, f'Invalid assessment status: {rid}')
        if row['status'] == 'unassessed':
            require('control' not in row and rid not in mapped and
                    present_text(row.get('owner')) and present_text(row.get('remaining_work')),
                    f'Unassessed requirement must expose owner/work without evidence claims: {rid}')
        else:
            require(rid in mapped and mapped[rid]['id'] == row.get('control') and
                    mapped[rid]['status'] == row['status'], f'Control/requirement mismatch: {rid}')
    require(set(mapped) == {r['id'] for r in rows if r['status'] != 'unassessed'},
            'Control mappings and inventory must contain the same assessed identifiers.')

    if catalog is not None:
        payload = Path(catalog).read_bytes()
        require(hashlib.sha256(payload).hexdigest() == PINNED_SHA256,
                'Official CSV bytes do not match the pinned SHA-256.')
        records = list(csv.DictReader(io.StringIO(payload.decode('utf-8-sig'))))
        require(len(records) == 345 and len({r['req_id'] for r in records}) == 345,
                'Unexpected official catalog inventory.')
        official = {'v5.0.0-' + r['req_id'].removeprefix('V'): r for r in records}
        require({rid for rid, r in official.items() if r['L'] == '1'} ==
                {r['id'] for r in rows if r['level'] == 1}, 'Official Level 1 coverage differs.')
        for row in rows:
            require(row['id'] in official and int(official[row['id']]['L']) == row['level'] and
                    official[row['id']]['chapter_id'] == row['chapter'],
                    f'Official requirement metadata mismatch: {row["id"]}')
    return Counter(r['status'] for r in rows), len(controls)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--matrix', type=Path, default=ROOT / 'docs/security-requirements.json')
    parser.add_argument('--asvs-catalog', type=Path,
                        help='Optional official release CSV; checksum must match the pinned bytes.')
    args = parser.parse_args()
    try:
        matrix = json.loads(args.matrix.read_text(encoding='utf-8'))
        counts, controls = check(matrix, args.asvs_catalog)
    except (InvalidMatrix, OSError, ValueError, TypeError, KeyError, SyntaxError) as error:
        print(f'Security traceability check failed: {error}', file=sys.stderr)
        return 1
    print(f'Security traceability: 70/70 Level 1 IDs, 16 selected higher-level IDs, '
          f'{controls} scoped controls; ' + ', '.join(f'{key}={value}' for key, value in sorted(counts.items())))
    if args.asvs_catalog:
        print('Official immutable CSV checksum, identifiers and levels verified.')
    print('This validates evidence references and inventory; it does not certify security or execute the cited tests.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
