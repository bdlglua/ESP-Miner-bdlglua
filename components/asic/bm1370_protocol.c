/* Extracted from the production BM1370 wire format. UART and power management
 * deliberately live outside this codec so the exact same code runs on the host. */
#include "bm1370_protocol.h"
#include "crc.h"
#include <string.h>
#if CONFIG_BM1370_PROTOCOL_RUST
#include <stdatomic.h>
static atomic_uint tx_checks, rx_checks, tx_mismatches, rx_mismatches;
#endif

size_t bm1370_encode_frame_c(uint8_t header, const uint8_t *payload, size_t length,
                             uint8_t *output, size_t capacity) {
    int job = header == 0x21;
    if (!payload || !output) return 0;
    if (job) {
        if (length != BM1370_JOB_PAYLOAD_SIZE) return 0;
    } else if ((header & 0xec) != 0x40 || length != ((header & 3) == 1 ? 6 : 2)) {
        return 0;
    }
    size_t total = length + (job ? 6 : 5);
    if (capacity < total) return 0;
    output[0] = 0x55; output[1] = 0xaa; output[2] = header;
    output[3] = (uint8_t)(length + (job ? 4 : 3));
    memcpy(output + 4, payload, length);
    if (job) {
        uint16_t crc = crc16_false(output + 2, (uint16_t)(length + 2));
        output[4 + length] = (uint8_t)(crc >> 8);
        output[5 + length] = (uint8_t)crc;
    } else output[4 + length] = crc5(output + 2, (uint8_t)(length + 2));
    return total;
}

int bm1370_decode_response_c(const uint8_t *frame, size_t length, bm1370_response_t *output) {
    if (!frame || !output || length != BM1370_RESPONSE_SIZE ||
        frame[0] != 0xaa || frame[1] != 0x55 || crc5((uint8_t *)frame + 2, 9) != 0) return 0;
    bm1370_response_t result = {0};
    result.is_job = !!(frame[10] & 0x80);
    if (result.is_job) {
        result.nonce = (uint32_t)frame[2] | (uint32_t)frame[3] << 8 |
                       (uint32_t)frame[4] << 16 | (uint32_t)frame[5] << 24;
        result.job_id = (frame[7] & 0xf0) >> 1;
        result.small_core_id = frame[7] & 0x0f;
        result.core_id = frame[2] >> 1;
        result.asic_address = (uint8_t)(((uint32_t)frame[2] << 24 | (uint32_t)frame[3] << 16 |
                                        (uint32_t)frame[4] << 8 | frame[5]) >> 17);
        result.version_bits = ((uint32_t)frame[8] << 8 | frame[9]) << 13;
    } else {
        result.value = (uint32_t)frame[2] << 24 | (uint32_t)frame[3] << 16 |
                       (uint32_t)frame[4] << 8 | frame[5];
        result.asic_address = frame[6];
        result.register_address = frame[7];
    }
    *output = result;
    return 1;
}

#if CONFIG_BM1370_PROTOCOL_RUST && CONFIG_BM1370_PROTOCOL_SHADOW
static int same_response(const bm1370_response_t *a, const bm1370_response_t *b) {
    /* Compare fields, never struct padding. */
    return a->nonce == b->nonce && a->value == b->value && a->version_bits == b->version_bits &&
           a->is_job == b->is_job && a->job_id == b->job_id && a->small_core_id == b->small_core_id &&
           a->core_id == b->core_id && a->asic_address == b->asic_address &&
           a->register_address == b->register_address;
}
#endif

size_t bm1370_encode_frame(uint8_t header, const uint8_t *payload, size_t length,
                           uint8_t *output, size_t capacity) {
#if CONFIG_BM1370_PROTOCOL_RUST
    atomic_fetch_add_explicit(&tx_checks, 1, memory_order_relaxed);
#if CONFIG_BM1370_PROTOCOL_SHADOW
    uint8_t candidate[BM1370_MAX_FRAME_SIZE];
    size_t r = bm1370_rs_encode(header, payload, length, candidate, sizeof(candidate));
    size_t c = bm1370_encode_frame_c(header, payload, length, output, capacity);
    /* Honor the same caller capacity on both paths, including invalid calls. */
    if (capacity < r || !output) r = 0;
    if (c != r || (c && memcmp(output, candidate, c)))
        atomic_fetch_add_explicit(&tx_mismatches, 1, memory_order_relaxed);
    return c;
#else
    return bm1370_rs_encode(header, payload, length, output, capacity);
#endif
#else
    return bm1370_encode_frame_c(header, payload, length, output, capacity);
#endif
}

int bm1370_decode_response(const uint8_t *frame, size_t length, bm1370_response_t *output) {
#if CONFIG_BM1370_PROTOCOL_RUST
    atomic_fetch_add_explicit(&rx_checks, 1, memory_order_relaxed);
#if CONFIG_BM1370_PROTOCOL_SHADOW
    bm1370_response_t candidate;
    int r = output ? bm1370_rs_decode(frame, length, &candidate) : 0;
    int c = bm1370_decode_response_c(frame, length, output);
    if (c != r || (c && !same_response(output, &candidate)))
        atomic_fetch_add_explicit(&rx_mismatches, 1, memory_order_relaxed);
    return c;
#else
    return bm1370_rs_decode(frame, length, output);
#endif
#else
    return bm1370_decode_response_c(frame, length, output);
#endif
}

void bm1370_protocol_get_stats(bm1370_protocol_stats_t *stats) {
    if (!stats) return;
    *stats = (bm1370_protocol_stats_t){0};
#if CONFIG_BM1370_PROTOCOL_RUST
    stats->tx_checks = atomic_load_explicit(&tx_checks, memory_order_relaxed);
    stats->rx_checks = atomic_load_explicit(&rx_checks, memory_order_relaxed);
    stats->tx_mismatches = atomic_load_explicit(&tx_mismatches, memory_order_relaxed);
    stats->rx_mismatches = atomic_load_explicit(&rx_mismatches, memory_order_relaxed);
#endif
}

const char *bm1370_protocol_backend(void) {
#if CONFIG_BM1370_PROTOCOL_RUST && CONFIG_BM1370_PROTOCOL_SHADOW
    return "rust-shadow";
#elif CONFIG_BM1370_PROTOCOL_RUST
    return "rust";
#else
    return "c";
#endif
}
