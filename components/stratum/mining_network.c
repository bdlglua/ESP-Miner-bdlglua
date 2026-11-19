#include "mining_network.h"
#include "libbase58.h"
#include "segwit_addr.h"
#include "bitcoin_hash.h"
#include <stdio.h>
#include <string.h>
#include <strings.h>

static const mining_network_params_t bitcoin = {"BTC", "bc", 0, 5, 8};
static const mining_network_params_t peercoin = {"PPC", "pc", 55, 117, 6};
/* DigiByte Core mainnet: P2PKH=30, P2SH=63 (legacy=5), HRP=dgb, COIN=1e8. */
static const mining_network_params_t digibyte = {"DGB", "dgb", 30, 63, 8};

static bool address_sha256(void *digest, const void *data, size_t size)
{
    sha256_digest(data, size, digest);
    return true;
}

const mining_network_params_t *mining_network_params(mining_network_t network)
{
    switch (network) {
        case MINING_NETWORK_PEERCOIN: return &peercoin;
        case MINING_NETWORK_DIGIBYTE: return &digibyte;
        default: return &bitcoin;
    }
}

static int base58_version(const char *address, uint8_t bytes[25])
{
    if (!b58_sha256_impl) b58_sha256_impl = address_sha256;
    size_t size = 25;
    size_t length = strlen(address);
    if (!b58tobin(bytes, &size, address, length) || size != 25) return -1;
    return b58check(bytes, size, address, length);
}

mining_network_t mining_network_resolve(mining_network_t configured, const char *user)
{
    if (configured != MINING_NETWORK_AUTO) return configured;
    if (!user) return MINING_NETWORK_BITCOIN;
    char address[128];
    size_t length = strcspn(user, ".");
    if (length >= sizeof(address)) return MINING_NETWORK_BITCOIN;
    memcpy(address, user, length); address[length] = '\0';
    uint8_t bytes[25];
    int version = base58_version(address, bytes);
    if (version == 55 || version == 117) return MINING_NETWORK_PEERCOIN;
    if (version == 30 || version == 63) return MINING_NETWORK_DIGIBYTE;
    int witness_version;
    uint8_t program[40];
    size_t size;
    if (segwit_addr_decode(&witness_version, program, &size, "dgb", address)) return MINING_NETWORK_DIGIBYTE;
    if (segwit_addr_decode(&witness_version, program, &size, "pc", address)) return MINING_NETWORK_PEERCOIN;
    // Account usernames and legacy DGB P2SH (prefix 5) are ambiguous. The pool
    // selector supplies the network explicitly; Auto preserves the BTC default.
    return MINING_NETWORK_BITCOIN;
}

void mining_network_normalize_address(mining_network_t network, const char *address,
                                      char *output, size_t capacity)
{
    if (!capacity) return;
    snprintf(output, capacity, "%s", address);
    uint8_t decoded[25];
    if (network == MINING_NETWORK_DIGIBYTE && base58_version(address, decoded) == 5) {
        size_t size = capacity;
        b58check_enc(output, &size, 63, decoded + 1, 20);
        return;
    }
    int version;
    uint8_t program[40];
    size_t size;
    const char *hrp = mining_network_params(network)->hrp;
    if (capacity >= 91 && segwit_addr_decode(&version, program, &size, hrp, address))
        segwit_addr_encode(output, hrp, version, program, size);
}

bool mining_pool_is_zpool_sha256(const char *host)
{
    static const char direct[] = "sha256.mine.zpool.ca";
    static const char prefix[] = "sha256.";
    static const char suffix[] = ".mine.zpool.ca";
    if (!host) return false;

    size_t length = strlen(host);
    if (length && host[length - 1] == '.') length--;
    if (length == sizeof(direct) - 1 && !strncasecmp(host, direct, length)) return true;

    size_t start = sizeof(prefix) - 1;
    size_t suffix_length = sizeof(suffix) - 1;
    if (length <= start + suffix_length || strncasecmp(host, prefix, start) ||
        strncasecmp(host + length - suffix_length, suffix, suffix_length)) return false;

    size_t end = length - suffix_length;
    if (end - start > 63 || host[start] == '-' || host[end - 1] == '-') return false;
    for (size_t i = start; i < end; ++i) {
        char c = host[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-')) return false;
    }
    return true;
}

bool mining_network_job_supported(mining_network_t network, uint32_t version)
{
    // DigiByte's bits 8..11 select the proof-of-work algorithm: 2 is SHA256d.
    return network != MINING_NETWORK_DIGIBYTE || (version & 0x00000f00u) == 0x00000200u;
}

uint32_t mining_network_version_mask(mining_network_t network, uint32_t mask)
{
    return network == MINING_NETWORK_DIGIBYTE ? mask & ~0x00000f00u : mask;
}
