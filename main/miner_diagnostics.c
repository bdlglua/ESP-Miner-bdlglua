#include "miner_diagnostics.h"

#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_core_dump.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs.h"

#define INCIDENT_LIMIT 8
#define TRACE_LIMIT 16
#define REASON_LIMIT 10
#define SWITCH_LIMIT 12
#define INCIDENT_SCHEMA 1
#define RESTART_USER 0x41584531u
#define RESTART_UPDATE 0x41584532u

typedef struct {
    uint32_t sequence, reset_reason, restart_request;
    char boot_version[32];
    char task[17], panic_reason[160], elf_sha256[65];
    uint32_t pc, trace[TRACE_LIMIT];
    uint8_t trace_count, trace_corrupt, has_dump;
} Incident;

static struct {
    // last_dump_tail: last 4 bytes of the dump (its checksum), to skip a dump already recorded.
    uint32_t schema, count, last_dump_size, last_dump_tail;
    Incident items[INCIDENT_LIMIT];
} incidents;
static bool incidents_persisted;
static RTC_NOINIT_ATTR uint32_t restart_request;

const char *miner_reset_reason(int reason)
{
    switch (reason) {
        case ESP_RST_POWERON: return "Power-on reset";
        case ESP_RST_EXT: return "External reset";
        case ESP_RST_SW: return "Software reset via esp_restart";
        case ESP_RST_PANIC: return "Software reset due to exception/panic";
        case ESP_RST_INT_WDT: return "Interrupt watchdog reset";
        case ESP_RST_TASK_WDT: return "Task watchdog reset";
        case ESP_RST_WDT: return "Watchdog reset";
        case ESP_RST_DEEPSLEEP: return "Wake from deep sleep";
        case ESP_RST_BROWNOUT: return "Brownout reset";
        case ESP_RST_SDIO: return "SDIO reset";
        case ESP_RST_USB: return "USB reset";
        case ESP_RST_JTAG: return "JTAG reset";
        case ESP_RST_EFUSE: return "eFuse reset";
        case ESP_RST_PWR_GLITCH: return "Power glitch reset";
        case ESP_RST_CPU_LOCKUP: return "CPU lockup";
        default: return "Unknown reset";
    }
}

void incidents_mark_restart(bool firmware_update)
{
    restart_request = firmware_update ? RESTART_UPDATE : RESTART_USER;
}

static void attach_crash_summary(Incident *event)
{
#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH
    // ESP-IDF 6 dumps are ELF and end with their SHA-256 checksum; its last
    // 4 bytes fingerprint the dump, as the CRC32 did with ESP-IDF 5.
    size_t address, size;
    uint32_t tail;
    const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, NULL);
    if (event->reset_reason != ESP_RST_PANIC && event->reset_reason != ESP_RST_TASK_WDT &&
        event->reset_reason != ESP_RST_INT_WDT && event->reset_reason != ESP_RST_WDT) return;
    if (!part || esp_core_dump_image_get(&address, &size) != ESP_OK || address != part->address ||
        size < sizeof(tail) || size > part->size ||
        esp_partition_read(part, size - sizeof(tail), &tail, sizeof(tail)) != ESP_OK ||
        (size == incidents.last_dump_size && tail == incidents.last_dump_tail) ||
        esp_core_dump_image_check() != ESP_OK) return;

    esp_core_dump_summary_t summary = {0};
    if (esp_core_dump_get_summary(&summary) != ESP_OK) return;
    incidents.last_dump_size = size;
    incidents.last_dump_tail = tail;
    event->has_dump = true;
    memcpy(event->task, summary.exc_task, sizeof(summary.exc_task));
    snprintf(event->elf_sha256, sizeof(event->elf_sha256), "%.*s",
             (int)sizeof(summary.app_elf_sha256), (const char *)summary.app_elf_sha256);
    event->pc = summary.exc_pc;
#ifdef CONFIG_IDF_TARGET_ARCH_XTENSA
    event->trace_count = summary.exc_bt_info.depth < TRACE_LIMIT ? summary.exc_bt_info.depth : TRACE_LIMIT;
    memcpy(event->trace, summary.exc_bt_info.bt, event->trace_count * sizeof(event->trace[0]));
    event->trace_corrupt = summary.exc_bt_info.corrupted;
#endif
    if (esp_core_dump_get_panic_reason(event->panic_reason, sizeof(event->panic_reason)) != ESP_OK) {
        event->panic_reason[0] = '\0';
    }
    event->panic_reason[sizeof(event->panic_reason) - 1] = '\0';
