#!/usr/bin/env python3
"""Exercise production NVS string lifetimes and WebSocket log formatting under ASan.

The complete NVS translation unit is included; only IDF/RTOS/flash calls are mocked.
The log hook is extracted verbatim to isolate formatting from the HTTP server.
"""
import argparse,os,re,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--case',choices=['nvs-read','nvs-compare','log-format','log-full','log-oom','all'],default='all');args=p.parse_args()
with tempfile.TemporaryDirectory(prefix='axeos-runtime-') as td:
    work=Path(td)
    stubs={
      'esp_err.h':'#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_FAIL -1\n#define ESP_ERR_NVS_NOT_FOUND -2\n#define ESP_ERR_NVS_NO_FREE_PAGES -3\n#define ESP_ERR_NVS_NEW_VERSION_FOUND -4\n',
      'esp_log.h':'#pragma once\n#define ESP_LOGE(...) ((void)0)\n#define ESP_LOGW(...) ((void)0)\n#define ESP_LOGI(...) ((void)0)\n',
      'freertos/FreeRTOS.h':'#pragma once\n#include <stddef.h>\ntypedef int BaseType_t; typedef void *TaskHandle_t; typedef void *QueueHandle_t;\n#define portMAX_DELAY 0xffffffff\n#define pdTRUE 1\n#define pdPASS 1\n',
      'freertos/queue.h':'#include "FreeRTOS.h"\nint xQueueReceive(QueueHandle_t,void *,unsigned);\nint xQueueSend(QueueHandle_t,const void *,unsigned);\nQueueHandle_t xQueueCreate(unsigned,unsigned);\n',
      'freertos/task.h':'#include "FreeRTOS.h"\nint xTaskCreate(void (*)(void *),const char *,unsigned,void *,unsigned,TaskHandle_t *);\n',
      'freertos/event_groups.h':'',
      'theme_api.h':'#define DEFAULT_THEME "dark"\n#define DEFAULT_COLORS "{}"\n',
      'nvs_flash.h':'int nvs_flash_init(void); int nvs_flash_erase(void);\n',
      'nvs.h':'''#pragma once
#include <stdint.h>
#include <stddef.h>
typedef int nvs_handle_t;
#define NVS_READWRITE 1
int nvs_open(const char *,int,nvs_handle_t *);
int nvs_find_key(nvs_handle_t,const char *,void *);
int nvs_commit(nvs_handle_t);
int nvs_get_str(nvs_handle_t,const char *,char *,size_t *);
int nvs_set_str(nvs_handle_t,const char *,const char *);
'''+''.join(f'int nvs_get_{t}(nvs_handle_t,const char *,{c} *);\nint nvs_set_{t}(nvs_handle_t,const char *,{c});\n' for t,c in [('u16','uint16_t'),('i32','int32_t'),('u64','uint64_t')]),
    }
    src=(ROOT/'main/nvs_config.c').read_text()
    strings=set(re.findall(r'\(char \*\)(CONFIG_\w+)',src))
    stubs['test_config.h']='\n'.join('#define '+name+(' "test"' if name in strings else ' 1') for name in sorted(set(re.findall(r'\bCONFIG_\w+',src))))
    for name,content in stubs.items():
        path=work/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
    common=[os.environ.get('CC','gcc'),'-std=gnu23','-g','-O1','-pthread','-Wall','-Wextra','-Wno-unused-parameter','-Wno-unused-variable','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I'+str(work),'-I'+str(ROOT/'main')]
    env={**os.environ,'ASAN_OPTIONS':'detect_leaks=1:halt_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'}
    if args.case.startswith('nvs') or args.case=='all':
        binary=work/'nvs-test'
        subprocess.run([*common,'-include',str(work/'test_config.h'),str(ROOT/'tools/tests/nvs_strings_test.c'),'-Wl,--wrap=strdup','-Wl,--wrap=strcmp','-o',str(binary)],check=True)
        for mode in (['read','compare'] if args.case=='all' else [args.case.removeprefix('nvs-')]):
            subprocess.run([str(binary),mode],check=True,env=env,timeout=20)
    if args.case.startswith('log') or args.case=='all':
        source=(ROOT/'main/http_server/websocket.c').read_text()
        hook=re.search(r'int log_to_queue\(.*?\n\}',source,re.S)
        assert hook
        (work/'production_log_hook.h').write_text(hook[0])
        binary=work/'log-test'
        subprocess.run([*common,str(ROOT/'tools/tests/websocket_log_test.c'),'-Wl,--wrap=calloc','-o',str(binary)],check=True)
        for mode in (['format','full','oom'] if args.case=='all' else [args.case.removeprefix('log-')]):
            subprocess.run([str(binary),mode],check=True,env=env,timeout=20)
