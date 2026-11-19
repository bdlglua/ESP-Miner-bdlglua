#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "bm1370_protocol.h"
#include "crc.h"

static uint32_t random_state = 0x13701370;
#ifdef BM1370_FAULT_TEST
static int corrupt_tx, corrupt_rx;
extern size_t __real_bm1370_rs_encode(uint8_t, const uint8_t *, size_t, uint8_t *, size_t);
extern int32_t __real_bm1370_rs_decode(const uint8_t *, size_t, bm1370_response_t *);
size_t __wrap_bm1370_rs_encode(uint8_t header, const uint8_t *payload, size_t n, uint8_t *out, size_t cap) {
    size_t length = __real_bm1370_rs_encode(header, payload, n, out, cap);
    if (corrupt_tx && length) { out[3] ^= 1; corrupt_tx = 0; }
    return length;
}
int32_t __wrap_bm1370_rs_decode(const uint8_t *frame, size_t n, bm1370_response_t *out) {
    int32_t valid = __real_bm1370_rs_decode(frame, n, out);
    if (corrupt_rx && valid) { out->nonce ^= 1; corrupt_rx = 0; }
    return valid;
}

static void test_shadow_fault(void) {
    uint8_t payload[2] = {0,0}, frame[88], reference[88];
    size_t expected = bm1370_encode_frame_c(0x53, payload, 2, reference, sizeof(reference));
    corrupt_tx = 1;
    assert(bm1370_encode_frame(0x53, payload, 2, frame, sizeof(frame)) == expected);
    assert(!memcmp(frame, reference, expected)); // Candidate corruption never reaches UART.
    const uint8_t job[] = {0xaa,0x55,0x07,0x35,0xcd,0xcf,0x02,0x5e,0,0x2e,0x96};
    bm1370_response_t output;
    corrupt_rx = 1;
    assert(bm1370_decode_response(job, 11, &output) && output.nonce == 0xcfcd3507);
    bm1370_protocol_stats_t stats;
    bm1370_protocol_get_stats(&stats);
    assert(stats.tx_mismatches == 1 && stats.rx_mismatches == 1);
    puts("Shadow fault injection passed: divergence counted, C bytes/fields retained.");
}
#endif
static uint32_t random_value(void) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    return random_state ^= random_state << 5;
}

static void equal_response(const bm1370_response_t *a, const bm1370_response_t *b) {
    assert(a->nonce == b->nonce && a->value == b->value && a->version_bits == b->version_bits);
    assert(a->job_id == b->job_id && a->is_job == b->is_job && a->core_id == b->core_id);
    assert(a->small_core_id == b->small_core_id && a->asic_address == b->asic_address);
    assert(a->register_address == b->register_address);
}

/* Previous _send_BM1370's byte-level algorithm, independent of the new codec.
 * This locks the wire compatibility rules, including the 0x56 job length. */
static size_t legacy_frame(uint8_t header, uint8_t *payload, size_t length, uint8_t *out) {
    int job = !!(header & 0x20);
    out[0] = 0x55; out[1] = 0xaa; out[2] = header;
    out[3] = length + (job ? 4 : 3);
    memcpy(out + 4, payload, length);
    if (job) {
        uint16_t sum = crc16_false(out + 2, length + 2);
        out[4 + length] = sum >> 8; out[5 + length] = sum;
    } else out[4 + length] = crc5(out + 2, length + 2);
    return length + (job ? 6 : 5);
}

static void test_tx(void) {
    uint8_t payload[82], reference[88], c[88], rust[88], selected[88];
    const uint8_t headers[] = {0x21,0x40,0x41,0x42,0x43,0x50,0x51,0x52,0x53};
    for (int trial = 0; trial < 20000; trial++) {
        uint8_t header = headers[trial % sizeof(headers)];
        size_t length = header == 0x21 ? 82 : (header & 3) == 1 ? 6 : 2;
        for (size_t i = 0; i < length; i++) payload[i] = random_value();
        size_t n = legacy_frame(header, payload, length, reference);
        assert(bm1370_encode_frame_c(header, payload, length, c, sizeof(c)) == n);
        assert(bm1370_rs_encode(header, payload, length, rust, sizeof(rust)) == n);
        assert(bm1370_encode_frame(header, payload, length, selected, sizeof(selected)) == n);
        assert(!memcmp(reference, c, n) && !memcmp(reference, rust, n) && !memcmp(reference, selected, n));
        if (header == 0x21) assert(n == 88 && rust[3] == 0x56);
        if (trial < 100) {
            for (size_t cap = 0; cap < n; cap++) {
                memset(c, 0xa5, sizeof(c)); memset(rust, 0xa5, sizeof(rust));
                assert(!bm1370_encode_frame_c(header, payload, length, c, cap));
                assert(!bm1370_rs_encode(header, payload, length, rust, cap));
                assert(!memcmp(c, rust, sizeof(c)));
                for (size_t i = 0; i < sizeof(c); i++) assert(c[i] == 0xa5);
                assert(!bm1370_encode_frame(header, payload, length, selected, cap));
            }
        }
    }
    memset(payload, 0, sizeof(payload));
    payload[0] = 0x18; payload[1] = 1;
    assert(bm1370_rs_encode(0x21, payload, 82, rust, 88) == 88);
    assert(rust[4] == 0x18 && rust[5] == 1); // raw slot 24, not a second shift.
    for (unsigned h = 0; h <= 255; h++) {
        for (size_t n = 0; n <= 82; n++) {
            size_t a = bm1370_encode_frame_c(h, payload, n, c, 88);
            size_t b = bm1370_rs_encode(h, payload, n, rust, 88);
            assert(a == b);
            assert(!a || !memcmp(c, rust, a));
        }
    }
    assert(!bm1370_rs_encode(0x21, NULL, 82, rust, 88));
    assert(!bm1370_rs_encode(0x21, payload, 82, NULL, 88));
    assert(!bm1370_rs_encode(0x21, payload, SIZE_MAX, rust, 88));
}

