#ifndef STRATUM_TASK_H_
#define STRATUM_TASK_H_

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    char job_id[257];
    char previous_block_hash[65];
    uint32_t version, bits, timestamp, height;
    double difficulty;
} zpool_job_header_t;

bool stratum_get_zpool_job_header(zpool_job_header_t *header);

void stratum_task(void *pvParameters);
void stratum_close_connection(GlobalState * GLOBAL_STATE);

#endif
