#ifndef MINING_NETWORK_H
#define MINING_NETWORK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Persisted values: keep these stable for primary/fallback pool settings. */
typedef enum {
    MINING_NETWORK_AUTO = 0,
    MINING_NETWORK_BITCOIN = 1,
    MINING_NETWORK_PEERCOIN = 2,
    MINING_NETWORK_DIGIBYTE = 3,
} mining_network_t;

typedef struct {
    const char *symbol;
    const char *hrp;
    uint8_t pubkey_prefix, script_prefix, decimals;
} mining_network_params_t;

const mining_network_params_t *mining_network_params(mining_network_t network);
mining_network_t mining_network_resolve(mining_network_t configured, const char *user);
void mining_network_normalize_address(mining_network_t network, const char *address,
                                      char *output, size_t capacity);
bool mining_pool_is_zpool_sha256(const char *host);
bool mining_network_job_supported(mining_network_t network, uint32_t version);
uint32_t mining_network_version_mask(mining_network_t network, uint32_t mask);

#endif
