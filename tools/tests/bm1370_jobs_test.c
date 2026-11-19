#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "bm1370.h"
#include "bm1370_jobs.h"
#include "bm1370_protocol.h"
#include "global_state.h"
#include "utils.h"

// Execute the real static generator; unused RTOS task entry is discarded by ld.
#include "../../main/tasks/create_jobs_task.c"

static atomic_bool forbid_alloc;
static atomic_uint allocations;
static char submitted[1024];
static unsigned read_step;
static bool short_next_write, fail_after_short;
int64_t esp_timer_get_time(void) { return 123456789; }
void esp_restart(void) { abort(); }
void vTaskDelay(unsigned ticks) { (void)ticks; }
int esp_transport_write(esp_transport_handle_t transport, const char *text, int length, int timeout) {
    (void)transport; (void)timeout;
    assert(length > 0 && (size_t)length < sizeof(submitted));
    if (short_next_write) {
        short_next_write = false;
        memcpy(submitted, text, length); submitted[length] = 0;
        return length - 1;
    }
    if (fail_after_short) {
        fail_after_short = false;
        return -1; // The socket fails before the rest of the line is sent.
    }
    memcpy(submitted, text, length); submitted[length] = 0;
    return length;
}
int esp_transport_read(esp_transport_handle_t transport, char *buffer, int capacity, int timeout) {
    (void)transport; (void)timeout;
    assert(capacity >= 64);
    switch (read_step++) {
        case 0: case 1: return 0; // ESP-IDF zero means timeout, not EOF.
        case 2: memcpy(buffer, "first\nold-session\npartial", 25); return 25;
        case 3: return 0;
        case 4: return -4; // FIN invalidates the incomplete session buffer.
        default: memcpy(buffer, "new-session\n", 12); return 12;
    }
}
void cleanup_stratum_buffer(void);
void *__real_malloc(size_t);
char *__real_strdup(const char *);
void *__wrap_malloc(size_t size) {
    if (atomic_load(&forbid_alloc)) atomic_fetch_add(&allocations, 1);
    return __real_malloc(size);
}
char *__wrap_strdup(const char *value) {
    if (atomic_load(&forbid_alloc)) atomic_fetch_add(&allocations, 1);
    return __real_strdup(value);
}

static unsigned sends;
static unsigned mask_commands;
static BM1370_job last_wire;
int SERIAL_send(uint8_t *frame, int length, bool debug) {
    (void)debug;
    assert(frame[0] == 0x55 && frame[1] == 0xaa);
    if (frame[2] == 0x51) {
        assert(length == 11 && frame[5] == 0xa4);
        mask_commands++;
        return length;
    }
    assert(length == 88 && frame[2] == 0x21);
    memcpy(&last_wire, frame + 4, sizeof(last_wire));
    sends++;
    return length;
}
void ASIC_send_work(GlobalState *state, void *job) { BM1370_send_work(state, job); }

static GlobalState state = {.DEVICE_CONFIG.family.asic.id = BM1370, .ASIC_initalized = true};
static mining_notify notification = {
    .job_id = "pool-A", .prev_block_hash = "00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdef",
    .coinbase_1 = "010203", .coinbase_2 = "040506", .version = 0x20000000,
    .target = 0x1b0404cb, .ntime = 0x65001234, .work_version_mask = 0x1fffe000,
    .work_difficulty = 2048, .work_extranonce1 = "aabbccdd", .work_extranonce2_len = 8,
};

static void reset(const char *reason) {
    bm1370_jobs_lock();
    bm1370_jobs_clear_locked(reason);
    bm1370_jobs_unlock();
}
static uint32_t epoch(void) {
    bm1370_jobs_lock();
    uint32_t value = bm1370_jobs_epoch_locked();
    bm1370_jobs_unlock();
    return value;
}
static bool current(const bm1370_job_snapshot *saved) {
    bm1370_jobs_lock();
    bool result = bm1370_jobs_current_locked(&saved->token);
    bm1370_jobs_unlock();
    return result;
}

