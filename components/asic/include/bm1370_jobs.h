#ifndef BM1370_JOBS_H
#define BM1370_JOBS_H

#include <stdbool.h>
#include <stdint.h>
#include "mining.h"

#define BM1370_JOB_ID_CAP 256
#define BM1370_JOB_EXTRA_CAP 64

typedef struct {
    uint32_t epoch, generation, raw_slot;
} bm1370_job_token;

/* Owns both strings. Do not copy this struct without rebinding job pointers. */
typedef struct {
    bm_job job;
    char id[BM1370_JOB_ID_CAP + 1];
    char extra[BM1370_JOB_EXTRA_CAP + 1];
    bm1370_job_token token;
} bm1370_job_snapshot;

typedef struct {
    bm1370_job_token token;
    uint32_t ntime, nonce, version_bits;
    char id[BM1370_JOB_ID_CAP + 1];
    char extra[BM1370_JOB_EXTRA_CAP + 1];
} bm1370_pending_share;

#define BM1370_SHARE_QUEUE_CAP 8

/* One lock orders job publication, invalidation and the share queue.
 * The Stratum task owns network writes and never holds this lock during I/O. */
void bm1370_jobs_lock(void);
void bm1370_jobs_unlock(void);
uint32_t bm1370_jobs_epoch_locked(void);
void bm1370_jobs_clear_locked(const char *reason);
int bm1370_jobs_store_locked(uint8_t raw_slot, const bm_job *job);
bool bm1370_jobs_current_locked(const bm1370_job_token *token);
// 1 = queued, 0 = obsolete job, -1 = full. All operations require the lock.
int bm1370_jobs_queue_share_locked(const bm1370_job_snapshot *snapshot, uint32_t nonce, uint32_t version_bits);
bool bm1370_jobs_take_share_locked(bm1370_pending_share *share);
bool bm1370_jobs_read(uint8_t raw_slot, bm1370_job_snapshot *output);

#endif
