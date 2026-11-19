#!/usr/bin/env python3
"""Run the production coinbase decoder with ASan/UBSan on the host.

Needs a C compiler, libmbedcrypto, and the ESP-IDF mbedTLS headers.
Usage: python3 tools/test_coinbase_decoder.py
IDF_PATH can override ~/esp/esp-idf. No device or pool connection is used.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import platform
import statistics
from ctypes.util import find_library
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--compare-rust', action='store_true', help='also check C/Rust result parity')
parser.add_argument('--benchmark', action='store_true', help='also run an unsanitized host benchmark')
parser.add_argument('--report', type=Path, help='save host benchmark metadata and medians as JSON')
args = parser.parse_args()
compare = args.compare_rust or args.benchmark
crate = root / 'components/stratum/rust'
rust_archive = crate / 'target/release/libaxeos_coinbase.a'
if compare:
    subprocess.run(['cargo', 'test', '--manifest-path', str(crate / 'Cargo.toml'), '--locked', '--lib'], check=True)
    subprocess.run(['cargo', 'build', '--manifest-path', str(crate / 'Cargo.toml'), '--locked', '--release'], check=True)
idf = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf'))
fixture = json.loads((root / 'tools/tests/fixtures/peercoin_bcmonster.json').read_text())
dgb = json.loads((root / 'tools/tests/fixtures/digibyte_bcmonster.json').read_text())
crypto = find_library('mbedcrypto')
if not crypto:
    raise SystemExit('libmbedcrypto is required for the host tests')

with tempfile.TemporaryDirectory(prefix='axeos-coinbase-test-') as temporary:
    work = Path(temporary)
    # Only ESP-IDF transport/error declarations are replaced. Parser, address
    # codecs, utilities and SHA256 all execute their real implementations.
    (work / 'esp_err.h').write_text('typedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_ERR_NO_MEM 0x101\n#define ESP_ERR_INVALID_ARG 0x102\n')
    (work / 'esp_transport.h').write_text('typedef void *esp_transport_handle_t;\n')
    (work / 'cJSON.h').write_text('typedef struct cJSON cJSON;\n')
    (work / 'fixture.h').write_text('\n'.join([
        '#define PPC_COINBASE_1 ' + json.dumps(fixture['coinbase_1']),
        '#define PPC_COINBASE_2 ' + json.dumps(fixture['coinbase_2']),
        '#define PPC_TARGET 0x' + fixture['target'],
        '#define PPC_HEIGHT ' + str(fixture['expected_height']),
        '#define PPC_TOTAL ' + str(fixture['expected_total_atoms']),
        '#define PPC_PAYOUT_ADDRESS ' + json.dumps(fixture['expected_payout_address']),
        '#define DGB_COINBASE_1 ' + json.dumps(dgb['coinbase_1']),
        '#define DGB_COINBASE_2 ' + json.dumps(dgb['coinbase_2']),
        '#define DGB_EXTRANONCE1 ' + json.dumps(dgb['extranonce1']),
        '#define DGB_EXTRANONCE2_LEN ' + str(dgb['extranonce2_len']),
        '#define DGB_HEIGHT ' + str(dgb['expected_height']),
        '#define DGB_TOTAL ' + str(dgb['expected_total_atoms']) + 'ULL',
        '#define DGB_PAYOUT_ADDRESS ' + json.dumps(dgb['expected_outputs'][-1]['address']),
    ]) + '\n')
    common_sources = ['components/stratum/base58.c', 'components/stratum/segwit_addr.c',
                      'components/stratum/utils.c', 'components/stratum/mining_network.c',
                      'components/stratum/bitcoin_hash.c']
    decoder = root / 'components/stratum/coinbase_decoder.c'
    compiler = os.environ.get('CC', 'gcc')
    base = [compiler, '-std=gnu23', '-g', '-ffunction-sections', '-fdata-sections',
            '-DMBEDTLS_ALLOW_PRIVATE_ACCESS', '-I' + str(work),
            '-I' + str(root / 'components/stratum/include'),
            '-I' + str(idf / 'components/mbedtls/mbedtls/include')]

    def build(name, harness, sanitized):
        flags = ['-O1', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] if sanitized else ['-O2']
        objects = []
        for backend in range(2 if compare else 1):
            output = work / f'{name}-{backend}.o'
            rename = ['-DCONFIG_COINBASE_RUST=1',
                      '-Dcoinbase_process_notification=coinbase_process_notification_rust',
                      '-Dcoinbase_decode_varint=coinbase_decode_varint_rust',
                      '-Dcoinbase_extract_height=coinbase_extract_height_rust',
                      '-Dcoinbase_decode_address_from_scriptpubkey=coinbase_decode_address_rust'] if backend else []
            subprocess.run([*base, *flags, *rename, '-c', str(decoder), '-o', str(output)], check=True)
            objects.append(str(output))
        binary = work / name
        subprocess.run([*base, *flags, *(['-DCOINBASE_COMPARE_RUST'] if compare else []),
                        str(root / harness), *[str(root / source) for source in common_sources],
                        *objects, *([str(rust_archive)] if compare else []),
                        '-Wl,--gc-sections', '-l:' + crypto, '-lm', '-o', str(binary)], check=True)
        return binary

    binary = build('decoder-test', 'tools/tests/coinbase_decoder_test.c', True)
    subprocess.run([str(binary)], check=True,
                   env={**os.environ, 'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
                        'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'})
    if args.benchmark:
        binary = build('decoder-benchmark', 'tools/tests/coinbase_benchmark.c', False)
        measurements = subprocess.check_output([str(binary)], text=True)
        samples = {}
        for row in measurements.splitlines():
            backend, outputs, _, nanos = row.split(',')
            samples.setdefault(f'{backend}_outputs_{outputs}', []).append(float(nanos))
        report = {
            'created_utc': datetime.now(timezone.utc).isoformat(),
            'scope': 'HOST ONLY; full decoder, shared C crypto; not ESP32 timing or hashrate',
            'machine': platform.platform(),
            'cc': subprocess.check_output([compiler, '--version'], text=True).splitlines()[0],
            'rustc': subprocess.check_output(['rustc', '--version'], text=True).strip(),
            'fixture_sha256': hashlib.sha256((root / 'tools/tests/fixtures/peercoin_bcmonster.json').read_bytes()).hexdigest(),
            'source_sha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in [
                'components/stratum/coinbase_decoder.c', 'components/stratum/include/coinbase_rust.h',
                'components/stratum/rust/src/lib.rs', 'tools/tests/coinbase_benchmark.c']},
            'iterations_per_sample': 50000,
            'median_ns': {key: statistics.median(values) for key, values in samples.items()},
            'samples_ns': samples,
        }
        print(json.dumps(report, indent=2))
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + '\n')
