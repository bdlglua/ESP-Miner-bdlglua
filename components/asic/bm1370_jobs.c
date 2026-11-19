#include "bm1370_jobs.h"
#include "esp_log.h"
#include "utils.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

/* ABI is deliberately pointer-free; Rust owns exactly 16 bounded job slots. */
typedef struct {
    uint8_t header[80];
    uint32_t version_mask, difficulty;
    char id[257], extra[65];
    bm1370_job_token token;
} job_data;
_Static_assert(sizeof(job_data) == 424, "Rust job snapshot ABI");
extern uint32_t bm1370_jobs_rs_epoch(void);
extern int bm1370_jobs_rs_clear(void);
extern int bm1370_jobs_rs_insert(uint8_t, uint32_t, const uint8_t *, uint32_t, uint32_t,
                                 const char *, size_t, const char *, size_t);
extern int bm1370_jobs_rs_read(uint8_t, job_data *);
extern int bm1370_jobs_rs_current(const bm1370_job_token *);

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static uint32_t published;
static bm1370_pending_share pending[BM1370_SHARE_QUEUE_CAP];
static unsigned share_head, share_count;
void bm1370_jobs_lock(void) { pthread_mutex_lock(&lock); }
void bm1370_jobs_unlock(void) { pthread_mutex_unlock(&lock); }
uint32_t bm1370_jobs_epoch_locked(void) { return bm1370_jobs_rs_epoch(); }
void bm1370_jobs_clear_locked(const char *reason)
{
    /* Never wrap an epoch and accidentally revive old work. */
    if (!bm1370_jobs_rs_clear()) abort();
    share_head = share_count = 0;
    ESP_LOGI("job_store", "reset reason=%s epoch=%" PRIu32 " published=%" PRIu32,
             reason, bm1370_jobs_rs_epoch(), published);
}

int bm1370_jobs_store_locked(uint8_t raw, const bm_job *job)
{
    if (!job || !job->jobid || !job->extranonce2) return -1;
    uint8_t header[80];
    bm_job_to_header(job, job->starting_nonce, job->version, header);
    int ret = bm1370_jobs_rs_insert(raw, job->work_epoch, header, job->version_mask, job->pool_diff,
        job->jobid, strnlen(job->jobid, 257), job->extranonce2, strnlen(job->extranonce2, 65));
    if (ret == 1) {
        published++;
        if (published == 1 || published % 128 == 0)
            ESP_LOGI("job_store", "fixed slots=16 bytes=6212 published=%" PRIu32 " epoch=%" PRIu32,
                     published, bm1370_jobs_rs_epoch());
    } else if (ret < 0) {
        ESP_LOGE("job_store", "Job rejected: invalid slot, ID >256 bytes, or invalid extranonce (no truncation)");
    }
    return ret;
}

bool bm1370_jobs_current_locked(const bm1370_job_token *token)
{
    return bm1370_jobs_rs_current(token) == 1;
}

int bm1370_jobs_queue_share_locked(const bm1370_job_snapshot *snapshot, uint32_t nonce, uint32_t version_bits)
{
    if (!bm1370_jobs_current_locked(&snapshot->token)) return 0;
    if (share_count == BM1370_SHARE_QUEUE_CAP) return -1;
    bm1370_pending_share *entry = &pending[(share_head + share_count) % BM1370_SHARE_QUEUE_CAP];
    entry->token = snapshot->token;
    entry->ntime = snapshot->job.ntime;
    entry->nonce = nonce;
    entry->version_bits = version_bits;
    strcpy(entry->id, snapshot->id);
    strcpy(entry->extra, snapshot->extra);
    share_count++;
    return 1;
}

bool bm1370_jobs_take_share_locked(bm1370_pending_share *share)
{
    while (share_count) {
        const bm1370_pending_share *entry = &pending[share_head];
        share_head = (share_head + 1) % BM1370_SHARE_QUEUE_CAP;
        share_count--;
        if (bm1370_jobs_current_locked(&entry->token)) {
            *share = *entry;
            return true;
        }
    }
    return false;
}

bool bm1370_jobs_read(uint8_t raw, bm1370_job_snapshot *output)
{
    job_data data;
    bm1370_jobs_lock();
    int found = bm1370_jobs_rs_read(raw, &data);
    bm1370_jobs_unlock();
    if (!found) return false;
    memset(output, 0, sizeof(*output));
    bm_job *job = &output->job;
    memcpy(&job->version, data.header, 4);
    reverse_32bit_words(data.header + 4, job->prev_block_hash);
    reverse_32bit_words(data.header + 36, job->merkle_root);
    memcpy(&job->ntime, data.header + 68, 4);
    memcpy(&job->target, data.header + 72, 4);
    memcpy(&job->starting_nonce, data.header + 76, 4);
    job->version_mask = data.version_mask;
    job->pool_diff = data.difficulty;
    job->work_epoch = data.token.epoch;
    memcpy(output->id, data.id, sizeof(output->id));
    memcpy(output->extra, data.extra, sizeof(output->extra));
    output->token = data.token;
    job->jobid = output->id;
    job->extranonce2 = output->extra;
    return true;
}