#endif
}

void incidents_init(void)
{
    uint32_t request = restart_request;
    restart_request = 0;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("incidents", NVS_READWRITE, &handle);
    if (result == ESP_OK) {
        size_t size = sizeof(incidents);
        if (nvs_get_blob(handle, "boot_log", &incidents, &size) != ESP_OK ||
            size != sizeof(incidents) || incidents.schema != INCIDENT_SCHEMA ||
            incidents.count > INCIDENT_LIMIT) {
            memset(&incidents, 0, sizeof(incidents));
        }
    }
    incidents.schema = INCIDENT_SCHEMA;
    uint32_t next = incidents.count ? incidents.items[0].sequence + 1 : 1;
    size_t previous = incidents.count < INCIDENT_LIMIT ? incidents.count : INCIDENT_LIMIT - 1;
    memmove(&incidents.items[1], &incidents.items[0], previous * sizeof(Incident));
    incidents.count = previous + 1;
    Incident *event = &incidents.items[0];
    *event = (Incident){ .sequence = next, .reset_reason = esp_reset_reason() };
    if (event->reset_reason == ESP_RST_SW) event->restart_request = request;
    snprintf(event->boot_version, sizeof(event->boot_version), "%s", esp_app_get_description()->version);
    attach_crash_summary(event);

    if (result == ESP_OK) {
        result = nvs_set_blob(handle, "boot_log", &incidents, sizeof(incidents));
        if (result == ESP_OK) result = nvs_commit(handle);
        nvs_close(handle);
    }
    incidents_persisted = result == ESP_OK;
    if (!incidents_persisted) ESP_LOGW("incidents", "Could not save boot history: %s", esp_err_to_name(result));
}

cJSON *incidents_json(void)
{
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;
    cJSON_AddBoolToObject(root, "persisted", incidents_persisted);
    cJSON_AddBoolToObject(root, "crashCaptureEnabled",
#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH
                         true
#else
                         false
#endif
    );
    cJSON *entries = cJSON_AddArrayToObject(root, "entries");
    for (unsigned i = 0; entries && i < incidents.count; ++i) {
        const Incident *event = &incidents.items[i];
        cJSON *entry = cJSON_CreateObject();
        if (!entry) break;
        cJSON_AddItemToArray(entries, entry);
        cJSON_AddNumberToObject(entry, "sequence", event->sequence);
        const char *reason = miner_reset_reason(event->reset_reason);
        if (event->restart_request == RESTART_USER) reason = "Restart requested in AxeOS";
        if (event->restart_request == RESTART_UPDATE) reason = "Firmware update";
        cJSON_AddStringToObject(entry, "reason", reason);
        cJSON_AddStringToObject(entry, "bootVersion", event->boot_version);
        if (!event->has_dump) continue;
        cJSON_AddStringToObject(entry, "task", event->task);
        cJSON_AddStringToObject(entry, "panic", event->panic_reason);
        cJSON_AddStringToObject(entry, "elfSha256", event->elf_sha256);
        cJSON_AddNumberToObject(entry, "pc", event->pc);
        cJSON_AddBoolToObject(entry, "partialTrace", event->trace_corrupt);
        cJSON *trace = cJSON_AddArrayToObject(entry, "backtrace");
        for (unsigned j = 0; trace && j < event->trace_count; ++j) {
            cJSON_AddItemToArray(trace, cJSON_CreateNumber(event->trace[j]));
        }
    }
    return root;
}

typedef struct {
    char message[64];
    uint32_t count;
} RejectReason;

typedef struct {
    uint32_t accepted, rejected, other_rejections, latency_samples;
    float last_ms;
    double total_ms;
    unsigned reason_count;
    RejectReason reasons[REASON_LIMIT];
} PoolCounters;

typedef struct {
    bool fallback;
    const char *reason; // Static string literal from the Stratum task.
    int64_t uptime;
} Switch;

typedef struct {
    bool selected, fallback;
    PoolCounters pools[2];
    Switch switches[SWITCH_LIMIT];
    unsigned next_switch, switch_count;
} PoolStatistics;

static PoolStatistics stats;
static pthread_mutex_t stats_lock = PTHREAD_MUTEX_INITIALIZER;

