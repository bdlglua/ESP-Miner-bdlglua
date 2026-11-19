#!/usr/bin/env python3
"""Summarize filtered telemetry from a live run, including partial progress."""
import argparse
from datetime import datetime
import json
import statistics
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--required-seconds', type=float, default=3600)
parser.add_argument('--expected-version')
parser.add_argument('--expected-protocol')
args = parser.parse_args()
rows = [json.loads(line) for line in (args.directory / 'telemetry.jsonl').read_text().splitlines() if line.strip()]
measured = [row for row in rows if row['measured']]
collection_file = args.directory / 'collection.json'
collection = json.loads(collection_file.read_text()) if collection_file.exists() else None
if not measured:
    print(json.dumps({'phase': 'warming', 'samples': len(rows)}))
    raise SystemExit(0)
at = lambda row: datetime.fromisoformat(row['at'].replace('Z', '+00:00')).timestamp()
first_time, last_time = at(measured[0]), at(measured[-1])
first_window = [row['freeHeap'] for row in measured if at(row) <= first_time + 300]
last_window = [row['freeHeap'] for row in measured if at(row) >= last_time - 300]
median = lambda key: statistics.median(row[key] for row in measured)
before_heap, after_heap = statistics.median(first_window), statistics.median(last_window)
report = {
    'phase': 'finished' if collection else 'measuring',
    'observed_seconds': last_time - first_time,
    'actual_measured_seconds': collection.get('actual_measured_seconds') if collection else None,
    'samples': len(measured),
    'device_observed_seconds': measured[-1]['uptimeSeconds'] - measured[0]['uptimeSeconds'],
    'versions': sorted({row['version'] for row in measured}),
    'accepted_delta': measured[-1]['sharesAccepted'] - measured[0]['sharesAccepted'],
    'rejected_delta': measured[-1]['sharesRejected'] - measured[0]['sharesRejected'],
    'hashrate_median_ghs': median('hashRate'),
    'expected_hashrate_ghs': median('expectedHashrate'),
    'asic_temp_range': [min(r['temp'] for r in measured), max(r['temp'] for r in measured)],
    'vrm_temp_range': [min(r['vrTemp'] for r in measured), max(r['vrTemp'] for r in measured)],
    'hardware_error_percent_max': max(r['errorPercentage'] for r in measured),
    'heap_first_5min_median': before_heap, 'heap_last_5min_median': after_heap,
    'heap_window_change_bytes': after_heap - before_heap,
    'pool_difficulties': sorted({r.get('poolDifficulty') for r in measured if 'poolDifficulty' in r}),
}
if collection:
    report['diagnostics'] = {key: collection.get(key, 0) for key in [
        'unexpected_reboots', 'http_errors', 'socket_errors', 'asic_crc_errors', 'uart_errors',
        'invalid_nonces', 'stale_job_responses', 'protocol_tx', 'protocol_rx',
        'protocol_tx_mismatches', 'protocol_rx_mismatches', 'job_id_samples', 'job_id_max_bytes']}
    report['rejected_categories'] = collection.get('rejected_categories', {})
    gates = {
        'full_duration': (collection.get('actual_measured_seconds') or 0) >= args.required_seconds,
        'collector_completed': collection.get('finished') is True,
        'one_firmware_version': len(report['versions']) == 1,
        'telemetry_coverage': len(measured) >= args.required_seconds / 20 and report['device_observed_seconds'] >= args.required_seconds - 20,
        'no_unexpected_reboot': not collection['unexpected_reboots'],
        'no_transport_or_crc_errors': all(not collection.get(k, 0) for k in ['http_errors', 'socket_errors', 'asic_crc_errors', 'uart_errors']),
        'accepted_shares': report['accepted_delta'] > 0,
        'no_nonstale_rejections': all(kind == 'stale' or not count for kind, count in report['rejected_categories'].items()),
        'no_overheat': all(not row['overheat_mode'] for row in measured),
        'no_sustained_heap_drop_over_16k': after_heap >= before_heap - 16384,
        'hashrate_within_10_percent': report['expected_hashrate_ghs'] * .9 <= report['hashrate_median_ghs'] <= report['expected_hashrate_ghs'] * 1.1,
    }
    if args.expected_version:
        gates['expected_firmware'] = report['versions'] == [args.expected_version]
    if args.expected_protocol:
        gates['expected_protocol'] = collection.get('protocol_modes') == [args.expected_protocol] and collection.get('protocol_tx', 0) > 0 and collection.get('protocol_rx', 0) > 0
    report['gates'] = gates
    report['first_hour_gate_passed'] = all(gates.values())
    report['limits'] = 'One-hour first gate, not proof of multi-day stability or a hashrate gain; active-mode mismatch counters do not compare against C.'
print(json.dumps(report, indent=2))