static void check_rx(const uint8_t *frame, size_t length, int valid) {
    bm1370_response_t a, b, selected;
    memset(&a, 0xa5, sizeof(a)); memset(&b, 0xa5, sizeof(b)); memset(&selected, 0xa5, sizeof(selected));
    assert(bm1370_decode_response_c(frame, length, &a) == valid);
    assert(bm1370_rs_decode(frame, length, &b) == valid);
    assert(bm1370_decode_response(frame, length, &selected) == valid);
    if (valid) { equal_response(&a, &b); equal_response(&a, &selected); }
    else {
        for (size_t i = 0; i < sizeof(a); i++) {
            assert(((uint8_t *)&a)[i] == 0xa5 && ((uint8_t *)&b)[i] == 0xa5);
            assert(((uint8_t *)&selected)[i] == 0xa5);
        }
    }
}

static void test_rx(void) {
    // Upstream published job vector, plus a register response.
    const uint8_t job[] = {0xaa,0x55,0x07,0x35,0xcd,0xcf,0x02,0x5e,0,0x2e,0x96};
    const uint8_t reg[] = {0xaa,0x55,0x13,0x62,0x03,0,0,0,0,0,0x1e};
    check_rx(job, 11, 1); check_rx(reg, 11, 1);
    bm1370_response_t result;
    assert(bm1370_rs_decode(job, 11, &result));
    assert(result.nonce == 0xcfcd3507 && result.job_id == 40 && result.version_bits == 0x5c000);
    assert(bm1370_rs_decode(reg, 11, &result));
    assert(!result.is_job && result.value == 0x13620300 && result.register_address == 0);
    for (size_t n = 0; n < 11; n++) check_rx(job, n, 0);
    check_rx(job, SIZE_MAX, 0); check_rx(NULL, 11, 0);
    assert(!bm1370_rs_decode(job, 11, NULL));
    for (int trial = 0; trial < 20000; trial++) {
        uint8_t frame[11] = {0xaa, 0x55};
        for (int i = 2; i < 11; i++) frame[i] = random_value();
        frame[10] &= 0xe0; // CRC low 5 bits; preserve flags, even reserved bits.
        int found = 0;
        for (int sum = 0; sum < 32; sum++) {
            frame[10] = (frame[10] & 0xe0) | sum;
            if (!crc5(frame + 2, 9)) { found = 1; break; }
        }
        assert(found);
        check_rx(frame, 11, 1);
        size_t bit = random_value() % 88;
        frame[bit / 8] ^= 1 << (bit % 8);
        check_rx(frame, 11, 0);
    }
}

static void test_crc(void) {
    uint8_t data[65535];
    for (size_t i = 0; i < sizeof(data); i++) data[i] = random_value();
    for (unsigned n = 0; n <= 255; n++) assert(crc5(data, n) == bm1370_rs_crc5(data, n));
    for (unsigned n = 0; n < 1024; n++) assert(crc16_false(data, n) == bm1370_rs_crc16(data, n));
    assert(crc16_false(data, sizeof(data)) == bm1370_rs_crc16(data, sizeof(data)));
    assert(bm1370_rs_crc16((const uint8_t *)"123456789", 9) == 0x29b1);
    assert(crc16((uint8_t *)"123456789", 9) == 0x31c3); // distinct zero-init variant.
    assert(bm1370_rs_crc5(NULL, 0) == 0x1f && bm1370_rs_crc16(NULL, 0) == 0xffff);
}

int main(void) {
    test_crc(); test_tx(); test_rx();
    bm1370_protocol_stats_t stats;
    bm1370_protocol_get_stats(&stats);
    assert(!stats.tx_mismatches && !stats.rx_mismatches);
#if CONFIG_BM1370_PROTOCOL_RUST
    assert(stats.tx_checks > 20000 && stats.rx_checks > 40000);
#endif
#ifdef BM1370_FAULT_TEST
    test_shadow_fault();
#endif
    puts("BM1370 passed: legacy/C/Rust TX parity, 20000 payloads, all headers/lengths, 20000 valid RX + bit corruptions, CRCs, capacities, null/truncated inputs.");
}
