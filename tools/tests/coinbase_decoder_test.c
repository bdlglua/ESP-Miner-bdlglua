#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "coinbase_decoder.h"
#include "libbase58.h"
#include "utils.h"
#include "fixture.h"

static const char *btc1 = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20020862062f503253482f04b8864e5008";
static const char *btc2 = "072f736c7573682f000000000100f2052a010000001976a914d23fcdf86f7e756a64a7a9688ef9903327048ed988ac00000000";
static char peercoin_user[128];

#ifdef COINBASE_COMPARE_RUST
extern esp_err_t coinbase_process_notification_rust(const mining_notify *, const char *,
    int, const char *, mining_network_t, bool, mining_notification_result_t *);

static void compare_result(const mining_notification_result_t *a, const mining_notification_result_t *b) {
    assert(a->network_difficulty == b->network_difficulty);
    assert(a->block_height == b->block_height);
    assert(a->total_value_satoshis == b->total_value_satoshis);
    assert(a->user_value_satoshis == b->user_value_satoshis);
    assert(a->decoding_enabled == b->decoding_enabled && a->is_peercoin == b->is_peercoin);
    assert(a->network == b->network);
    assert(a->output_count == b->output_count);
    assert((a->scriptsig == NULL) == (b->scriptsig == NULL));
    if (a->scriptsig) assert(strcmp(a->scriptsig, b->scriptsig) == 0);
    for (int i = 0; i < a->output_count; i++) {
        assert(a->outputs[i].value_satoshis == b->outputs[i].value_satoshis);
        assert(a->outputs[i].is_user_output == b->outputs[i].is_user_output);
        assert(strcmp(a->outputs[i].address, b->outputs[i].address) == 0);
    }
}
#endif

static esp_err_t decode_network(const char *first, const char *second, const char *extra,
                        int extra2, const char *user, mining_network_t network, bool outputs, mining_notification_result_t *result) {
    mining_notify job = {.coinbase_1 = (char *)first, .coinbase_2 = (char *)second, .target = PPC_TARGET};
    memset(result, 0, sizeof(*result));
    esp_err_t status = coinbase_process_notification(&job, extra, extra2, user, network, outputs, result);
#ifdef COINBASE_COMPARE_RUST
    mining_notification_result_t other = {0};
    esp_err_t other_status = coinbase_process_notification_rust(&job, extra, extra2, user, network, outputs, &other);
    assert(status == other_status);
    compare_result(result, &other);
    free(other.scriptsig);
#endif
    return status;
}

static esp_err_t decode(const char *first, const char *second, const char *extra,
                        int extra2, const char *user, bool outputs, mining_notification_result_t *result) {
    return decode_network(first, second, extra, extra2, user, MINING_NETWORK_AUTO, outputs, result);
}

static void test_compactsize(void) {
    const uint8_t encoded[] = {0xfe, 0xff, 0xff, 0xff, 0xff};
    size_t offset = 0;
    uint64_t value;
    assert(coinbase_decode_varint(encoded, sizeof(encoded), &offset, &value));
    assert(value == UINT32_MAX && offset == sizeof(encoded));
    for (size_t length = 0; length < sizeof(encoded); length++) {
        offset = 0;
        assert(!coinbase_decode_varint(encoded, length, &offset, &value));
        assert(offset == 0);
    }
    const uint8_t noncanonical[] = {0xfd, 1, 0};
    offset = 0;
    assert(!coinbase_decode_varint(noncanonical, sizeof(noncanonical), &offset, &value));
}

