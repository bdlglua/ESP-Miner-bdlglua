#!/usr/bin/env python3
"""Summarize serial logs from a diagnostic build; never connects to a device."""
import argparse
import json
import math
import re
import statistics
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('log', type=Path)
args = parser.parse_args()
groups = {}
for line in args.log.read_text(errors='replace').splitlines():
    if 'coinbase_profile:' in line:
        kind = 'coinbase'
    elif 'work_profile:' in line:
        kind = 'work_attempt'
    else:
        continue
    fields = dict(re.findall(r'(\w+)=([\w-]+)', line))
    if 'us' not in fields:
        continue
    key = (f"coinbase/{fields.get('backend', '?')}/outputs={fields.get('outputs', '?')}"
           if kind == 'coinbase' else f"work_attempt/{fields.get('backend', '?')}")
    if kind != 'coinbase' and 'protocol' in fields:
        key += f"/protocol={fields['protocol']}"
    groups.setdefault(key, []).append(fields)

if not groups:
    raise SystemExit('No coinbase_profile/work_profile measurements found')
result = {}
for key, rows in groups.items():
    good = [r for r in rows if int(r.get('status', '0')) == 0]
    times = sorted(int(r['us']) for r in good)
    summary = {'samples': len(rows), 'errors': len(rows) - len(good)}
    if times:
        summary.update(median_us=statistics.median(times),
                       p95_us=times[math.ceil(len(times) * .95) - 1], max_us=max(times))
    for field in ('heap_min', 'stack_free_min'):
        values = [int(r[field]) for r in rows if field in r]
        if values:
            summary[field + '_bytes'] = min(values)
    result[key] = summary
print(json.dumps(result, indent=2))