static void parity_and_pool_lifetimes(void) {
    reset("connect");
    notification.work_epoch = epoch();
    assert(mining_prepare_bm1370_work(&notification));
    atomic_store(&forbid_alloc, true);
    generate_work_impl(&state, &notification, 0x0807060504030201ULL, 9999);
    atomic_store(&forbid_alloc, false);
    assert(sends == 1 && allocations == 0);
    assert(mask_commands == 1);
    bm1370_job_snapshot old;
    assert(bm1370_jobs_read(last_wire.job_id, &old));
    assert(old.job.jobid == old.id && old.job.extranonce2 == old.extra);
    assert(!strcmp(old.id, "pool-A") && !strcmp(old.extra, "0102030405060708"));
    assert(old.job.pool_diff == 2048 && old.job.version_mask == 0x1fffe000);
    uint8_t tx_hash[32], merkle[32];
    calculate_coinbase_tx_hash(notification.coinbase_1, notification.coinbase_2,
                                notification.work_extranonce1, old.extra, tx_hash);
    calculate_merkle_root_hash(tx_hash, NULL, 0, merkle);
    bm_job reference = {0};
    construct_bm_job(&notification, merkle, notification.work_version_mask, 2048, &reference);
    uint8_t a[80], b[80];
    for (uint32_t n = 0; n < 1000; n++) {
        uint32_t version = reference.version | ((n & 0xffff) << 13);
        bm_job_to_header(&reference, n * 0x1234567u, version, a);
        bm_job_to_header(&old.job, n * 0x1234567u, version, b);
        assert(!memcmp(a, b, sizeof(a)));
        assert(test_nonce_value(&reference, n, version) == test_nonce_value(&old.job, n, version));
    }
    assert(!memcmp(last_wire.prev_block_hash, reference.prev_block_hash, 32));
    assert(!memcmp(last_wire.merkle_root, reference.merkle_root, 32));
    // The actual submission serializer must produce exactly the legacy bytes.
    STRATUM_V1_submit_share(NULL, 42, "worker", notification.job_id,
                            "0102030405060708", reference.ntime, 0x1234abcd, 0x4000);
    char legacy[1024]; strcpy(legacy, submitted);
    STRATUM_V1_submit_share(NULL, 42, "worker", old.id, old.extra,
                            old.job.ntime, 0x1234abcd, (old.job.version | 0x4000) ^ old.job.version);
    assert(!strcmp(legacy, submitted));

    // Non-clean notifications preserve other slots and captured extranonce context.
    notification.job_id = "pool-B";
    notification.work_version_mask = 0x0000e000;
    state.extranonce_str = "ffffffff";
    state.pool_difficulty = 999;
    state.version_mask = 0;
    generate_work_impl(&state, &notification, 2, 999);
    assert(mask_commands == 2);
    assert(current(&old));
    for (unsigned i = 0; i < 64; i++) generate_work_impl(&state, &notification, i, 999);
    assert(!current(&old));
    assert(!strcmp(old.id, "pool-A") && !strcmp(old.extra, "0102030405060708"));

    const char *reasons[] = {"clean_jobs", "disconnect", "connect", "extranonce", "fallback"};
    for (size_t i = 0; i < sizeof(reasons) / sizeof(*reasons); i++) {
        bm1370_job_snapshot before;
        assert(bm1370_jobs_read(last_wire.job_id, &before));
        reset(reasons[i]);
        assert(!current(&before));
        for (int slot = 0; slot < 128; slot += 8) {
            bm1370_job_snapshot empty;
            assert(!bm1370_jobs_read(slot, &empty));
        }
        unsigned count = sends;
        // A dequeued old notification and a producer already constructing work
        // must both fail to republish into the next session.
        generate_work_impl(&state, &notification, 5, 999);
        assert(sends == count);
        before.job.work_epoch = before.token.epoch;
        bm1370_jobs_lock();
        assert(bm1370_jobs_store_locked(24, &before.job) == 0);
        bm1370_jobs_unlock();
        notification.work_epoch = epoch();
        free(notification.work_template);
        notification.work_template = NULL;
        notification.work_extranonce1 = "11223344";
        notification.work_difficulty = 4096;
        notification.work_extranonce2_len = i ? 32 : 0;
        generate_work_impl(&state, &notification, 0xfedcba9876543210ULL, 999);
        assert(sends == count + 1);
        bm1370_job_snapshot next;
        assert(bm1370_jobs_read(last_wire.job_id, &next));
        assert(next.job.pool_diff == 4096 && current(&next));
        assert(strlen(next.extra) == (i ? 64u : 0u));
        if (i) assert(!strcmp(next.extra, "1032547698badcfe000000000000000000000000000000000000000000000000"));
    }
}

