#!/usr/bin/env python3
"""Test production C/Rust BM1370 codecs and all dispatch modes (no device access)."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
crate = root / 'components/stratum/rust'
subprocess.run(['cargo', 'test', '--manifest-path', str(crate / 'Cargo.toml'),
                '--features', 'asic-protocol', '--locked', '--lib'], check=True)
subprocess.run(['cargo', 'build', '--manifest-path', str(crate / 'Cargo.toml'),
                '--features', 'asic-protocol', '--release', '--locked'], check=True)
with tempfile.TemporaryDirectory(prefix='axeos-bm1370-') as directory:
    for mode, flags in [('c', []), ('shadow', ['-DCONFIG_BM1370_PROTOCOL_RUST=1', '-DCONFIG_BM1370_PROTOCOL_SHADOW=1']),
                        ('rust', ['-DCONFIG_BM1370_PROTOCOL_RUST=1'])]:
        binary = Path(directory) / mode
        subprocess.run([os.environ.get('CC', 'gcc'), '-std=gnu23', '-O1', '-g',
                        '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                        '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections',
                        '-I' + str(root / 'components/asic/include'), *flags,
                        *(['-DBM1370_FAULT_TEST', '-Wl,--wrap=bm1370_rs_encode',
                           '-Wl,--wrap=bm1370_rs_decode'] if mode == 'shadow' else []),
                        str(root / 'tools/tests/bm1370_protocol_test.c'),
                        str(root / 'components/asic/bm1370_protocol.c'), str(root / 'components/asic/crc.c'),
                        str(crate / 'target/release/libaxeos_coinbase.a'),
                        '-Wl,--gc-sections', '-o', str(binary)], check=True)
        print('Dispatch mode:', mode, flush=True)
        subprocess.run([str(binary)], check=True, env={**os.environ,
                       'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
                       'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'})
