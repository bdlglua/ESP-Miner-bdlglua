#!/usr/bin/env python3
"""Summarize identical-frame benchmark logs; no device access."""
import argparse
import json
import re
import statistics
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('log', type=Path)
parser.add_argument('--scope', choices=['host', 'esp32s3'], required=True)
args = parser.parse_args()
groups, checksums = {}, {}
for line in args.log.read_text(errors='replace').splitlines():
    if 'protocol_bench:' not in line:
        continue
    row = dict(re.findall(r'(\w+)=([\w-]+)', line))
    if 'total_ns' not in row:
        continue
    checksums.setdefault(row['kind'], set()).add(int(row['sum']))
    groups.setdefault(row['kind'] + '/' + row['backend'], []).append(row)
if len(groups) != 12 or any(len(rows) != 9 for rows in groups.values()):
    raise SystemExit('Incomplete benchmark: expected 4 cases × 3 backends × 9 rounds')
if any(len(values) != 1 for values in checksums.values()):
    raise SystemExit('Backend outputs disagree; benchmark results are invalid')
result = {'scope': args.scope, 'timing': 'elapsed time; no UART, allocation or logging in loop', 'cases': {}}
for name, rows in groups.items():
    samples = [int(r['total_ns']) / int(r['n']) for r in rows]
    result['cases'][name] = {'median_ns': statistics.median(samples), 'min_ns': min(samples),
                             'max_ns': max(samples), 'samples_ns': samples,
                             'median_cycles': statistics.median(int(r['cycles']) / int(r['n']) for r in rows)}
print(json.dumps(result, indent=2))