static void bounds_and_atomic_failure(void) {
    unsigned sent = sends;
    free(notification.work_template);
    notification.work_template = NULL;
    int original_len = notification.work_extranonce2_len;
    notification.work_extranonce2_len = -1;
    generate_work_impl(&state, &notification, 0, 1);
    notification.work_extranonce2_len = 33;
    generate_work_impl(&state, &notification, 0, 1);
    assert(sends == sent); // Never shorten an unsupported pool extranonce.
    notification.work_extranonce2_len = original_len;
    bm_job job = {.jobid = "good", .extranonce2 = "0011", .work_epoch = epoch()};
    bm1370_jobs_lock();
    assert(bm1370_jobs_store_locked(0, &job) == 1);
    bm1370_jobs_unlock();
    bm1370_job_snapshot saved;
    assert(bm1370_jobs_read(0, &saved));
    char long_id[258]; memset(long_id, 'x', 257); long_id[257] = 0;
    job.jobid = long_id;
    bm1370_jobs_lock();
    assert(bm1370_jobs_store_locked(0, &job) == -1);
    long_id[256] = 0;
    assert(bm1370_jobs_store_locked(8, &job) == 1);
    job.extranonce2 = "0g";
    assert(bm1370_jobs_store_locked(0, &job) == -1);
    job.extranonce2 = "0";
    assert(bm1370_jobs_store_locked(0, &job) == -1);
    job.extranonce2 = "";
    assert(bm1370_jobs_store_locked(7, &job) == -1);
    bm1370_jobs_unlock();
    assert(current(&saved));
}

static void *writer(void *unused) {
    (void)unused;
    for (uint32_t i = 0; i < 30000; i++) {
        char extra[65]; extranonce_2_generate(i, 32, extra);
        bm_job job = {.version = i, .pool_diff = i, .jobid = "concurrent", .extranonce2 = extra};
        bm1370_jobs_lock();
        job.work_epoch = bm1370_jobs_epoch_locked();
        assert(bm1370_jobs_store_locked((i % 16) * 8, &job) == 1);
        bm1370_jobs_unlock();
    }
    return NULL;
}
static void *cleaner(void *unused) {
    (void)unused;
    for (int i = 0; i < 1000; i++) reset("disconnect");
    return NULL;
}
static void concurrency(void) {
    reset("concurrency");
    pthread_t producer, resetter;
    assert(!pthread_create(&producer, NULL, writer, NULL));
    assert(!pthread_create(&resetter, NULL, cleaner, NULL));
    for (unsigned i = 0; i < 30000; i++) {
        bm1370_job_snapshot saved;
        if (!bm1370_jobs_read((i % 16) * 8, &saved)) continue;
        assert(!strcmp(saved.id, "concurrent"));
        assert(saved.job.pool_diff == saved.job.version);
        char extra[65]; extranonce_2_generate(saved.job.version, 32, extra);
        assert(!strcmp(saved.extra, extra));
    }
    assert(!pthread_join(producer, NULL) && !pthread_join(resetter, NULL));
}

static void zpool_handshake(void) {
    // Response shapes observed on the European SHA256 TLS endpoint.
    StratumApiV1Message message = {0};
    STRATUM_V1_parse(&message, "{\"id\":1,\"result\":{\"version-rolling\":true,\"version-rolling.mask\":\"1fffe000\"},\"error\":null}");
    assert(message.method == STRATUM_RESULT_VERSION_MASK && message.version_mask == 0x1fffe000);
    STRATUM_V1_parse(&message, "{\"id\":2,\"result\":[[[\"mining.set_difficulty\",\"65536.000\"],[\"mining.notify\",\"subscription-id\"]],\"1234abcd\",4],\"error\":null}");
    assert(message.method == STRATUM_RESULT_SUBSCRIBE && message.response_success);
    assert(message.extranonce_2_len == 4 && !strcmp(message.extranonce_str, "1234abcd"));
    free(message.extranonce_str);
    STRATUM_V1_authorize(NULL, 3, "test-payout-wallet", "c=DGB,d=8192");
    assert(strstr(submitted, "\"params\":[\"test-payout-wallet\",\"c=DGB,d=8192\"]"));
}