static void test_height_without_chain(void) {
    assert(coinbase_extract_height(btc1, 8) == 25096);
    assert(coinbase_extract_height(PPC_COINBASE_1, 10) == PPC_HEIGHT);
    assert(coinbase_extract_height(DGB_COINBASE_1, 10) == DGB_HEIGHT);
    assert(coinbase_extract_height(DGB_COINBASE_1, 100) == 0);
    assert(coinbase_extract_height(NULL, 8) == 0);

    char prefix[256];
    snprintf(prefix, sizeof(prefix), "010000000001%s", btc1 + 8);
    assert(coinbase_extract_height(prefix, 8) == 25096);
    // The declaration says three bytes, but the positive number needs only two.
    snprintf(prefix, sizeof(prefix), "%.84s03086200%s", btc1, btc1 + 90);
    assert(coinbase_extract_height(prefix, 8) == 0);
    snprintf(prefix, sizeof(prefix), "%.84s0208e2%s", btc1, btc1 + 90);
    assert(coinbase_extract_height(prefix, 8) == 0);
    snprintf(prefix, sizeof(prefix), "%.88s", btc1);
    assert(coinbase_extract_height(prefix, 8) == 0);
    snprintf(prefix, sizeof(prefix), "%s", btc1);
    prefix[20] = '1'; // Not the null prevout of a coinbase transaction.
    assert(coinbase_extract_height(prefix, 8) == 0);
}

static void test_bitcoin(void) {
    mining_notification_result_t result;
    for (int outputs = 0; outputs <= 1; outputs++) {
        assert(decode(btc1, btc2, "e9695791", 4, "bc1qexample.worker", outputs, &result) == ESP_OK);
        assert(!result.is_peercoin && result.block_height == 25096);
        assert(result.total_value_satoshis == 5000000000ULL);
        assert(result.output_count == outputs);
        assert(strstr(result.scriptsig, "/slush/"));
        free(result.scriptsig);
    }
    char witness1[256], witness2[512];
    snprintf(witness1, sizeof(witness1), "010000000001%s", btc1 + 8);
    size_t body_len = strlen(btc2) - 8;
    memcpy(witness2, btc2, body_len);
    witness2[body_len] = 0;
    strcat(witness2, "0120000000000000000000000000000000000000000000000000000000000000000000000000");
    assert(decode(witness1, witness2, "e9695791", 4, "bc1qexample.worker", true, &result) == ESP_OK);
    assert(result.block_height == 25096 && result.total_value_satoshis == 5000000000ULL);
    free(result.scriptsig);
    // Initialize the production Base58 SHA256 callback via the normal decoder.
    uint8_t hash[20] = {0};
    size_t size = sizeof(peercoin_user);
    assert(b58check_enc(peercoin_user, &size, 55, hash, sizeof(hash)));
    strcat(peercoin_user, ".worker");
}

static void test_peercoin(void) {
    mining_notification_result_t result;
    for (int outputs = 0; outputs <= 1; outputs++) {
        assert(decode(PPC_COINBASE_1, PPC_COINBASE_2, "000000000000", 4, peercoin_user, outputs, &result) == ESP_OK);
        assert(result.is_peercoin && result.block_height == PPC_HEIGHT);
        assert(result.total_value_satoshis == PPC_TOTAL);
        assert(result.output_count == outputs * 2);
        if (outputs) {
            assert(strcmp(result.outputs[1].address, PPC_PAYOUT_ADDRESS) == 0);
            assert(result.outputs[1].value_satoshis == PPC_TOTAL);
        }
        assert(strstr(result.scriptsig, "/BCMonster/"));
        assert(isfinite(result.network_difficulty) && result.network_difficulty > 1);
        free(result.scriptsig);
    }
    // Peercoin v3 removed nTime from the serialization.
    char version3[sizeof(PPC_COINBASE_1)];
    strcpy(version3, "03000000");
    strcat(version3, PPC_COINBASE_1 + 16);
    assert(decode(version3, PPC_COINBASE_2, "000000000000", 4, peercoin_user, true, &result) == ESP_OK);
    assert(result.is_peercoin && result.block_height == PPC_HEIGHT && result.total_value_satoshis == PPC_TOTAL);
    free(result.scriptsig);
    assert(decode(PPC_COINBASE_1, PPC_COINBASE_2, "000000000000", 4, "Pinvalid.worker", true, &result) != ESP_OK);
}

