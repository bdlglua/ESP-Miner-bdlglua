#ifndef MINING_H_
#define MINING_H_

#include "stratum_api.h"

typedef struct
{
    uint32_t version;
    uint32_t version_mask;
    uint8_t prev_block_hash[32];
    uint8_t merkle_root[32];
    uint32_t ntime;
    uint32_t target; // aka difficulty, aka nbits
    uint32_t starting_nonce;

    uint8_t num_midstates;
    uint8_t midstate[32];
    uint8_t midstate1[32];
    uint8_t midstate2[32];
    uint8_t midstate3[32];
    uint32_t pool_diff;
    uint32_t work_epoch; // Fixed BM1370 jobs: notification/session lifetime.
    char *jobid;
    char *extranonce2;
} bm_job;

// BIP-320 general-purpose version bits that the BM13xx chips roll.
#define BIP320_VERSION_ROLLING_MASK 0x1fffe000u

// Block version hashed by the chip: the rolled field replaces the job's bits inside the
// mask, so a bit the job had set there is cleared when the chip rolls it to 0.
static inline uint32_t mining_rolled_version(const bm_job *job, uint32_t version_bits)
{
    const uint32_t mask = job->version_mask & BIP320_VERSION_ROLLING_MASK;
    return (job->version & ~mask) | (version_bits & mask);
}

// mining.submit version_bits (BIP-310): the rolled version inside the negotiated mask.
static inline uint32_t mining_submit_version_bits(const bm_job *job, uint32_t rolled_version)
{
    return rolled_version & job->version_mask;
}

// Convert a Stratum prevhash (32-bit words) to conventional block hash hex.
bool mining_prevhash_to_display(const char *stratum_prevhash, char display[65]);

void free_bm_job(bm_job *job);

void calculate_coinbase_tx_hash(const char *coinbase_1, const char *coinbase_2,
                                const char *extranonce, const char *extranonce_2, uint8_t dest[32]);

void calculate_merkle_root_hash(const uint8_t coinbase_tx_hash[32], const uint8_t merkle_branches[][32], const int num_merkle_branches, uint8_t dest[32]);

bool mining_prepare_bm1370_work(mining_notify *notification);
void mining_build_bm1370_job(const mining_notify *notification, uint64_t counter,
                            char extranonce_hex[2 * MAX_EXTRANONCE_2_LEN + 1], bm_job *job);

void construct_bm_job(mining_notify *params, const uint8_t merkle_root[32], const uint32_t version_mask, const uint32_t difficulty, bm_job* new_job);

double test_nonce_value(const bm_job *job, const uint32_t nonce, const uint32_t rolled_version);
void bm_job_to_header(const bm_job *job, uint32_t nonce, uint32_t version, uint8_t header[80]);

void extranonce_2_generate(uint64_t extranonce_2, uint32_t length, char dest[static length * 2 + 1]);

uint32_t increment_bitmask(const uint32_t value, const uint32_t mask);

#endif /* MINING_H_ */
