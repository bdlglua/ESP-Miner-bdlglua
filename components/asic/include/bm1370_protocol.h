#ifndef BM1370_PROTOCOL_H
#define BM1370_PROTOCOL_H
#include <stddef.h>
#include <stdint.h>

#define BM1370_JOB_PAYLOAD_SIZE 82
#define BM1370_MAX_FRAME_SIZE 88
#define BM1370_RESPONSE_SIZE 11

/* C ABI: no packed structs or ownership transfer. nonce has the same numerical
 * value as the existing little-endian C driver. job_id is its raw slot (0..120,
 * step 8), not the upstream logical job id. asic_address is not yet divided by
 * the chain's address interval. Keep synchronized with Rust's repr(C) struct. */
typedef struct {
    uint32_t nonce;
    uint32_t value;
    uint32_t version_bits;
    uint8_t is_job;
    uint8_t job_id;
    uint8_t small_core_id;
    uint8_t core_id;
    uint8_t asic_address;
    uint8_t register_address;
} bm1370_response_t;

/* Return frame length / 1 on success, zero on invalid input. Failed calls leave
 * output untouched. Buffers must be disjoint and have their advertised size. */
size_t bm1370_encode_frame_c(uint8_t header, const uint8_t *payload, size_t length,
                             uint8_t *output, size_t capacity);
int bm1370_decode_response_c(const uint8_t *frame, size_t length, bm1370_response_t *output);
size_t bm1370_encode_frame(uint8_t header, const uint8_t *payload, size_t length,
                           uint8_t *output, size_t capacity);
int bm1370_decode_response(const uint8_t *frame, size_t length, bm1370_response_t *output);

size_t bm1370_rs_encode(uint8_t header, const uint8_t *payload, size_t length,
                        uint8_t *output, size_t capacity);
int32_t bm1370_rs_decode(const uint8_t *frame, size_t length, bm1370_response_t *output);
/* CRC5 and CRC16-FALSE (init FFFF); distinct from the C crc16(init 0000). */
uint8_t bm1370_rs_crc5(const uint8_t *data, size_t length);
uint16_t bm1370_rs_crc16(const uint8_t *data, size_t length);

typedef struct {
    uint32_t tx_checks, rx_checks, tx_mismatches, rx_mismatches;
} bm1370_protocol_stats_t;
void bm1370_protocol_get_stats(bm1370_protocol_stats_t *stats);
const char *bm1370_protocol_backend(void);
#endif