static void test_digibyte(void) {
    mining_notification_result_t result;
    for (int outputs = 0; outputs <= 1; outputs++) {
        assert(decode(DGB_COINBASE_1, DGB_COINBASE_2, DGB_EXTRANONCE1, DGB_EXTRANONCE2_LEN,
                      DGB_PAYOUT_ADDRESS ".worker", outputs, &result) == ESP_OK);
        assert(result.network == MINING_NETWORK_DIGIBYTE && !result.is_peercoin);
        assert(result.block_height == DGB_HEIGHT && result.total_value_satoshis == DGB_TOTAL);
        assert(result.output_count == (outputs ? 3 : 0));
        assert(strstr(result.scriptsig, "/BCMonster/"));
        assert(result.user_value_satoshis == (outputs ? DGB_TOTAL : 0));
        if (outputs) {
            assert(!strcmp(result.outputs[2].address, DGB_PAYOUT_ADDRESS));
            assert(result.outputs[2].is_user_output);
        }
        free(result.scriptsig);
    }
    assert(mining_pool_is_zpool_sha256("sha256.mine.zpool.ca"));
    assert(mining_pool_is_zpool_sha256("SHA256.eu.mine.zpool.ca."));
    assert(mining_pool_is_zpool_sha256("sha256.na.mine.zpool.ca"));
    assert(!mining_pool_is_zpool_sha256("sha256.eu.mine.zpool.ca.example"));
    assert(!mining_pool_is_zpool_sha256("sha256.eu.attacker.mine.zpool.ca"));
    assert(!mining_pool_is_zpool_sha256("sha256.-eu.mine.zpool.ca"));
    assert(!mining_pool_is_zpool_sha256("scrypt.eu.mine.zpool.ca"));
    assert(!mining_pool_is_zpool_sha256("stratum.bcmonster.com"));
    assert(!mining_pool_is_zpool_sha256(NULL));
    assert(mining_network_job_supported(MINING_NETWORK_AUTO, 0x20000000));
    assert(mining_network_job_supported(MINING_NETWORK_AUTO, 0x20000202));
    assert(mining_network_version_mask(MINING_NETWORK_AUTO, 0x1fffe000) == 0x1fffe000);
    assert(!strcmp(mining_network_params(MINING_NETWORK_DIGIBYTE)->symbol, "DGB"));
    assert(mining_network_params(MINING_NETWORK_DIGIBYTE)->decimals == 8);
    assert(decode_network(DGB_COINBASE_1, DGB_COINBASE_2, DGB_EXTRANONCE1, DGB_EXTRANONCE2_LEN,
                          "pool-account.worker", MINING_NETWORK_DIGIBYTE, true, &result) == ESP_OK);
    assert(result.network == MINING_NETWORK_DIGIBYTE && result.user_value_satoshis == 0);
    free(result.scriptsig);
    char upper[128];
    strcpy(upper, DGB_PAYOUT_ADDRESS);
    for (char *p = upper; *p; p++) *p = toupper((unsigned char)*p);
    strcat(upper, ".worker");
    assert(decode(DGB_COINBASE_1, DGB_COINBASE_2, DGB_EXTRANONCE1, DGB_EXTRANONCE2_LEN,
                  upper, true, &result) == ESP_OK);
    assert(result.network == MINING_NETWORK_DIGIBYTE && result.user_value_satoshis == DGB_TOTAL);
    free(result.scriptsig);

    const struct { const char *script, *address; } vectors[] = {
        {"76a914000000000000000000000000000000000000000088ac", "D596YFweJQuHY1BbjazZYmAbt8jJPbKehC"},
        {"a914000000000000000000000000000000000000000087", "SMJ12qn9jNCCXJnTYRz5Yu9ZenERqvYwfg"},
        {"210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac", "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE"},
        {"00200000000000000000000000000000000000000000000000000000000000000000", "dgb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkayj5c"},
        {"51200101010101010101010101010101010101010101010101010101010101010101", "dgb1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsecap6x"},
    };
    for (size_t i = 0; i < sizeof(vectors) / sizeof(*vectors); i++) {
        assert(mining_network_resolve(MINING_NETWORK_AUTO, vectors[i].address) == MINING_NETWORK_DIGIBYTE);
        char second[512];
        snprintf(second, sizeof(second), "072f736c7573682f00000000010100000000000000%02x%s00000000",
                 (unsigned)(strlen(vectors[i].script) / 2), vectors[i].script);
        assert(decode_network(btc1, second, "e9695791", 4, vectors[i].address,
                              MINING_NETWORK_DIGIBYTE, true, &result) == ESP_OK);
        assert(result.output_count == 1 && result.total_value_satoshis == 1);
        assert(!strcmp(result.outputs[0].address, vectors[i].address));
        assert(result.user_value_satoshis == 1);
        free(result.scriptsig);
        if (i == 1) { // Legacy DigiByte P2SH shares Bitcoin's version byte 5.
            const char *legacy = "31h1vYVSYuKP6AhS86fbRdMw9XHieotbST";
            assert(mining_network_resolve(MINING_NETWORK_AUTO, legacy) == MINING_NETWORK_BITCOIN);
            assert(decode_network(btc1, second, "e9695791", 4, legacy,
                                  MINING_NETWORK_DIGIBYTE, true, &result) == ESP_OK);
            assert(result.user_value_satoshis == 1 && !strcmp(result.outputs[0].address, vectors[i].address));
            free(result.scriptsig);
        }
    }
    char invalid[128]; strcpy(invalid, DGB_PAYOUT_ADDRESS);
    invalid[strlen(invalid) - 1] = invalid[strlen(invalid) - 1] == 'q' ? 'p' : 'q';
    assert(mining_network_resolve(MINING_NETWORK_AUTO, invalid) == MINING_NETWORK_BITCOIN);
    assert(mining_network_resolve(MINING_NETWORK_DIGIBYTE, "account.worker") == MINING_NETWORK_DIGIBYTE);
    assert(mining_network_resolve(MINING_NETWORK_BITCOIN, DGB_PAYOUT_ADDRESS) == MINING_NETWORK_BITCOIN);
    for (unsigned algo = 0; algo < 16; algo++)
        assert(mining_network_job_supported(MINING_NETWORK_DIGIBYTE, 0x20000002 | (algo << 8)) == (algo == 2));
    assert(mining_network_version_mask(MINING_NETWORK_DIGIBYTE, UINT32_MAX) == 0xfffff0ffu);
    assert(mining_network_version_mask(MINING_NETWORK_BITCOIN, UINT32_MAX) == UINT32_MAX);
    assert(mining_network_version_mask(MINING_NETWORK_DIGIBYTE, 0x1fffe000) == 0x1fffe000);
    assert(decode_network(btc1, btc2, "e9695791", 4, "account", (mining_network_t)4, true, &result) == ESP_ERR_INVALID_ARG);
    for (size_t n = 0; n < strlen(DGB_COINBASE_2); n += 2) {
        char truncated[sizeof(DGB_COINBASE_2)];
        memcpy(truncated, DGB_COINBASE_2, n); truncated[n] = 0;
        assert(decode(DGB_COINBASE_1, truncated, DGB_EXTRANONCE1, DGB_EXTRANONCE2_LEN,
                      DGB_PAYOUT_ADDRESS, true, &result) != ESP_OK);
        free(result.scriptsig);
    }
}

