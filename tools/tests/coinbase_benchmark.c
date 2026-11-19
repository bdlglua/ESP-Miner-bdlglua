/* Host-only end-to-end microbenchmark. Both backends use the same C crypto,
 * allocations and fixture; never interpret these timings as ESP32 measurements. */
#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "coinbase_decoder.h"
#include "fixture.h"

extern esp_err_t coinbase_process_notification_rust(const mining_notify *, const char *,
    int, const char *, mining_network_t, bool, mining_notification_result_t *);
typedef esp_err_t (*decoder_fn)(const mining_notify *, const char *, int,
                               const char *, mining_network_t, bool, mining_notification_result_t *);

static uint64_t nanoseconds(void) {
    struct timespec now;
    assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static double measure(decoder_fn decode, bool outputs, unsigned repetitions) {
    mining_notify job = {.coinbase_1 = PPC_COINBASE_1, .coinbase_2 = PPC_COINBASE_2, .target = PPC_TARGET};
    uint64_t start = nanoseconds();
    for (unsigned i = 0; i < repetitions; i++) {
        mining_notification_result_t result;
        assert(decode(&job, "000000000000", 4, PPC_PAYOUT_ADDRESS ".bench", MINING_NETWORK_AUTO, outputs, &result) == ESP_OK);
        assert(result.block_height == PPC_HEIGHT && result.total_value_satoshis == PPC_TOTAL);
        free(result.scriptsig);
    }
    return (double)(nanoseconds() - start) / repetitions;
}

int main(void) {
    const unsigned repetitions = 50000;
    decoder_fn decoders[] = {coinbase_process_notification, coinbase_process_notification_rust};
    for (int outputs = 0; outputs <= 1; outputs++) {
        for (int backend = 0; backend < 2; backend++) measure(decoders[backend], outputs, 1000);
        for (int round = 0; round < 5; round++) {
            // Alternate order to reduce warm-up/clock drift bias.
            for (int index = 0; index < 2; index++) {
                int backend = (index + round) % 2;
                printf("%s,%d,%d,%.2f\n", backend ? "rust" : "c", outputs, round,
                       measure(decoders[backend], outputs, repetitions));
            }
        }
    }
}
