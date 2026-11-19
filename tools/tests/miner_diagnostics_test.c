#include <assert.h>
#include <math.h>
#include "../../main/miner_diagnostics.c"

static unsigned char flash[sizeof(incidents)];
static bool stored, fail_commit, dump_present, dump_valid;
static int reset;
static int64_t clock_us;
static uint32_t dump_crc;
static const esp_partition_t partition = {0xf12000, 65536};

const esp_app_desc_t *esp_app_get_description(void) {
    static const esp_app_desc_t app = {.version = "test-version"};
    return &app;
}
int esp_reset_reason(void) { return reset; }
int64_t esp_timer_get_time(void) { return clock_us; }
int nvs_open(const char *ns, int access, nvs_handle_t *handle) { *handle = 1; return ESP_OK; }
int nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *size) {
    if (!stored || *size < sizeof(flash)) return -1;
    memcpy(out, flash, sizeof(flash));
    *size = sizeof(flash);
    return ESP_OK;
}
int nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t size) {
    assert(size == sizeof(flash));
    if (!fail_commit) memcpy(flash, value, size);
    return ESP_OK;
}
int nvs_commit(nvs_handle_t handle) {
    if (fail_commit) return -1;
    stored = true;
    return ESP_OK;
}
void nvs_close(nvs_handle_t handle) {}
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *name) { return &partition; }
int esp_partition_read(const esp_partition_t *part, size_t offset, void *out, size_t size) {
    assert(offset == 1024 - sizeof(dump_crc) && size == sizeof(dump_crc));
    memcpy(out, &dump_crc, size);
    return ESP_OK;
}
int esp_core_dump_image_get(size_t *address, size_t *size) {
    *address = partition.address;
    *size = 1024;
    return dump_present ? ESP_OK : -1;
}
int esp_core_dump_image_check(void) { return dump_valid ? ESP_OK : -1; }
int esp_core_dump_get_summary(esp_core_dump_summary_t *summary) {
    strcpy(summary->exc_task, "mining");
    memset(summary->app_elf_sha256, 'a', 64);
    summary->exc_pc = 0x42001234;
    summary->exc_bt_info.bt[0] = 0x42001234;
    summary->exc_bt_info.depth = 1;
    return ESP_OK;
}
int esp_core_dump_get_panic_reason(char *out, size_t size) {
    snprintf(out, size, "Example panic");
    return ESP_OK;
}

static cJSON *boot(int reason) {
    reset = reason;
    memset(&incidents, 0, sizeof(incidents)); // Simulate loss of all normal RAM.
    incidents_init();
    return incidents_json();
}

static cJSON *entry(cJSON *body, unsigned index) {
    return cJSON_GetArrayItem(cJSON_GetObjectItem(body, "entries"), index);
}

static void check_incidents(void) {
    cJSON *body = boot(ESP_RST_POWERON);
    assert(cJSON_IsTrue(cJSON_GetObjectItem(body, "persisted")));
    assert(!strcmp(cJSON_GetObjectItem(entry(body, 0), "reason")->valuestring, "Power-on reset"));
    cJSON_Delete(body);

    incidents_mark_restart(false);
    body = boot(ESP_RST_SW);
    assert(!strcmp(cJSON_GetObjectItem(entry(body, 0), "reason")->valuestring, "Restart requested in AxeOS"));
    assert(entry(body, 1));
    cJSON_Delete(body);

    dump_present = dump_valid = true;
    dump_crc = 0xabcd;
    body = boot(ESP_RST_PANIC);
    assert(cJSON_GetObjectItem(entry(body, 0), "pc")->valueint == 0x42001234);
    assert(cJSON_GetArraySize(cJSON_GetObjectItem(entry(body, 0), "backtrace")) == 1);
    cJSON_Delete(body);
    body = boot(ESP_RST_PANIC);
    assert(!cJSON_GetObjectItem(entry(body, 0), "pc") && cJSON_GetObjectItem(entry(body, 1), "pc"));
    cJSON_Delete(body);
    dump_crc++;
    dump_valid = false;
    body = boot(ESP_RST_PANIC);
    assert(!cJSON_GetObjectItem(entry(body, 0), "pc"));
    cJSON_Delete(body);

    for (int i = 0; i < 12; ++i) cJSON_Delete(boot(ESP_RST_SW));
    fail_commit = true;
    body = boot(ESP_RST_BROWNOUT);
    assert(cJSON_IsFalse(cJSON_GetObjectItem(body, "persisted")));
    assert(cJSON_GetArraySize(cJSON_GetObjectItem(body, "entries")) == INCIDENT_LIMIT);
    assert(cJSON_GetObjectItem(entry(body, 0), "sequence")->valueint == 18);
    cJSON_Delete(body);
}

static void check_pools(void) {
    pool_stats_select(false, "Startup");
    pool_stats_share(false, true, NULL, 20);
    pool_stats_share(false, false, "Stale", 40);
    for (int i = 0; i < 15; ++i) {
        clock_us += 1000000;
        pool_stats_select(i % 2 == 0, "Changed");
    }
    pool_stats_share(true, true, NULL, 50);
    for (int i = 0; i < 13; ++i) {
        char reason[20];
        snprintf(reason, sizeof(reason), "Reason %d", i);
        pool_stats_share(true, false, reason, -1);
    }
    cJSON *body = pool_stats_json("primary.test", 1234, "fallback.test", 2345);
    cJSON *p = cJSON_GetObjectItem(body, "primary");
    cJSON *f = cJSON_GetObjectItem(body, "fallback");
    assert(cJSON_GetObjectItem(p, "accepted")->valueint == 1);
    assert(cJSON_GetObjectItem(p, "rejected")->valueint == 1);
    assert(fabs(cJSON_GetObjectItem(p, "averageMs")->valuedouble - 30) < 1e-6);
    assert(cJSON_GetObjectItem(f, "rejected")->valueint == 13);
    assert(cJSON_GetObjectItem(f, "averageMs")->valueint == 50);
    cJSON *reasons = cJSON_GetObjectItem(f, "reasons");
    assert(cJSON_GetArraySize(reasons) == REASON_LIMIT + 1);
    assert(cJSON_GetObjectItem(cJSON_GetArrayItem(reasons, REASON_LIMIT), "count")->valueint == 3);
    cJSON *switches = cJSON_GetObjectItem(body, "switches");
    assert(cJSON_GetArraySize(switches) == SWITCH_LIMIT);
    assert(cJSON_GetObjectItem(cJSON_GetArrayItem(switches, 0), "uptimeSeconds")->valueint == 15);
    cJSON_Delete(body);
}

int main(void) {
    check_incidents();
    check_pools();
    puts("PASS: bounded persistent boot history, distinct crash trace, pool totals and switch history");
}
