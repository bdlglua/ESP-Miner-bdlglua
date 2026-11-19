#ifndef BITCOIN_HASH_H
#define BITCOIN_HASH_H

/* Self-contained SHA-256 and RIPEMD-160. ESP-IDF 6 ships mbedTLS 4, which no
 * longer exposes the legacy hash API, the SHA-256 internal state used for
 * midstates, or RIPEMD-160. Portable C, so host tests run the same code. */

#include <stddef.h>
#include <stdint.h>

void sha256_digest(const void *data, size_t length, uint8_t digest[32]);

/* State words after one 64-byte block, in CPU byte order. This is the layout
 * the BM13xx job packets expect (previously read from mbedTLS ctx.state). */
void sha256_midstate(const uint8_t block[64], uint8_t state[32]);

void ripemd160_digest(const void *data, size_t length, uint8_t digest[20]);

#endif