static void stratum_rejection_formats(void) {
    const struct { const char *json; const char *reason; stratum_method method; } cases[] = {
        {"{\"id\":15,\"result\":false,\"error\":{\"code\":21,\"message\":\"Job not found\"}}", "Job not found", STRATUM_RESULT},
        {"{\"id\":6,\"result\":null,\"error\":[21,\"Stale share\",null]}", "Stale share", STRATUM_RESULT},
        {"{\"id\":7,\"error\":{\"message\":\"Duplicate share\"}}", "Duplicate share", STRATUM_RESULT},
        {"{\"id\":8,\"result\":false,\"error\":\"Low difficulty share\"}", "Low difficulty share", STRATUM_RESULT},
        {"{\"id\":9,\"result\":false,\"error\":null,\"reject-reason\":\"stale\"}", "stale", STRATUM_RESULT},
        {"{\"id\":10,\"result\":null,\"error\":null}", "unknown", STRATUM_RESULT},
        {"{\"id\":11,\"result\":false,\"error\":[21,42,null]}", "unknown", STRATUM_RESULT},
        {"{\"id\":3,\"error\":{\"message\":\"Unauthorized\"}}", "Unauthorized", STRATUM_RESULT_SETUP},
    };
    for (unsigned repeat = 0; repeat < 100; repeat++) {
        for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
            StratumApiV1Message message = {0};
            STRATUM_V1_parse(&message, cases[i].json);
            assert(message.method == cases[i].method && !message.response_success);
            assert(message.error_str && !strcmp(message.error_str, cases[i].reason));
            free(message.error_str);
        }
    }
    StratumApiV1Message setup = {0};
    STRATUM_V1_parse(&setup, "{\"id\":5,\"result\":true}");
    assert(setup.method == STRATUM_RESULT_SETUP && setup.response_success);
    StratumApiV1Message success = {0};
    STRATUM_V1_parse(&success, "{\"id\":12,\"result\":true,\"error\":null}");
    assert(success.method == STRATUM_RESULT && success.response_success && !success.error_str);
    StratumApiV1Message malformed = {0};
    STRATUM_V1_parse(&malformed, "not JSON");
    assert(malformed.method == STRATUM_UNKNOWN && !malformed.response_success && !malformed.error_str);
    // The production task reuses one message for the whole connection.
    StratumApiV1Message reused = {0};
    for (unsigned i = 0; i < 100; i++) STRATUM_V1_parse(&reused, cases[i % 8].json);
    STRATUM_V1_parse(&reused, "{\"id\":100,\"result\":true}");
    assert(reused.response_success && !reused.error_str);
    STRATUM_V1_parse(&reused, cases[0].json);
    STRATUM_V1_parse(&reused, "not JSON");
    assert(reused.method == STRATUM_UNKNOWN && !reused.error_str);
}

static void share_queue_lifetime(void) {
    reset("queue-session");
    bm_job job = {.ntime=17, .jobid="A", .extranonce2="0012", .work_epoch=epoch()};
    bm1370_jobs_lock();
    assert(bm1370_jobs_store_locked(0, &job)==1);
    bm1370_jobs_unlock();
    bm1370_job_snapshot snapshot;
    assert(bm1370_jobs_read(0, &snapshot));
    bm1370_jobs_lock();
    for(unsigned i=0;i<BM1370_SHARE_QUEUE_CAP;++i)
        assert(bm1370_jobs_queue_share_locked(&snapshot, i, 0x2000)==1);
    assert(bm1370_jobs_queue_share_locked(&snapshot, 9, 0)==-1);
    bm1370_pending_share share;
    assert(bm1370_jobs_take_share_locked(&share) && share.nonce==0 && share.ntime==17);
    assert(!strcmp(share.id, "A") && !strcmp(share.extra, "0012") && share.version_bits==0x2000);
    // Concurrent producers may reuse a slot before the network takes a queued result.
    assert(bm1370_jobs_store_locked(0, &job)==1);
    assert(!bm1370_jobs_take_share_locked(&share));
    assert(bm1370_jobs_queue_share_locked(&snapshot, 8, 0)==0);
    bm1370_jobs_unlock();
    assert(bm1370_jobs_read(0, &snapshot));
    bm1370_jobs_lock();
    assert(bm1370_jobs_queue_share_locked(&snapshot, 8, 0)==1);
    bm1370_jobs_clear_locked("reconnect");
    assert(!bm1370_jobs_take_share_locked(&share));
    assert(bm1370_jobs_queue_share_locked(&snapshot, 9, 0)==0);
    bm1370_jobs_unlock();
}

