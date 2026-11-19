#!/usr/bin/env python3
"""Production job generation, UART dispatch, Rust store and C nonce checks on host.

Only ESP-IDF/RTOS/hardware declarations are stubbed. No miner access.
"""
import os
from ctypes.util import find_library
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
crate = root / 'components/stratum/rust'
for action in ('test', 'build'):
    subprocess.run(['cargo', action, '--manifest-path', str(crate / 'Cargo.toml'),
                    '--features', 'fixed-jobs,asic-protocol', '--locked',
                    *(['--lib'] if action == 'test' else ['--release'])], check=True)
idf = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf'))
with tempfile.TemporaryDirectory(prefix='axeos-jobs-') as temporary:
    work = Path(temporary)
    stubs = {
        'esp_err.h': '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_FAIL -1\n',
        'esp_transport.h': '''#pragma once
typedef void *esp_transport_handle_t;
int esp_transport_read(esp_transport_handle_t, char *, int, int);
int esp_transport_write(esp_transport_handle_t, const char *, int, int);
int esp_transport_destroy(esp_transport_handle_t);
#define ERR_TCP_TRANSPORT_NO_MEM -2
#define ERR_TCP_TRANSPORT_CONNECTION_FAILED -3
#define ERR_TCP_TRANSPORT_CONNECTION_CLOSED_BY_FIN -4
''',
        'esp_transport_ssl.h': '''#include "esp_transport.h"
esp_transport_handle_t esp_transport_ssl_init(void);
void esp_transport_ssl_crt_bundle_attach(esp_transport_handle_t, void (*)(void));
void esp_transport_ssl_set_cert_data(esp_transport_handle_t, const char *, int);
''',
        'esp_transport_tcp.h': '#include "esp_transport.h"\nesp_transport_handle_t esp_transport_tcp_init(void);\n',
        'esp_crt_bundle.h': 'void esp_crt_bundle_attach(void);\n',
        'esp_ota_ops.h': 'void esp_restart(void);\n',
        'esp_app_desc.h': 'typedef struct {char version[32];} esp_app_desc_t;\nconst esp_app_desc_t *esp_app_get_description(void);\n',
        'esp_log.h': '#pragma once\n#define ESP_LOGD(t,...) ((void)(t))\n#define ESP_LOGI(t,...) ((void)(t))\n#define ESP_LOGW(t,...) ((void)(t))\n#define ESP_LOGE(t,...) ((void)(t))\n',
        'esp_system.h': '', 'system.h': '',
        'esp_timer.h': '#include <stdint.h>\nint64_t esp_timer_get_time(void);\n',
        'freertos/FreeRTOS.h': '#pragma once\n#define portTICK_PERIOD_MS 1\n#define pdMS_TO_TICKS(n) (n)\nvoid vTaskDelay(unsigned);\n',
        'freertos/task.h': '#include "FreeRTOS.h"\n',
        'esp_heap_caps.h': '#include <stdlib.h>\n#define MALLOC_CAP_SPIRAM 1\n#define heap_caps_calloc(n,s,c) calloc(n,s)\n',
        'global_state.h': '''#pragma once
#include <stdbool.h>
#include "work_queue.h"
#include "freertos/FreeRTOS.h"
enum { BM1370 = 1370 };
typedef struct {
 struct { struct { struct { int id; } asic; } family; } DEVICE_CONFIG;
 struct { bm_job **active_jobs; } ASIC_TASK_MODULE;
 uint8_t *valid_jobs; pthread_mutex_t valid_jobs_lock;
 uint32_t pool_difficulty, version_mask;
 bool new_set_mining_difficulty_msg, new_stratum_version_rolling_msg, ASIC_initalized;
 char *extranonce_str; int extranonce_2_len; work_queue stratum_queue;
} GlobalState;
''',
    }
    for name, content in stubs.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    binary = work / 'jobs'
    sources = ['tools/tests/bm1370_jobs_test.c', 'components/asic/bm1370_jobs.c',
               'components/asic/bm1370.c', 'components/asic/bm1370_protocol.c',
               'components/asic/crc.c', 'components/stratum/mining.c', 'components/stratum/utils.c', 'components/stratum/bitcoin_hash.c',
               'components/stratum/stratum_api.c']
    subprocess.run([os.environ.get('CC', 'gcc'), '-std=gnu23', '-O1', '-g',
                    '-Wall', '-Wextra', '-Wno-unused-variable', '-Wno-unused-parameter',
                    '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                    '-ffunction-sections', '-fdata-sections', '-pthread',
                    '-DCONFIG_BM1370_FIXED_JOBS=1', '-DCONFIG_BM1370_PROTOCOL_RUST=1',
                    '-DMBEDTLS_ALLOW_PRIVATE_ACCESS', '-I' + str(work),
                    '-I' + str(root / 'components/asic/include'),
                    '-I' + str(root / 'components/stratum/include'), '-I' + str(root / 'main'),
                    '-I' + str(idf / 'components/mbedtls/mbedtls/include'),
                    '-I' + str(idf / 'components/json/cJSON'),
                    *[str(root / name) for name in sources],
                    str(crate / 'target/release/libaxeos_coinbase.a'),
                    '-Wl,--gc-sections', '-Wl,--wrap=malloc', '-Wl,--wrap=strdup',
                    '-l:' + find_library('mbedcrypto'), '-l:' + find_library('cjson'),
                    '-lm', '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, env={**os.environ,
        'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
        'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'})
