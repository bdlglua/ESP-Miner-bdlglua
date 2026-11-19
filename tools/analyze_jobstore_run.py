#!/usr/bin/env python3
"""Gate a filtered BM1370 fixed-job run, including accepted shares after reconnects."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--required-seconds', type=float, required=True)
parser.add_argument('--expected-version', required=True)
parser.add_argument('--expected-reconnects', type=int, default=0)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
report = json.loads(subprocess.check_output([
    sys.executable, str(root / 'tools/analyze_stability_run.py'), str(args.directory),
    '--required-seconds', str(args.required_seconds), '--expected-version', args.expected_version,
    '--expected-protocol', 'rust'], text=True))
state = json.loads((args.directory / 'collection.json').read_text())
rows = [json.loads(line) for line in (args.directory / 'telemetry.jsonl').read_text().splitlines()]
log = (args.directory / 'profile.log').read_text()
reconnects = [int(match[0]) / 1000 for match in
              re.findall(r'\((\d+)\) job_store: test reconnect=(\d+)', log)]
after_reconnect = []
for uptime in reconnects:
    before = [row for row in rows if row['uptimeSeconds'] <= uptime]
    baseline = before[-1]['sharesAccepted'] if before else None
    recovered = baseline is not None and any(
        row['uptimeSeconds'] > uptime + 5 and row['sharesAccepted'] > baseline for row in rows)
    after_reconnect.append({'trigger_uptime_seconds': uptime, 'accepted_after_reconnect': recovered})
resets = state.get('job_store_resets', {})
checks = {
    **report.get('gates', {}),
    'fixed_storage_used': state.get('job_store_published', 0) >= 128,
    'clean_jobs_observed': resets.get('clean_jobs', 0) > 0,
    'no_job_store_capacity_or_context_errors': state.get('job_store_errors', 0) == 0,
    'expected_forced_reconnects': len(reconnects) == args.expected_reconnects,
    'shares_after_each_reconnect': all(row['accepted_after_reconnect'] for row in after_reconnect),
}
if args.expected_reconnects:
    checks['pool_sessions_replaced'] = all(resets.get(key, 0) >= args.expected_reconnects
                                           for key in ('disconnect', 'connect', 'extranonce'))
report.pop('first_hour_gate_passed', None)
report.update(gates=checks, integration_gate_passed=all(checks.values()),
              job_store_resets=resets, job_store_published=state.get('job_store_published'),
              stale_submissions_discarded=state.get('job_store_stale_submissions'),
              reconnects=after_reconnect,
              limits='Targeted integration run; not a one-hour or multi-day stability claim. '
                     'Hardware slot-ID reuse still limits detection of very late ASIC responses.')
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['integration_gate_passed'] else 1)
