/* Untrusted pool input and outgoing JSON for the real Stratum parser/writer.
 * Built by tools/test_stratum_parse.py with ASan/UBSan; no miner access. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "stratum_api.h"
#include "mining.h"
#include "esp_app_desc.h"

static char written[16384];
static int written_length;
// Scripted socket: each entry caps one write (>0 bytes accepted, 0 timeout, <0 error);
// past the script every write is accepted whole.
static int write_script[8];
static int write_script_length, write_script_next;
static bool write_continues; // The previous write was partial: append.

int64_t esp_timer_get_time(void) { return 1000; }
int esp_transport_read(esp_transport_handle_t transport, char *buffer, int capacity, int timeout) { return 0; }
int esp_transport_write(esp_transport_handle_t transport, const char *buffer, int length, int timeout)
{
    int accepted = length;
    if (write_script_next < write_script_length) {
        accepted = write_script[write_script_next++];
        if (accepted <= 0) return accepted;
        if (accepted > length) accepted = length;
    }
    if (!write_continues) written_length = 0;
    assert(written_length + accepted < (int)sizeof(written));
    memcpy(written + written_length, buffer, accepted);
    written_length += accepted;
    written[written_length] = '\0';
    write_continues = accepted < length;
    return accepted;
}

static void script_writes(int count, const int *caps)
{
    if (count) memcpy(write_script, caps, count * sizeof(int));
    write_script_length = count;
    write_script_next = 0;
    write_continues = false;
}
int esp_transport_destroy(esp_transport_handle_t transport) { return 0; }
esp_transport_handle_t esp_transport_ssl_init(void) { return NULL; }
esp_transport_handle_t esp_transport_tcp_init(void) { return NULL; }
void esp_transport_ssl_crt_bundle_attach(esp_transport_handle_t transport, void (*attach)(void)) {}
void esp_transport_ssl_set_cert_data(esp_transport_handle_t transport, const char *cert, int length) {}
void esp_crt_bundle_attach(void) {}
const esp_app_desc_t *esp_app_get_description(void) { static esp_app_desc_t desc = {"test"}; return &desc; }

static StratumApiV1Message message;

static void release(void)
{
    if (message.mining_notification) STRATUM_V1_free_mining_notify(message.mining_notification);
    message.mining_notification = NULL;
    free(message.extranonce_str); // The Stratum task owns it after each parse.
    message.extranonce_str = NULL;
}

static void parse(const char *json)
{
    STRATUM_V1_parse(&message, json);
}

#define HASH64 "00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdef"
#define VALID_NOTIFY "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"job1\",\"" HASH64 "\"," \
    "\"01000000\",\"ffffffff\",[\"" HASH64 "\"],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}"

static void malformed_messages_never_crash(void)
{
    static const char *messages[] = {
        // mining.notify fields of the wrong type, missing or not hexadecimal.
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",null,\"aa\",\"bb\",[],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",1,\"bb\",[],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",null,[],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[null],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[\"abcd\"],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",{},\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[],2,\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[],\"zz\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[],\"20000000\",null,\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[],\"20000000\",\"1d00ffff\",\"123456789\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"abcd\",\"aa\",\"bb\",[],\"20000000\",\"1d00ffff\",\"5f5e1000\",true]}",
        "{\"id\":null,\"method\":\"mining.notify\",\"params\":{\"job\":\"j\"}}",
        "{\"id\":null,\"method\":\"mining.notify\"}",
        // Other pool notifications without or with wrongly typed params.
        "{\"id\":null,\"method\":\"mining.set_difficulty\",\"params\":[]}",
        "{\"id\":null,\"method\":\"mining.set_difficulty\"}",
        "{\"id\":null,\"method\":\"mining.set_difficulty\",\"params\":[\"512\"]}",
        "{\"id\":null,\"method\":\"mining.set_difficulty\",\"params\":[0]}",
        "{\"id\":null,\"method\":\"mining.set_difficulty\",\"params\":[-4]}",
        "{\"id\":null,\"method\":\"mining.set_version_mask\",\"params\":[]}",
        "{\"id\":null,\"method\":\"mining.set_version_mask\",\"params\":[536862720]}",
        "{\"id\":null,\"method\":\"mining.set_version_mask\",\"params\":[\"not-hex\"]}",
        "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[]}",
        "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[1,4]}",
        "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ab\"]}",
        "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ab\",\"4\"]}",
        "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ab\",4.5]}",
        // Setup results with unexpected shapes.
        "{\"id\":2,\"result\":\"oops\",\"error\":null}",
        "{\"id\":2,\"result\":{\"a\":1},\"error\":null}",
        "{\"id\":2,\"result\":[[],null,4],\"error\":null}",
        "{\"id\":2,\"result\":[[],\"abcd\"],\"error\":null}",
        "{\"id\":2,\"result\":[[],\"abcd\",\"4\"],\"error\":null}",
        "{\"id\":1,\"result\":[1,2],\"error\":null}",
        "{\"id\":1,\"result\":{\"version-rolling.mask\":5},\"error\":null}",
        "{\"id\":1,\"result\":{\"version-rolling.mask\":null},\"error\":null}",
        "[1,2,3]", "", "null", "{\"method\":7}",
    };
    for (size_t i = 0; i < sizeof(messages) / sizeof(messages[0]); i++) {
        parse(messages[i]);
        assert(message.mining_notification == NULL);
        assert(message.extranonce_str == NULL);
        assert(message.method == STRATUM_UNKNOWN || message.method == STRATUM_RESULT_SETUP);
        release();
    }
}

static void valid_messages_still_parse(void)
{
    parse(VALID_NOTIFY);
    assert(message.method == MINING_NOTIFY && message.mining_notification);
    mining_notify *work = message.mining_notification;
    assert(!strcmp(work->job_id, "job1") && !strcmp(work->prev_block_hash, HASH64));
    assert(!strcmp(work->coinbase_1, "01000000") && !strcmp(work->coinbase_2, "ffffffff"));
    assert(work->n_merkle_branches == 1 && work->merkle_branches[0] == 0x00 && work->merkle_branches[31] == 0xef);
    assert(work->version == 0x20000000 && work->target == 0x1d00ffff && work->ntime == 0x5f5e1000);
    assert(work->clean_jobs);
    release();

    parse("{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\",\"" HASH64 "\",\"aa\",\"bb\",[],\"20000000\",\"1d00ffff\",\"5f5e1000\",false]}");
    assert(message.method == MINING_NOTIFY && message.mining_notification->n_merkle_branches == 0);
    assert(!message.mining_notification->clean_jobs);
    release();

    parse("{\"id\":null,\"method\":\"mining.set_version_mask\",\"params\":[\"1fffe000\"]}");
    assert(message.method == MINING_SET_VERSION_MASK && message.version_mask == 0x1fffe000);
    parse("{\"id\":1,\"result\":{\"version-rolling\":true,\"version-rolling.mask\":\"1fffe000\"},\"error\":null}");
    assert(message.method == STRATUM_RESULT_VERSION_MASK && message.version_mask == 0x1fffe000);

    parse("{\"id\":2,\"result\":[[[\"mining.notify\",\"x\"]],\"1234abcd\",8],\"error\":null}");
    assert(message.method == STRATUM_RESULT_SUBSCRIBE && message.response_success);
    assert(!strcmp(message.extranonce_str, "1234abcd") && message.extranonce_2_len == 8);
    release();
    parse("{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ff00\",4]}");
    assert(message.method == MINING_SET_EXTRANONCE && !strcmp(message.extranonce_str, "ff00"));
    assert(message.extranonce_2_len == 4);
    // Ownership was transferred: the next parse must not expose the same pointer.
    char *owned = message.extranonce_str;
    parse("{\"id\":7,\"result\":true,\"error\":null}");
    assert(message.extranonce_str == NULL && message.method == STRATUM_RESULT && message.response_success);
    free(owned);
}

static void difficulty_is_never_rounded_down(void)
{
    static const struct { const char *value; uint32_t expected; } cases[] = {
        {"512", 512}, {"0.5", 1}, {"1500.75", 1501}, {"1500.0", 1500},
        {"4294967295", UINT32_MAX}, {"1e12", UINT32_MAX},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        char json[128];
        snprintf(json, sizeof(json), "{\"id\":null,\"method\":\"mining.set_difficulty\",\"params\":[%s]}", cases[i].value);
        parse(json);
        assert(message.method == MINING_SET_DIFFICULTY);
        assert(message.new_difficulty == cases[i].expected);
    }
}

static void extranonce_size_is_not_clamped(void)
{
    // The Stratum task rejects these; the parser must not turn them into 32.
    parse("{\"id\":2,\"result\":[[],\"abcd\",64],\"error\":null}");
    assert(message.method == STRATUM_RESULT_SUBSCRIBE && message.extranonce_2_len == 64);
    release();
    parse("{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ab\",-1]}");
    assert(message.method == MINING_SET_EXTRANONCE && message.extranonce_2_len == -1);
    release();
    parse("{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"ab\",33]}");
    assert(message.method == MINING_SET_EXTRANONCE && message.extranonce_2_len == 33);
    release();
}

static void check_params(const char *expected_method, int expected_id, const char **expected, int count)
{
    assert(written_length > 0 && written[written_length - 1] == '\n');
    cJSON *root = cJSON_Parse(written);
    assert(root);
    assert(cJSON_GetObjectItem(root, "id")->valueint == expected_id);
    assert(!strcmp(cJSON_GetObjectItem(root, "method")->valuestring, expected_method));
    cJSON *params = cJSON_GetObjectItem(root, "params");
    assert(cJSON_GetArraySize(params) == count);
    for (int i = 0; i < count; i++) assert(!strcmp(cJSON_GetArrayItem(params, i)->valuestring, expected[i]));
    cJSON_Delete(root);
}

static void outgoing_strings_are_escaped(void)
{
    const char *auth[] = {"bc1q\"user\\.worker", "pa\"ss\\word\n\t\x01"};
    assert(STRATUM_V1_authorize(NULL, 3, auth[0], auth[1]) == written_length);
    check_params("mining.authorize", 3, auth, 2);

    // NVS allows credentials up to 3999 bytes; they are no longer truncated.
    char *long_user = malloc(4000), *long_pass = malloc(2000);
    memset(long_user, 'u', 3999); long_user[3999] = '\0';
    memset(long_pass, '"', 1999); long_pass[1999] = '\0';
    const char *long_auth[] = {long_user, long_pass};
    assert(STRATUM_V1_authorize(NULL, 3, long_user, long_pass) == written_length);
    check_params("mining.authorize", 3, long_auth, 2);
    free(long_user);
    free(long_pass);

    // Ordinary shares keep exactly the previous wire bytes.
    assert(STRATUM_V1_submit_share(NULL, 6, "user.worker", "job1", "00000001", 0x5f5e1000, 0x1234abcd, 0x00006000) > 0);
    assert(!strcmp(written, "{\"id\":6,\"method\":\"mining.submit\",\"params\":[\"user.worker\",\"job1\",\"00000001\","
                            "\"5f5e1000\",\"1234abcd\",\"00006000\"]}\n"));
    assert(STRATUM_V1_get_response_time_ms(6, 1000) == 0.0f);

    const char *share[] = {"us\"er", "job\\\"1", "0011", "00000001", "00000002", "00000003"};
    assert(STRATUM_V1_submit_share(NULL, 7, share[0], share[1], share[2], 1, 2, 3) > 0);
    check_params("mining.submit", 7, share, 6);

    // A share that cannot fit is refused rather than truncated.
    char huge[1100];
    memset(huge, 'j', sizeof(huge) - 1); huge[sizeof(huge) - 1] = '\0';
    written_length = 0;
    assert(STRATUM_V1_submit_share(NULL, 8, "user", huge, "00", 1, 2, 3) == -1 && written_length == 0);
}

// esp_transport_write() is one send(): a line split by the socket is completed, and a
// line that cannot be completed is reported as a failure (the caller reconnects).
static void partial_writes_complete_or_fail(void)
{
    const char *expected = "{\"id\":11,\"method\":\"mining.submit\",\"params\":[\"user\",\"job\",\"00\","
                           "\"00000001\",\"00000002\",\"00000003\"]}\n";
    const int length = (int)strlen(expected);
    script_writes(3, (int[]){7, 1, 20});
    assert(STRATUM_V1_submit_share(NULL, 11, "user", "job", "00", 1, 2, 3) == length);
    assert(written_length == length && !strcmp(written, expected) && write_script_next == 3);
    assert(STRATUM_V1_get_response_time_ms(11, 1000) == 0.0f);

    script_writes(2, (int[]){10, -1});
    assert(STRATUM_V1_submit_share(NULL, 12, "user", "job", "00", 1, 2, 3) == -1);
    assert(STRATUM_V1_get_response_time_ms(12, 1000) < 0); // Not kept as pending.
    script_writes(2, (int[]){10, 0});
    assert(STRATUM_V1_pong(NULL, 13) == -1); // Timeout after a partial line.
    script_writes(1, (int[]){0});
    assert(STRATUM_V1_pong(NULL, 14) == 0); // Nothing sent: the timeout is passed through.
    script_writes(1, (int[]){5});
    assert(STRATUM_V1_subscribe(NULL, 15, "BM1370") == written_length && strstr(written, "mining.subscribe"));
    script_writes(0, NULL);
}

// BIP-320: the chip's rolled field replaces the job bits inside the mask (upstream #2041 cases).
static void version_rolling_masks_job_bits(void)
{
    static const struct { uint32_t version, bits, expected; } cases[] = {
        {0x20000004, 0x0000u << 13, 0x20000004}, {0x20000004, 0x0001u << 13, 0x20002004},
        {0x20000004, 0x0003u << 13, 0x20006004}, {0x20000004, 0x0100u << 13, 0x20200004},
        {0x20000004, 0x8000u << 13, 0x30000004}, {0x20000004, 0xffffu << 13, 0x3fffe004},
        {0x21002004, 0x0000u << 13, 0x20000004}, {0x21002004, 0x0001u << 13, 0x20002004},
        {0x21002004, 0x0002u << 13, 0x20004004}, {0x20002004, 0x0002u << 13, 0x20004004},
        {0x20010004, 0x0000u << 13, 0x20000004}, {0x20010004, 0x0001u << 13, 0x20002004},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        bm_job job = {.version = cases[i].version, .version_mask = 0x1fffe000};
        const uint32_t rolled = mining_rolled_version(&job, cases[i].bits);
        assert(rolled == cases[i].expected);
        // The pool rebuilds (version & ~mask) | (bits & mask) from the submitted bits.
        const uint32_t submitted = mining_submit_version_bits(&job, rolled);
        assert(((job.version & ~job.version_mask) | (submitted & job.version_mask)) == rolled);
    }
    // zpool's 0x20000000 jobs: identical to the previous OR / XOR wire values.
    bm_job zpool = {.version = 0x20000000, .version_mask = 0x1fffe000};
    assert(mining_rolled_version(&zpool, 0x00006000) == (0x20000000 | 0x00006000));
    assert(mining_submit_version_bits(&zpool, 0x20006000) == (0x20006000 ^ 0x20000000));
    // A narrower pool mask: chip bits outside it are not hashed nor submitted.
    bm_job narrow = {.version = 0x20000000, .version_mask = 0x00ffe000};
    assert(mining_rolled_version(&narrow, 0x1fffe000) == 0x20ffe000);
    assert(mining_submit_version_bits(&narrow, 0x20ffe000) == 0x00ffe000);
    // No version rolling negotiated: the job version is kept.
    bm_job fixed = {.version = 0x20000004};
    assert(mining_rolled_version(&fixed, 0x00002000) == 0x20000004 && mining_submit_version_bits(&fixed, 0x20000004) == 0);
}

static void mutated_notifications_are_safe(void)
{
    const char *base = VALID_NOTIFY;
    size_t length = strlen(base);
    char *copy = malloc(length + 1);
    static const char replacements[] = "\"[]{},:0aZ- n";
    uint32_t seed = 12345;
    for (int i = 0; i < 20000; i++) {
        memcpy(copy, base, length + 1);
        for (int j = 0; j < 1 + i % 4; j++) {
            seed = seed * 1103515245u + 12345u;
            size_t at = (seed >> 8) % length;
            copy[at] = replacements[(seed >> 20) % (sizeof(replacements) - 1)];
        }
        if (i % 7 == 0) copy[(seed >> 4) % length] = '\0';
        parse(copy);
        if (message.mining_notification) {
            mining_notify *work = message.mining_notification;
            assert(work->job_id && work->prev_block_hash && strlen(work->prev_block_hash) == 64);
            assert(work->coinbase_1 && work->coinbase_2 && work->n_merkle_branches <= MAX_MERKLE_BRANCHES);
        }
        release();
    }
    free(copy);
}

// Server lines captured from sha256.eu.mine.zpool.ca:3333 on 2026-11-18 (no share
// sent). zpool switches chains: one job has version 00000000, another has no
// Merkle branch and a DigiByte SHA-256d version.
static void live_zpool_session_parses(const char *path)
{
    static const stratum_method expected[] = {
        STRATUM_RESULT_VERSION_MASK, STRATUM_RESULT_SUBSCRIBE, STRATUM_RESULT_SETUP,
        MINING_SET_DIFFICULTY, MINING_NOTIFY, MINING_NOTIFY,
    };
    FILE *file = fopen(path, "r");
    assert(file);
    char *line = NULL;
    size_t capacity = 0;
    int count = 0;
    while (getline(&line, &capacity, file) > 0) {
        line[strcspn(line, "\n")] = '\0';
        assert(count < (int)(sizeof(expected) / sizeof(expected[0])));
        parse(line);
        assert(message.method == expected[count]);
        if (message.method == STRATUM_RESULT_SUBSCRIBE) {
            assert(!strcmp(message.extranonce_str, "80096708") && message.extranonce_2_len == 4);
        } else if (message.method == MINING_SET_DIFFICULTY) {
            assert(message.new_difficulty == 65536);
        } else if (message.method == MINING_NOTIFY) {
            mining_notify *work = message.mining_notification;
            assert(work->clean_jobs && strlen(work->prev_block_hash) == 64);
            if (count == 4) assert(!strcmp(work->job_id, "7932c") && work->version == 0 && work->n_merkle_branches == 2);
            if (count == 5) assert(!strcmp(work->job_id, "79332") && work->version == 0x20000202 && work->n_merkle_branches == 0);
        }
        release();
        count++;
    }
    assert(count == (int)(sizeof(expected) / sizeof(expected[0])));
    free(line);
    fclose(file);
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    live_zpool_session_parses(argv[1]);
    malformed_messages_never_crash();
    valid_messages_still_parse();
    difficulty_is_never_rounded_down();
    extranonce_size_is_not_clamped();
    outgoing_strings_are_escaped();
    partial_writes_complete_or_fail();
    version_rolling_masks_job_bits();
    mutated_notifications_are_safe();
    free(message.error_str);
    puts("PASS: live zpool session, malformed pool messages, fractional difficulty, unclamped extranonce2 size, "
         "escaped credentials/job IDs, unchanged share bytes, completed partial writes, BIP-320 masking and 20000 notify mutations");
    return 0;
}