void pool_stats_select(bool fallback, const char *switch_reason)
{
    pthread_mutex_lock(&stats_lock);
    if (stats.selected && stats.fallback != fallback) {
        stats.switches[stats.next_switch] = (Switch){fallback, switch_reason, esp_timer_get_time() / 1000000};
        stats.next_switch = (stats.next_switch + 1) % SWITCH_LIMIT;
        if (stats.switch_count < SWITCH_LIMIT) stats.switch_count++;
    }
    stats.selected = true;
    stats.fallback = fallback;
    pthread_mutex_unlock(&stats_lock);
}

static void add_reject_reason(PoolCounters *pool, const char *reason)
{
    if (!reason || !reason[0]) reason = "unknown";
    for (unsigned i = 0; i < pool->reason_count; ++i) {
        if (strncmp(pool->reasons[i].message, reason, sizeof(pool->reasons[i].message) - 1) == 0) {
            pool->reasons[i].count++;
            return;
        }
    }
    if (pool->reason_count == REASON_LIMIT) {
        pool->other_rejections++;
        return;
    }
    RejectReason *entry = &pool->reasons[pool->reason_count++];
    snprintf(entry->message, sizeof(entry->message), "%s", reason);
    entry->count = 1;
}

void pool_stats_share(bool fallback, bool accepted, const char *reason, float latency_ms)
{
    pthread_mutex_lock(&stats_lock);
    PoolCounters *pool = &stats.pools[fallback];
    if (accepted) pool->accepted++;
    else {
        pool->rejected++;
        add_reject_reason(pool, reason);
    }
    if (latency_ms >= 0) {
        pool->last_ms = latency_ms;
        pool->total_ms += latency_ms;
        pool->latency_samples++;
    }
    pthread_mutex_unlock(&stats_lock);
}

static void add_pool(cJSON *root, const char *key, const char *host, unsigned port, const PoolCounters *pool)
{
    cJSON *entry = cJSON_AddObjectToObject(root, key);
    if (!entry) return;
    cJSON_AddStringToObject(entry, "host", host ? host : "");
    cJSON_AddNumberToObject(entry, "port", port);
    cJSON_AddNumberToObject(entry, "accepted", pool->accepted);
    cJSON_AddNumberToObject(entry, "rejected", pool->rejected);
    if (pool->latency_samples) {
        cJSON_AddNumberToObject(entry, "lastMs", pool->last_ms);
        cJSON_AddNumberToObject(entry, "averageMs", pool->total_ms / pool->latency_samples);
    }
    cJSON *reasons = cJSON_AddArrayToObject(entry, "reasons");
    for (unsigned i = 0; reasons && i < pool->reason_count + (pool->other_rejections > 0); ++i) {
        cJSON *reason = cJSON_CreateObject();
        if (!reason) break;
        cJSON_AddItemToArray(reasons, reason);
        cJSON_AddStringToObject(reason, "message", i < pool->reason_count ? pool->reasons[i].message : "Other reasons");
        cJSON_AddNumberToObject(reason, "count", i < pool->reason_count ? pool->reasons[i].count : pool->other_rejections);
    }
}

cJSON *pool_stats_json(const char *primary_host, unsigned primary_port,
                     const char *fallback_host, unsigned fallback_port)
{
    PoolStatistics *snapshot = malloc(sizeof(*snapshot));
    if (!snapshot) return NULL;
    pthread_mutex_lock(&stats_lock);
    *snapshot = stats;
    pthread_mutex_unlock(&stats_lock);
    cJSON *root = cJSON_CreateObject();
    if (root) {
        if (snapshot->selected) cJSON_AddStringToObject(root, "selected", snapshot->fallback ? "fallback" : "primary");
        add_pool(root, "primary", primary_host, primary_port, &snapshot->pools[0]);
        add_pool(root, "fallback", fallback_host, fallback_port, &snapshot->pools[1]);
        cJSON *history = cJSON_AddArrayToObject(root, "switches");
        for (unsigned i = 0; history && i < snapshot->switch_count; ++i) {
            const Switch *event = &snapshot->switches[(snapshot->next_switch + SWITCH_LIMIT - 1 - i) % SWITCH_LIMIT];
            cJSON *entry = cJSON_CreateObject();
            if (!entry) break;
            cJSON_AddItemToArray(history, entry);
            cJSON_AddStringToObject(entry, "pool", event->fallback ? "fallback" : "primary");
            cJSON_AddStringToObject(entry, "reason", event->reason);
            cJSON_AddNumberToObject(entry, "uptimeSeconds", event->uptime);
        }
    }
    free(snapshot);
    return root;
}
