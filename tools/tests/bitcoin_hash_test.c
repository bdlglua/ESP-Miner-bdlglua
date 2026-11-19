/* bitcoin_hash.c against published vectors and the mbedTLS 3 code it replaces.
 * Built by tools/test_bitcoin_hash.py with ASan/UBSan. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bitcoin_hash.h"
#include "mbedtls/ripemd160.h"
#include "mbedtls/sha256.h"

static void hex(const uint8_t *data, size_t length, char *out)
{
    for (size_t i = 0; i < length; i++) sprintf(out + 2 * i, "%02x", data[i]);
}

static void check_vector(const char *message, size_t repeat, const char *sha, const char *ripemd)
{
    size_t length = strlen(message) * repeat;
    char *data = malloc(length + 1);
    for (size_t i = 0; i < repeat; i++) memcpy(data + i * strlen(message), message, strlen(message));
    uint8_t digest[32];
    char text[65];
    sha256_digest(data, length, digest);
    hex(digest, 32, text);
    if (sha) assert(!strcmp(text, sha));
    ripemd160_digest(data, length, digest);
    hex(digest, 20, text);
    if (ripemd) assert(!strcmp(text, ripemd));
    free(data);
}

int main(void)
{
    // FIPS 180-4 / NIST CAVP and the RIPEMD-160 reference vectors.
    check_vector("", 1, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                 "9c1185a5c5e9fc54612808977ee8f548b2258d31");
    check_vector("abc", 1, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                 "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
    check_vector("message digest", 1, NULL, "5d0689ef49d2fae572b881b123a85ffa21595f36");
    check_vector("abcdefghijklmnopqrstuvwxyz", 1, NULL, "f71c27109c692c1b56bbdceb5b9d2865b3708dbc");
    check_vector("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 1,
                 "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
                 "12a053384a9c0c88e405a06c27dcf49ada62eb2b");
    check_vector("1234567890", 8, NULL, "9b752e45573d4b39f4dbd3323cab82bf63326bfb");
    check_vector("a", 1000000, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
                 "52783243c1697bdbe16d37f97f68f08325dc1528");

    // Every length around the one- and two-block padding boundaries, then random data.
    uint8_t data[1100];
    uint32_t seed = 2026;
    for (size_t i = 0; i < sizeof(data); i++) data[i] = (uint8_t)((seed = seed * 1664525u + 1013904223u) >> 24);
    for (int round = 0; round < 5000; round++) {
        size_t length = round < 200 ? (size_t)round : (seed = seed * 1664525u + 1013904223u) % sizeof(data);
        const uint8_t *start = data + (round % 7);
        if (length > sizeof(data) - 7) length = sizeof(data) - 7;
        uint8_t ours[32], theirs[32];
        sha256_digest(start, length, ours);
        assert(mbedtls_sha256(start, length, theirs, 0) == 0 && !memcmp(ours, theirs, 32));
        ripemd160_digest(start, length, ours);
        assert(mbedtls_ripemd160(start, length, theirs) == 0 && !memcmp(ours, theirs, 20));
    }

    // Midstate: identical to the state words previously copied out of mbedTLS.
    for (int round = 0; round < 1000; round++) {
        const uint8_t *block = data + round % (sizeof(data) - 64);
        mbedtls_sha256_context context;
        mbedtls_sha256_init(&context);
        mbedtls_sha256_starts(&context, 0);
        mbedtls_sha256_update(&context, block, 64);
        uint8_t ours[32];
        sha256_midstate(block, ours);
        assert(!memcmp(ours, context.state, 32));
        mbedtls_sha256_free(&context);
    }
    puts("PASS: SHA-256/RIPEMD-160 reference vectors (incl. 1M 'a'), 5000 random lengths vs mbedTLS, 1000 midstates vs mbedTLS state");
    return 0;
}
