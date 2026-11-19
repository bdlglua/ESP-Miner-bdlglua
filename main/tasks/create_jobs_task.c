#include <sys/time.h>
#include <limits.h>

#include "work_queue.h"
#include "global_state.h"
#include "esp_log.h"
#include "esp_system.h"
#include "mining.h"
#include "string.h"
#include "esp_timer.h"

#include "asic.h"
#include "system.h"
#include "esp_heap_caps.h"
#if CONFIG_BM1370_FIXED_JOBS
#include "bm1370_jobs.h"
#endif
#if CONFIG_MINING_WORK_PROFILE
#include <inttypes.h>
#include "bm1370_protocol.h"
#endif

static const char *TAG = "create_jobs_task";

static void generate_work(GlobalState *GLOBAL_STATE, mining_notify *notification, uint64_t extranonce_2, uint32_t difficulty);

void create_jobs_task(void *pvParameters)
{
    GlobalState *GLOBAL_STATE = (GlobalState *)pvParameters;

    // Initialize ASIC task module (moved from ASIC_task)
    if (!ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
        GLOBAL_STATE->ASIC_TASK_MODULE.active_jobs = heap_caps_calloc(128, sizeof(bm_job *), MALLOC_CAP_SPIRAM);
        GLOBAL_STATE->valid_jobs = heap_caps_calloc(128, sizeof(uint8_t), MALLOC_CAP_SPIRAM);
        if (!GLOBAL_STATE->ASIC_TASK_MODULE.active_jobs || !GLOBAL_STATE->valid_jobs) abort();
    }

    uint32_t difficulty = GLOBAL_STATE->pool_difficulty;
    mining_notify *current_mining_notification = NULL;
    uint64_t extranonce_2 = 0;
    int timeout_ms = ASIC_get_asic_job_frequency_ms(GLOBAL_STATE);

    ESP_LOGI(TAG, "ASIC Job Interval: %d ms", timeout_ms);
    ESP_LOGI(TAG, "ASIC Ready!");
    
    while (1) {
        uint64_t start_time = esp_timer_get_time();
        mining_notify *new_mining_notification = (mining_notify *)queue_dequeue_timeout(&GLOBAL_STATE->stratum_queue, timeout_ms);
        timeout_ms -= (esp_timer_get_time() - start_time) / 1000;
        if (timeout_ms < 0) timeout_ms = 0;

        if (new_mining_notification != NULL) {
            if (current_mining_notification != NULL) {
                STRATUM_V1_free_mining_notify(current_mining_notification);
            }

            ESP_LOGI(TAG, "New Work Dequeued %s", new_mining_notification->job_id);

            current_mining_notification = new_mining_notification;

            if (GLOBAL_STATE->new_set_mining_difficulty_msg) {
                ESP_LOGI(TAG, "New pool difficulty %lu", GLOBAL_STATE->pool_difficulty);
                difficulty = GLOBAL_STATE->pool_difficulty;
                GLOBAL_STATE->new_set_mining_difficulty_msg = false;
            }

            if (!ASIC_uses_fixed_jobs(GLOBAL_STATE) && GLOBAL_STATE->new_stratum_version_rolling_msg && GLOBAL_STATE->ASIC_initalized) {
                ESP_LOGI(TAG, "Set chip version rolls %i", (int)(GLOBAL_STATE->version_mask >> 13));
                ASIC_set_version_mask(GLOBAL_STATE, GLOBAL_STATE->version_mask);
                GLOBAL_STATE->new_stratum_version_rolling_msg = false;
            }

            extranonce_2 = 0;

            if (!current_mining_notification->clean_jobs) {
                continue;
            }
        } else {
            if (current_mining_notification == NULL) {
                vTaskDelay(100 / portTICK_PERIOD_MS);
                continue;
            }
        }

        // Generate and send job (either new work or incremented extranonce_2)
        generate_work(GLOBAL_STATE, current_mining_notification, extranonce_2, difficulty);
        extranonce_2++;
        timeout_ms = ASIC_get_asic_job_frequency_ms(GLOBAL_STATE);
    }
}

static void generate_work_impl(GlobalState *GLOBAL_STATE, mining_notify *notification, uint64_t extranonce_2, uint32_t difficulty)
{
#if CONFIG_BM1370_FIXED_JOBS
    if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
        bm1370_jobs_lock();
        bool current = notification->work_epoch == bm1370_jobs_epoch_locked();
        bm1370_jobs_unlock();
        if (!current || !GLOBAL_STATE->ASIC_initalized || !mining_prepare_bm1370_work(notification)) return;
        char extranonce_hex[2 * MAX_EXTRANONCE_2_LEN + 1];
        bm_job job;
        mining_build_bm1370_job(notification, extranonce_2, extranonce_hex, &job);
        ASIC_send_work(GLOBAL_STATE, &job); // Copies into the fixed job store under the epoch lock.
        return;
    }
#endif
    int extra_len = GLOBAL_STATE->extranonce_2_len;
    if (extra_len < 0 || extra_len > MAX_EXTRANONCE_2_LEN) return;
    char extranonce_hex[MAX_EXTRANONCE_2_LEN * 2 + 1];
    extranonce_2_generate(extranonce_2, extra_len, extranonce_hex);
    uint32_t version_mask = GLOBAL_STATE->version_mask;

    uint8_t tx_hash[32], merkle_root[32];
    calculate_coinbase_tx_hash(notification->coinbase_1, notification->coinbase_2,
                               GLOBAL_STATE->extranonce_str, extranonce_hex, tx_hash);
    calculate_merkle_root_hash(tx_hash, (const uint8_t (*)[32])notification->merkle_branches,
                              notification->n_merkle_branches, merkle_root);

    bm_job *job = malloc(sizeof(*job));
    if (!job) return;
    construct_bm_job(notification, merkle_root, version_mask, difficulty, job);
    job->extranonce2 = strdup(extranonce_hex);
    job->jobid = strdup(notification->job_id);
    job->work_epoch = notification->work_epoch;
    if (!GLOBAL_STATE->ASIC_initalized || !job->extranonce2 || !job->jobid) {
        free_bm_job(job);
        return;
    }
    ASIC_send_work(GLOBAL_STATE, job);
}

static void generate_work(GlobalState *GLOBAL_STATE, mining_notify *notification, uint64_t extranonce_2, uint32_t difficulty)
{
#if CONFIG_MINING_WORK_PROFILE
    int64_t started = esp_timer_get_time();
#endif
    generate_work_impl(GLOBAL_STATE, notification, extranonce_2, difficulty);
#if CONFIG_MINING_WORK_PROFILE
    int64_t elapsed = esp_timer_get_time() - started;
    // Includes blocking during ASIC dispatch and task preemption. Heap figures
    // describe the whole system; stack high-water mark is specific to this task.
#if CONFIG_COINBASE_RUST
    const char *backend = "rust";
#else
    const char *backend = "c";
#endif
    ESP_LOGI("work_profile", "backend=%s protocol=%s us=%" PRId64 " heap_min=%u stack_free_min=%u",
             backend, bm1370_protocol_backend(), elapsed, (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
             (unsigned)uxTaskGetStackHighWaterMark(NULL));
#endif
}
