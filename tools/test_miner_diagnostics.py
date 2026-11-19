#!/usr/bin/env python3
"""Exercise diagnostic storage and JSON against mocked ESP-IDF flash and time."""
import os
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
idf_json = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
headers = {
    'esp_app_desc.h': """
typedef struct { char version[32]; } esp_app_desc_t;
const esp_app_desc_t *esp_app_get_description(void);
""",
    'esp_attr.h': '#define RTC_NOINIT_ATTR',
    'esp_system.h': """
enum { ESP_RST_POWERON=1, ESP_RST_EXT, ESP_RST_SW, ESP_RST_PANIC, ESP_RST_INT_WDT,
       ESP_RST_TASK_WDT, ESP_RST_WDT, ESP_RST_DEEPSLEEP, ESP_RST_BROWNOUT,
       ESP_RST_SDIO, ESP_RST_USB, ESP_RST_JTAG, ESP_RST_EFUSE, ESP_RST_PWR_GLITCH,
       ESP_RST_CPU_LOCKUP };
int esp_reset_reason(void);
""",
    'esp_timer.h': '#include <stdint.h>\nint64_t esp_timer_get_time(void);',
    'esp_log.h': '#define ESP_LOGW(...) ((void)0)',
    'nvs.h': """
#include <stddef.h>
typedef int esp_err_t;
typedef int nvs_handle_t;
#define ESP_OK 0
#define NVS_READWRITE 1
esp_err_t nvs_open(const char *, int, nvs_handle_t *);
esp_err_t nvs_get_blob(nvs_handle_t, const char *, void *, size_t *);
esp_err_t nvs_set_blob(nvs_handle_t, const char *, const void *, size_t);
esp_err_t nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
""",
    'esp_partition.h': """
#include <stddef.h>
#define ESP_PARTITION_TYPE_DATA 1
#define ESP_PARTITION_SUBTYPE_DATA_COREDUMP 3
typedef struct { size_t address, size; } esp_partition_t;
const esp_partition_t *esp_partition_find_first(int, int, const char *);
int esp_partition_read(const esp_partition_t *, size_t, void *, size_t);
""",
    'esp_core_dump.h': """
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
typedef struct {
  char exc_task[16];
  uint8_t app_elf_sha256[65];
  uint32_t exc_pc;
  struct { uint32_t bt[16], depth; bool corrupted; } exc_bt_info;
} esp_core_dump_summary_t;
int esp_core_dump_image_get(size_t *, size_t *);
int esp_core_dump_image_check(void);
int esp_core_dump_get_summary(esp_core_dump_summary_t *);
int esp_core_dump_get_panic_reason(char *, size_t);
""",
}
with tempfile.TemporaryDirectory(prefix='axeos-diagnostics-') as tmp:
    work = Path(tmp)
    for name, contents in headers.items():
        (work / name).write_text(contents)
    binary = work / 'diagnostics'
    subprocess.run([
        os.environ.get('CC', 'gcc'), '-std=gnu23', '-g', '-O1', '-Wall', '-Wextra', '-Werror',
        '-Wno-unused-parameter', '-pthread', '-fsanitize=address,undefined',
        '-DCONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=1', '-DCONFIG_IDF_TARGET_ARCH_XTENSA=1',
        '-I' + str(work), '-I' + str(root / 'main'), '-I' + str(idf_json),
        str(root / 'tools/tests/miner_diagnostics_test.c'), str(idf_json / 'cJSON.c'),
        '-lm', '-o', str(binary)
    ], check=True)
    subprocess.run([str(binary)], check=True, env={**os.environ, 'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1', 'UBSAN_OPTIONS': 'halt_on_error=1'})