static void cached_job_parity(void) {
    mining_notify job = notification;
    job.work_template = NULL;
    job.work_extranonce2_len = 8;
    uint8_t branches[64];
    for(unsigned i=0;i<sizeof(branches);++i) branches[i] = i + 9;
    job.merkle_branches = branches;
    job.n_merkle_branches = 2;
    assert(mining_prepare_bm1370_work(&job));
    char extra[65], expected_extra[65];
    uint8_t tx[32],root[32], old[80], new[80];
    bm_job cached, reference;
    for(uint64_t i=0;i<256;i++) {
        uint64_t counter = i * 0x1234567a9bULL;
        extranonce_2_generate(counter, 8, expected_extra);
        calculate_coinbase_tx_hash(job.coinbase_1,job.coinbase_2,job.work_extranonce1,expected_extra,tx);
        calculate_merkle_root_hash(tx, (const uint8_t (*)[32])branches, 2, root);
        construct_bm_job(&job, root, job.work_version_mask, job.work_difficulty, &reference);
        mining_build_bm1370_job(&job, counter, extra, &cached);
        assert(!strcmp(expected_extra, extra));
        bm_job_to_header(&reference, 123, reference.version, old);
        bm_job_to_header(&cached, 123, cached.version, new);
        assert(!memcmp(old,new,sizeof(old)));
    }
    free(job.work_template);
}

static void previous_block_hash_display(void) {
    char hash[65];
    assert(mining_prevhash_to_display("7cdaec9e66c21fa4925413f05820e1a74f854184e3c8d46f0000000900000000", hash));
    assert(!strcmp(hash, "0000000000000009e3c8d46f4f8541845820e1a7925413f066c21fa47cdaec9e"));
    assert(!mining_prevhash_to_display("aabb", hash) && !hash[0]);
    assert(!mining_prevhash_to_display("Gcdaec9e66c21fa4925413f05820e1a74f854184e3c8d46f0000000900000000", hash));
}

int main(void) {
    previous_block_hash_display();
    zpool_handshake();
    stratum_rejection_formats();
    STRATUM_V1_initialize_buffer();
    char *line;
    assert(STRATUM_V1_read_step(NULL, 10, &line) == STRATUM_READ_IDLE && !line);
    assert(STRATUM_V1_read_step(NULL, 10, &line) == STRATUM_READ_IDLE && !line);
    line = STRATUM_V1_receive_jsonrpc_line(NULL);
    assert(line && !strcmp(line, "first")); free(line);
    line = STRATUM_V1_receive_jsonrpc_line(NULL);
    assert(line && !strcmp(line, "old-session")); free(line);
    assert(STRATUM_V1_read_step(NULL, 10, &line) == STRATUM_READ_MORE && !line);
    assert(!STRATUM_V1_receive_jsonrpc_line(NULL));
    STRATUM_V1_initialize_buffer();
    line = STRATUM_V1_receive_jsonrpc_line(NULL);
    assert(line && !strcmp(line, "new-session")); free(line);
    // A reconnect discards buffered complete lines too.
    STRATUM_V1_initialize_buffer();
    line = STRATUM_V1_receive_jsonrpc_line(NULL);
    assert(line && !strcmp(line, "new-session")); free(line);
    cleanup_stratum_buffer();
    STRATUM_V1_submit_share(NULL, 9 + MAX_REQUEST_IDS, "user", "job", "00", 0, 0, 0);
    assert(STRATUM_V1_get_response_time_ms(9, esp_timer_get_time()) < 0);
    assert(STRATUM_V1_get_response_time_ms(9 + MAX_REQUEST_IDS, esp_timer_get_time() + 1500) == 1.5f);
    assert(STRATUM_V1_get_response_time_ms(9 + MAX_REQUEST_IDS, esp_timer_get_time()) < 0);
    // A short write is completed; a line that cannot be completed fails the submit.
    short_next_write = true;
    assert(STRATUM_V1_submit_share(NULL, 10, "user", "job", "00", 0, 0, 0) > 0 && !strcmp(submitted, "\n"));
    assert(STRATUM_V1_get_response_time_ms(10, esp_timer_get_time()) == 0.0f);
    short_next_write = fail_after_short = true;
    assert(STRATUM_V1_submit_share(NULL, 10, "user", "job", "00", 0, 0, 0) < 0);
    assert(STRATUM_V1_get_response_time_ms(10, esp_timer_get_time()) < 0);
    cached_job_parity();
    parity_and_pool_lifetimes();
    share_queue_lifetime();
    bounds_and_atomic_failure();
    concurrency();
    free(notification.work_template);
    puts("PASS: allocation-free job generation/UART; nonce parity; job changes; clean/reconnect epochs; capacities; 30k concurrent publications/reads and 1000 resets");
}
