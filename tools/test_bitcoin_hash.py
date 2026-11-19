#!/usr/bin/env python3
"""Self-contained SHA-256/RIPEMD-160 against reference vectors and mbedTLS 3, on host.

mbedTLS (system library, ESP-IDF 5.5 headers) is used only as the reference.
ASan/UBSan, no miner access.
"""
import os
from ctypes.util import find_library
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
idf = Path(os.environ.get('IDF55_PATH', Path.home() / 'esp/esp-idf'))
with tempfile.TemporaryDirectory(prefix='axeos-hash-') as temporary:
    binary = Path(temporary) / 'hash'
    subprocess.run([os.environ.get('CC', 'gcc'), '-std=gnu23', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                    '-DMBEDTLS_ALLOW_PRIVATE_ACCESS',
                    '-I' + str(root / 'components/stratum/include'),
                    '-I' + str(idf / 'components/mbedtls/mbedtls/include'),
                    str(root / 'tools/tests/bitcoin_hash_test.c'),
                    str(root / 'components/stratum/bitcoin_hash.c'),
                    '-l:' + find_library('mbedcrypto'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, env={**os.environ,
        'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
        'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'})