static void test_addresses_and_output_limit(void) {
    // Replace the real pool outputs with eight P2PKH outputs, each worth 1 PPC.
    // Total/user amounts include every output; only the six display entries are capped.
    char second[1024] = "0b2f42434d6f6e737465722f0000000008";
    const char *output = "40420f00000000001976a914000000000000000000000000000000000000000088ac";
    for (int i = 0; i < 8; i++) strcat(second, output);
    strcat(second, "00000000");
    mining_notification_result_t result;
    assert(decode(PPC_COINBASE_1, second, "000000000000", 4, peercoin_user, true, &result) == ESP_OK);
    assert(result.output_count == MAX_COINBASE_TX_OUTPUTS);
    assert(result.total_value_satoshis == 8000000 && result.user_value_satoshis == 8000000);
    assert(result.outputs[0].address[0] == 'P' && result.outputs[0].is_user_output);
    free(result.scriptsig);
    // A different address with the same prefix must not be treated as our payout.
    char wrong_user[128];
    uint8_t different_hash[20] = {1};
    size_t size = sizeof(wrong_user);
    assert(b58check_enc(wrong_user, &size, 55, different_hash, sizeof(different_hash)));
    strcat(wrong_user, ".worker");
    assert(decode(PPC_COINBASE_1, second, "000000000000", 4, wrong_user, true, &result) == ESP_OK);
    assert(result.user_value_satoshis == 0);
    free(result.scriptsig);
}

