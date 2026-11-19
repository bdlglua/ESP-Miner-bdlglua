/* Identical inputs, alternating backend order, no UART, pool, allocation or
 * logging in the timed loop. Diagnostic only; never used by production builds. */
#include "bm1370_protocol.h"
#include "bm1370_benchmark.h"
#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "esp_timer.h"
#include "esp_cpu.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#else
#include <time.h>
#endif

extern size_t bm1370_legacy_encode(uint8_t, const uint8_t *, size_t, uint8_t *, size_t);
extern int32_t bm1370_legacy_decode(const uint8_t *, size_t, bm1370_response_t *);
typedef size_t (*encoder)(uint8_t, const uint8_t *, size_t, uint8_t *, size_t);
typedef int32_t (*decoder)(const uint8_t *, size_t, bm1370_response_t *);
static volatile uint32_t sink;
/* ESP-IDF typedefs int32_t as long, while the C codec returns int. Keep the
 * function-pointer types exact on both the host and Xtensa. */
static int32_t decode_c(const uint8_t *frame, size_t length, bm1370_response_t *output) {
    return bm1370_decode_response_c(frame, length, output);
}
static uint64_t now_ns(void) {
#ifdef ESP_PLATFORM
    return (uint64_t)esp_timer_get_time() * 1000;
#else
    struct timespec t;
    assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec;
#endif
}

void bm1370_run_benchmark(void) {
    const unsigned repetitions = 500;
    const char *names[] = {"c", "rust-old", "rust"};
    encoder encoders[] = {bm1370_encode_frame_c, bm1370_legacy_encode, bm1370_rs_encode};
    decoder decoders[] = {decode_c, bm1370_legacy_decode, bm1370_rs_decode};
    uint8_t payload[82], output[88], reference[88];
    const uint8_t response_job[] = {0xaa,0x55,0x07,0x35,0xcd,0xcf,0x02,0x5e,0,0x2e,0x96};
    const uint8_t response_reg[] = {0xaa,0x55,0x13,0x62,0x03,0,0,0,0,0,0x1e};
    const char *cases[] = {"tx-job", "tx-write", "rx-job", "rx-reg"};
    for (unsigned i = 0; i < sizeof(payload); i++) payload[i] = (uint8_t)(i * 37 + 11);
    payload[0] = 0x18; payload[1] = 1;
    for (unsigned kind = 0; kind < 4; kind++) {
        uint8_t header = kind == 0 ? 0x21 : 0x51;
        size_t length = kind == 0 ? 82 : 6;
        size_t expected = bm1370_encode_frame_c(header, payload, length, reference, sizeof(reference));
        for (unsigned round = 0; round < 9; round++) {
            for (unsigned position = 0; position < 3; position++) {
                unsigned backend = (position + round) % 3;
                // Warm each backend before every sample, outside timing.
                for (unsigned warm = 0; warm < 20; warm++) {
                    if (kind < 2) {
                        assert(encoders[backend](header, payload, length, output, sizeof(output)) == expected);
                        assert(!memcmp(reference, output, expected));
                    } else {
                        bm1370_response_t result;
                        assert(decoders[backend](kind == 2 ? response_job : response_reg, 11, &result));
                        assert(kind == 2 ? result.nonce == 0xcfcd3507 : result.value == 0x13620300);
                    }
                }
                uint32_t sum = 0;
#ifdef ESP_PLATFORM
                uint32_t cycles_start = esp_cpu_get_cycle_count();
#endif
                uint64_t started = now_ns();
                if (kind < 2) {
                    for (unsigned n = 0; n < repetitions; n++) {
                        size_t size = encoders[backend](header, payload, length, output, sizeof(output));
                        sum += (uint32_t)size + output[size - 1];
                    }
                } else {
                    const uint8_t *input = kind == 2 ? response_job : response_reg;
                    for (unsigned n = 0; n < repetitions; n++) {
                        bm1370_response_t result;
                        sum += (uint32_t)decoders[backend](input, 11, &result) + result.nonce + result.value;
                    }
                }
                uint64_t total = now_ns() - started;
                uint32_t cycles = 0;
#ifdef ESP_PLATFORM
                cycles = esp_cpu_get_cycle_count() - cycles_start;
#endif
                sink = sum;
#ifdef ESP_PLATFORM
                ESP_LOGI("protocol_bench", "kind=%s backend=%s round=%u n=%u total_ns=%" PRIu64 " cycles=%" PRIu32 " sum=%" PRIu32,
                         cases[kind], names[backend], round, repetitions, total, cycles, sum);
                vTaskDelay(1);
#else
                printf("protocol_bench: kind=%s backend=%s round=%u n=%u total_ns=%" PRIu64 " cycles=%" PRIu32 " sum=%" PRIu32 "\n",
                       cases[kind], names[backend], round, repetitions, total, cycles, sum);
#endif
            }
        }
    }
}

#ifdef ESP_PLATFORM
static void benchmark_task(void *unused) {
    (void)unused;
    vTaskDelay(pdMS_TO_TICKS(60000)); // Let the collector attach and the board warm up.
    bm1370_run_benchmark();
    ESP_LOGI("protocol_bench", "complete=1");
    vTaskDelete(NULL);
}
void bm1370_start_benchmark(void) {
    static bool started;
    if (!started) {
        started = xTaskCreatePinnedToCore(benchmark_task, "codec_bench", 8192, NULL, 1, NULL, 1) == pdPASS;
    }
}
#else
int main(void) { bm1370_run_benchmark(); }
#endif
