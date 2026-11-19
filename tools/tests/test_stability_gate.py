"""Guard against accepting a short, interrupted or unhealthy stability run."""
import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class StabilityGate(unittest.TestCase):
    def setUp(self):
        start = datetime(2026, 11, 17, tzinfo=timezone.utc)
        self.rows = [dict(at=(start + timedelta(seconds=n)).isoformat(), measured=True,
            version='candidate', uptimeSeconds=100+n, sharesAccepted=n, sharesRejected=0,
            hashRate=1120, expectedHashrate=1122, temp=56, vrTemp=68, freeHeap=8_200_000,
            errorPercentage=0, poolDifficulty=2048, overheat_mode=0) for n in range(0,3601,10)]
        self.collection = dict(actual_measured_seconds=3600, finished=True, unexpected_reboots=0,
            http_errors=0, socket_errors=0, asic_crc_errors=0, uart_errors=0,
            protocol_modes=['rust'], protocol_tx=10000, protocol_rx=6000, rejected_categories={})

    def evaluate(self, rows=None, collection=True):
        with tempfile.TemporaryDirectory(prefix='stability-gate-test-') as directory:
            p = Path(directory)
            (p/'telemetry.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in (self.rows if rows is None else rows)))
            if collection:
                (p/'collection.json').write_text(json.dumps(self.collection))
            return json.loads(subprocess.check_output(['python3', str(ROOT/'tools/analyze_stability_run.py'),
                directory, '--expected-version', 'candidate', '--expected-protocol', 'rust'], text=True))

    def test_complete_healthy_hour(self):
        self.assertTrue(self.evaluate()['first_hour_gate_passed'])

    def test_short_run_is_not_an_hour(self):
        self.collection['actual_measured_seconds'] = 3599.9
        self.assertFalse(self.evaluate()['first_hour_gate_passed'])

    def test_missing_completion_and_missing_coverage(self):
        self.assertNotIn('first_hour_gate_passed', self.evaluate(collection=False))
        self.assertFalse(self.evaluate(rows=self.rows[-10:])['first_hour_gate_passed'])

    def test_faults_and_unexpected_mode(self):
        original = copy.deepcopy(self.collection)
        for key in ['unexpected_reboots', 'asic_crc_errors', 'uart_errors', 'http_errors']:
            with self.subTest(key=key):
                self.collection = copy.deepcopy(original); self.collection[key] = 1
                self.assertFalse(self.evaluate()['first_hour_gate_passed'])
        self.collection = copy.deepcopy(original); self.collection['protocol_modes'] = ['rust-shadow']
        self.assertFalse(self.evaluate()['first_hour_gate_passed'])

    def test_persistent_heap_drop_and_aborted_collector(self):
        rows = copy.deepcopy(self.rows)
        for row in rows[180:]: row['freeHeap'] -= 50_000
        self.assertFalse(self.evaluate(rows=rows)['first_hour_gate_passed'])
        self.collection['finished'] = False
        self.assertFalse(self.evaluate()['first_hour_gate_passed'])

    def test_stale_and_invalid_rejections_are_distinguished(self):
        self.rows[-1]['sharesRejected'] = 1
        self.collection['rejected_categories'] = {'stale':1}
        self.assertTrue(self.evaluate()['first_hour_gate_passed'])
        self.collection['rejected_categories'] = {'low difficulty':1}
        self.assertFalse(self.evaluate()['first_hour_gate_passed'])

if __name__ == '__main__': unittest.main()
