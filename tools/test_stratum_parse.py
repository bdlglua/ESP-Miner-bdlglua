#!/usr/bin/env python3
"""Real Stratum parser and message writer against untrusted pool input, on host.

Only ESP-IDF declarations are stubbed. ASan/UBSan, no miner access.
"""
import os
from ctypes.util import find_library
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
idf = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf'))
stubs = {
    'esp_transport.h': '''#pragma once
typedef void *esp_transport_handle_t;
int esp_transport_read(esp_transport_handle_t, char *, int, int);
int esp_transport_write(esp_transport_handle_t, const char *, int, int);
int esp_transport_destroy(esp_transport_handle_t);
''',
    'esp_transport_ssl.h': '''#include "esp_transport.h"
esp_transport_handle_t esp_transport_ssl_init(void);
void esp_transport_ssl_crt_bundle_attach(esp_transport_handle_t, void (*)(void));
void esp_transport_ssl_set_cert_data(esp_transport_handle_t, const char *, int);
''',
    'esp_transport_tcp.h': '#include "esp_transport.h"\nesp_transport_handle_t esp_transport_tcp_init(void);\n',
    'esp_crt_bundle.h': 'void esp_crt_bundle_attach(void);\n',
    'esp_ota_ops.h': '',
    'esp_app_desc.h': '#pragma once\ntypedef struct {char version[32];} esp_app_desc_t;\n'
                      'const esp_app_desc_t *esp_app_get_description(void);\n',
    'esp_log.h': '#pragma once\n#define ESP_LOGI(t,...) ((void)(t))\n#define ESP_LOGW(t,...) ((void)(t))\n'
                 '#define ESP_LOGE(t,...) ((void)(t))\n',
    'esp_timer.h': '#include <stdint.h>\nint64_t esp_timer_get_time(void);\n',
    'freertos/FreeRTOS.h': '#pragma once\n',
    'freertos/task.h': '',
}
with tempfile.TemporaryDirectory(prefix='axeos-stratum-') as temporary:
    work = Path(temporary)
    for name, content in stubs.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    binary = work / 'stratum'
    subprocess.run([os.environ.get('CC', 'gcc'), '-std=gnu23', '-O1', '-g',
                    '-Wall', '-Wextra', '-Wno-unused-parameter', '-Wno-sign-compare',
                    '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                    '-DMBEDTLS_ALLOW_PRIVATE_ACCESS', '-I' + str(work),
                    '-I' + str(root / 'components/stratum/include'),
                    '-I' + str(idf / 'components/mbedtls/mbedtls/include'),
                    '-I' + str(idf / 'components/json/cJSON'),
                    str(root / 'tools/tests/stratum_parse_test.c'),
                    str(root / 'components/stratum/stratum_api.c'),
                    str(root / 'components/stratum/utils.c'),
                    str(root / 'components/stratum/bitcoin_hash.c'),
                    str(idf / 'components/json/cJSON/cJSON.c'),
                    '-l:' + find_library('mbedcrypto'), '-lm', '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(root / 'tools/tests/fixtures/zpool_sha256_live.jsonl')],
                   check=True, env={**os.environ,
        'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
        'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'})