static void test_p2pk_addresses(void) {
    // secp256k1 generator G: compressed and uncompressed encodings have
    // different key-hash addresses. The expected vectors are independent
    // of the production codec (OpenSSL/hashlib + Base58Check).
    const char *compressed = "210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";
    const char *uncompressed = "410479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8ac";
    uint8_t script[67];
    char address[MAX_ADDRESS_STRING_LEN];
    hex2bin(compressed, script, 35);
    coinbase_decode_address_from_scriptpubkey(script, 35, address, sizeof(address));
    assert(strcmp(address, "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH") == 0);
    script[1] = 0x04; // Wrong key header for a 33-byte key.
    coinbase_decode_address_from_scriptpubkey(script, 35, address, sizeof(address));
    assert(strncmp(address, "UNKNOWN:", 8) == 0);
    hex2bin(compressed, script, 35);
    script[34] = 0xad; // CHECKSIGVERIFY is not the supported P2PK template.
    coinbase_decode_address_from_scriptpubkey(script, 35, address, sizeof(address));
    assert(strncmp(address, "UNKNOWN:", 8) == 0);
    hex2bin(uncompressed, script, sizeof(script));
    coinbase_decode_address_from_scriptpubkey(script, sizeof(script), address, sizeof(address));
    assert(strcmp(address, "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm") == 0);
    coinbase_decode_address_from_scriptpubkey(script, sizeof(script) - 1, address, sizeof(address));
    assert(strncmp(address, "UNKNOWN:", 8) == 0);
}

static void test_truncation_and_mutation(void) {
    mining_notification_result_t result;
    for (size_t i = 0; i < strlen(PPC_COINBASE_1); i++) {
        char first[sizeof(PPC_COINBASE_1)];
        memcpy(first, PPC_COINBASE_1, i); first[i] = 0;
        assert(decode(first, PPC_COINBASE_2, "000000000000", 4, peercoin_user, true, &result) != ESP_OK);
        assert(result.block_height == 0 && result.output_count == 0);
        free(result.scriptsig);
    }
    for (size_t i = 0; i < strlen(PPC_COINBASE_2); i++) {
        char second[sizeof(PPC_COINBASE_2)];
        memcpy(second, PPC_COINBASE_2, i); second[i] = 0;
        assert(decode(PPC_COINBASE_1, second, "000000000000", 4, peercoin_user, true, &result) != ESP_OK);
        assert(result.block_height == 0 && result.total_value_satoshis == 0);
        free(result.scriptsig);
    }
    assert(decode(PPC_COINBASE_1, PPC_COINBASE_2, "zz", 4, peercoin_user, true, &result) != ESP_OK);
    assert(decode(PPC_COINBASE_1, PPC_COINBASE_2, "00", -1, peercoin_user, true, &result) != ESP_OK);
    assert(decode(PPC_COINBASE_1, PPC_COINBASE_2, "00", INT32_MAX, peercoin_user, true, &result) != ESP_OK);
    for (int i = 0; i < 10000; i++) {
        char first[sizeof(PPC_COINBASE_1)], second[sizeof(PPC_COINBASE_2)];
        strcpy(first, PPC_COINBASE_1); strcpy(second, PPC_COINBASE_2);
        char *part = i & 1 ? first : second;
        size_t position = (size_t)rand() % strlen(part);
        part[position] = "0123456789abcdef"[rand() % 16];
        if (decode(first, second, "000000000000", 4, peercoin_user, true, &result) != ESP_OK) {
            assert(result.block_height == 0 && result.output_count == 0);
        }
        free(result.scriptsig);
    }
}

int main(void) {
    test_compactsize();
    test_bitcoin();
    test_height_without_chain();
    test_peercoin();
    test_digibyte();
    test_addresses_and_output_limit();
    test_p2pk_addresses();
    test_truncation_and_mutation();
#ifdef COINBASE_COMPARE_RUST
    puts("C/Rust parity: status, height, tag, currency, all displayed outputs and total/user amounts match.");
#endif
    puts("Coinbase decoder passed: Bitcoin, Peercoin v1/v3, real BCMonster PPC/DGB jobs, DGB address/algorithm vectors, output cap, truncations and 10000 mutations (ASan/UBSan).");
    return 0;
}
