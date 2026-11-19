#include "coinbase_decoder.h"
#include "utils.h"
#include "segwit_addr.h"
#include "libbase58.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <limits.h>
#include "bitcoin_hash.h"
#if CONFIG_COINBASE_RUST
#include "coinbase_rust.h"
#endif
#if CONFIG_COINBASE_PROFILE
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <inttypes.h>
#endif

// Wrapper for SHA256 to match libbase58's expected signature
static bool my_sha256(void *digest, const void *data, size_t datasz) {
    sha256_digest(data, datasz, digest);
    return true;
}

static void ensure_base58_init(void) {
    if (b58_sha256_impl == NULL) {
        b58_sha256_impl = my_sha256;
    }
}

bool coinbase_decode_varint(const uint8_t *data, size_t data_len, size_t *offset, uint64_t *value) {
    if (!data || !offset || !value || *offset >= data_len) return false;
    size_t pos = *offset;
    uint8_t prefix = data[pos++];
    size_t count = prefix < 0xfd ? 0 : prefix == 0xfd ? 2 : prefix == 0xfe ? 4 : 8;
    if (count > data_len - pos) return false;
    uint64_t decoded = count == 0 ? prefix : 0;
    for (size_t i = 0; i < count; i++) {
        decoded |= (uint64_t)data[pos + i] << (8 * i);
    }
    if ((count == 2 && decoded < 0xfd) || (count == 4 && decoded <= UINT16_MAX) ||
        (count == 8 && decoded <= UINT32_MAX)) return false;
    *offset = pos + count;
    *value = decoded;
    return true;
}

static void decode_address(const uint8_t *script, size_t script_len,
                           char *output, size_t output_len, mining_network_t network) {
    const mining_network_params_t *params = mining_network_params(network);
    if (script_len == 0 || output_len < 65) {
        snprintf(output, output_len, "unknown");
        return;
    }
    
    ensure_base58_init();

    // P2PK: a compressed or uncompressed public key followed by OP_CHECKSIG.
    // Display its associated key-hash address, as Peercoin Core does for P2PK.
    bool compressed_key = script_len == 35 && script[0] == 33 &&
                          (script[1] == 0x02 || script[1] == 0x03);
    bool uncompressed_key = script_len == 67 && script[0] == 65 && script[1] == 0x04;
    if ((compressed_key || uncompressed_key) && script[script_len - 1] == OP_CHECKSIG) {
        uint8_t sha256[32], key_hash[20];
        size_t b58sz = output_len;
        sha256_digest(script + 1, script_len - 2, sha256);
        ripemd160_digest(sha256, sizeof(sha256), key_hash);
        if (b58check_enc(output, &b58sz, params->pubkey_prefix, key_hash, sizeof(key_hash))) {
            return;
        }
        snprintf(output, output_len, "P2PK: address unavailable");
        return;
    }
    
    // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    if (script_len == 25 && script[0] == OP_DUP && script[1] == OP_HASH160 && 
        script[2] == OP_PUSHDATA_20 && script[23] == OP_EQUALVERIFY && script[24] == OP_CHECKSIG) {
        size_t b58sz = output_len;
        // 0x00 is version for Mainnet P2PKH
        if (b58check_enc(output, &b58sz, params->pubkey_prefix, script + 3, 20)) {
            return;
        }
        // Fallback
        snprintf(output, output_len, "P2PKH:");
        bin2hex(script + 3, 20, output + 6, output_len - 6);
        return;
    }
    
    // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
    if (script_len == 23 && script[0] == OP_HASH160 && script[1] == OP_PUSHDATA_20 && script[22] == OP_EQUAL) {
        size_t b58sz = output_len;
        // 0x05 is version for Mainnet P2SH
        if (b58check_enc(output, &b58sz, params->script_prefix, script + 2, 20)) {
            return;
        }
        // Fallback
        snprintf(output, output_len, "P2SH:");
        bin2hex(script + 2, 20, output + 5, output_len - 5);
        return;
    }
    
    // P2WPKH: OP_0 <20 bytes>
    if (script_len == 22 && script[0] == OP_0 && script[1] == OP_PUSHDATA_20) {
        if (segwit_addr_encode(output, params->hrp, 0, script + 2, 20)) {
            return;
        }
        // Fallback to hex if encoding fails
        snprintf(output, output_len, "P2WPKH:");
        bin2hex(script + 2, 20, output + 7, output_len - 7);
        return;
    }
    
    // P2WSH: OP_0 <32 bytes>
    if (script_len == 34 && script[0] == OP_0 && script[1] == OP_PUSHDATA_32) {
        if (segwit_addr_encode(output, params->hrp, 0, script + 2, 32)) {
            return;
        }
        // Fallback to hex if encoding fails
        snprintf(output, output_len, "P2WSH:");
        bin2hex(script + 2, 32, output + 6, output_len - 6);
        return;
    }
    
    // P2TR: OP_1 <32 bytes>
    if (script_len == 34 && script[0] == OP_1 && script[1] == OP_PUSHDATA_32) {
        if (segwit_addr_encode(output, params->hrp, 1, script + 2, 32)) {
            return;
        }
        // Fallback to hex if encoding fails
        snprintf(output, output_len, "P2TR:");
        bin2hex(script + 2, 32, output + 5, output_len - 5);
        return;
    }

    // OP_RETURN: OP_RETURN <data>
    if (script_len > 0 && script[0] == OP_RETURN) {
        snprintf(output, output_len, "OP_RETURN: ");
        size_t offset = 1;
        
        // Simple check for small pushdata to skip the length byte
        // If script[1] is the length of the remaining data
        if (script_len > 1 && script[1] > 0 && script[1] <= 0x4b && (size_t)script[1] + 2 == script_len) {
            offset = 2;
        }
        
        size_t out_idx = strlen(output);
        for (size_t i = offset; i < script_len && out_idx < output_len - 1; i++) {
            unsigned char c = script[i];
            output[out_idx++] = isprint(c) ? c : '.';
        }
        output[out_idx] = '\0';
        return;
    }
    
    // Unknown format - just show hex
    snprintf(output, output_len, "UNKNOWN:");
    size_t hex_len = script_len < 32 ? script_len : 32; // Limit to 32 bytes
    bin2hex(script, hex_len, output + 8, output_len - 8);
}

void coinbase_decode_address_from_scriptpubkey(const uint8_t *script, size_t script_len,
                                                char *output, size_t output_len) {
    decode_address(script, script_len, output, output_len, MINING_NETWORK_BITCOIN);
}

static bool decode_hex(const char *hex, uint8_t *destination, size_t length) {
    for (size_t i = 0; i < length * 2; i++) {
        if (!isxdigit((unsigned char)hex[i])) return false;
    }
    return hex2bin(hex, destination, length) == length;
}

static uint32_t height_from_prefix(const uint8_t *tx, size_t len, size_t offset,
                                   size_t first_part_len, size_t extranonce_bytes)
{
    if (offset + 2 <= len && tx[offset] == 0 && tx[offset + 1] == 1) offset += 2;
    uint64_t input_count;
    if (!coinbase_decode_varint(tx, len, &offset, &input_count) || input_count != 1 ||
        len - offset < 36) return 0;
    for (size_t i = 0; i < 32; ++i) {
        if (tx[offset + i] != 0) return 0;
    }
    for (size_t i = 32; i < 36; ++i) {
        if (tx[offset + i] != 0xff) return 0;
    }
    offset += 36;

    uint64_t script_len;
    if (!coinbase_decode_varint(tx, len, &offset, &script_len) || script_len < 2 ||
        script_len > 100 || offset >= len || first_part_len < offset ||
        first_part_len - offset > script_len ||
        extranonce_bytes > script_len - (first_part_len - offset)) return 0;

    uint8_t push_len = tx[offset++];
    if (push_len < 1 || push_len > 4 || push_len > len - offset || push_len >= script_len) return 0;
    uint8_t last = tx[offset + push_len - 1];
    if (last & 0x80) return 0; // Negative CScriptNum.
    if (last == 0 && (push_len == 1 || !(tx[offset + push_len - 2] & 0x80))) return 0;

    uint32_t height = 0;
    for (size_t i = 0; i < push_len; ++i) height |= (uint32_t)tx[offset + i] << (8 * i);
    return height > 16 ? height : 0;
}

uint32_t coinbase_extract_height(const char *coinbase1, size_t extranonce_bytes)
{
    if (!coinbase1) return 0;
    size_t hex_len = strlen(coinbase1);
    if (hex_len % 2 || hex_len < 8) return 0;
    // Only version, optional nTime and the very beginning of the input are needed.
    uint8_t prefix[64];
    size_t len = hex_len / 2 < sizeof(prefix) ? hex_len / 2 : sizeof(prefix);
    if (!decode_hex(coinbase1, prefix, len)) return 0;

    uint32_t height = height_from_prefix(prefix, len, 4, hex_len / 2, extranonce_bytes);
    // Some SHA-256 chains include a timestamp in version 1/2 transactions.
    if ((prefix[0] == 1 || prefix[0] == 2) && !(prefix[1] | prefix[2] | prefix[3])) {
        uint32_t timed_height = height_from_prefix(prefix, len, 8, hex_len / 2, extranonce_bytes);
        if (height && timed_height && height != timed_height) return 0;
        if (!height) height = timed_height;
    }
    return height;
}

typedef struct {
    const char *address;
    mining_notification_result_t *result;
} output_context_t;

static void record_output(void *opaque, uint64_t value, const uint8_t *script, size_t length) {
    output_context_t *context = opaque;
    mining_notification_result_t *result = context->result;
    char output_address[MAX_ADDRESS_STRING_LEN];
    decode_address(script, length, output_address, sizeof(output_address), result->network);
    bool is_user_output = strcmp(context->address, output_address) == 0;
    if (is_user_output) result->user_value_satoshis += value;
    if (result->output_count < MAX_COINBASE_TX_OUTPUTS) {
        coinbase_output_t *output = &result->outputs[result->output_count++];
        memcpy(output->address, output_address, strlen(output_address) + 1);
        output->value_satoshis = value;
        output->is_user_output = is_user_output;
    }
}

static esp_err_t process_notification(const mining_notify *notification,
                                       const char *extranonce1,
                                       int extranonce2_len,
                                       const char *user_address,
                                       mining_network_t network,
                                       bool decode_outputs,
                                       mining_notification_result_t *result) {
    if (!notification || !notification->coinbase_1 || !notification->coinbase_2 ||
        !extranonce1 || !user_address || !result || extranonce2_len < 0 ||
        extranonce2_len > MAX_EXTRANONCE_2_LEN || network < MINING_NETWORK_AUTO ||
        network > MINING_NETWORK_DIGIBYTE) return ESP_ERR_INVALID_ARG;

    memset(result, 0, sizeof(*result));
    result->network_difficulty = networkDifficulty(notification->target);
    result->decoding_enabled = decode_outputs;

    // Stratum usernames may append a worker name to the payout address.
    char address[MAX_ADDRESS_STRING_LEN];
    size_t address_len = strcspn(user_address, ".");
    if (address_len >= sizeof(address)) return ESP_ERR_INVALID_ARG;
    memcpy(address, user_address, address_len);
    address[address_len] = '\0';
    result->network = mining_network_resolve(network, address);
    result->is_peercoin = result->network == MINING_NETWORK_PEERCOIN;
    char normalized[MAX_ADDRESS_STRING_LEN];
    mining_network_normalize_address(result->network, address, normalized, sizeof(normalized));
    memcpy(address, normalized, strlen(normalized) + 1);

    size_t hex1_len = strlen(notification->coinbase_1);
    size_t hex2_len = strlen(notification->coinbase_2);
    size_t extra_hex_len = strlen(extranonce1);
    if ((hex1_len | hex2_len | extra_hex_len) & 1) return ESP_ERR_INVALID_ARG;
    size_t part1_len = hex1_len / 2, part2_len = hex2_len / 2, extra1_len = extra_hex_len / 2;
    if (extra1_len > MAX_EXTRANONCE_2_LEN) return ESP_ERR_INVALID_ARG;
    size_t extra_len = extra1_len + (size_t)extranonce2_len;
    if (part1_len > SIZE_MAX - extra_len || part2_len > SIZE_MAX - part1_len - extra_len) return ESP_ERR_INVALID_ARG;
    size_t tx_len = part1_len + extra_len + part2_len;
    if (tx_len < 10) return ESP_ERR_INVALID_ARG;
    uint8_t *tx = calloc(tx_len, 1);
    if (!tx) return ESP_ERR_NO_MEM;
    esp_err_t status = ESP_ERR_INVALID_ARG;
    if (!decode_hex(notification->coinbase_1, tx, part1_len) ||
        !decode_hex(extranonce1, tx + part1_len, extra1_len) ||
        !decode_hex(notification->coinbase_2, tx + part1_len + extra_len, part2_len)) goto cleanup;

    output_context_t context = {.address = address, .result = result};
#if CONFIG_COINBASE_RUST
    coinbase_rs_layout_t layout;
    if (!coinbase_rs_parse(tx, tx_len, part1_len, extra_len, result->is_peercoin,
                           &layout, decode_outputs ? record_output : NULL, &context)) goto cleanup;
    size_t script_len = layout.script_len, script_end = layout.script_end, tag_start = layout.tag_start;
    result->block_height = layout.height;
    result->total_value_satoshis = layout.total;
#else
    uint32_t version = (uint32_t)tx[0] | (uint32_t)tx[1] << 8 |
                       (uint32_t)tx[2] << 16 | (uint32_t)tx[3] << 24;
    // Peercoin versions 1/2 serialize nTime after nVersion; version 3 does not.
    size_t offset = result->is_peercoin && version < 3 ? 8 : 4;
    bool has_witness = false;
    if (offset + 2 <= tx_len && tx[offset] == 0 && tx[offset + 1] == 1) {
        has_witness = true;
        offset += 2;
    }
    uint64_t inputs;
    if (!coinbase_decode_varint(tx, tx_len, &offset, &inputs) || inputs != 1 || tx_len - offset < 36) goto cleanup;
    for (size_t i = 0; i < 32; i++) {
        if (tx[offset + i] != 0) goto cleanup;
    }
    for (size_t i = 32; i < 36; i++) {
        if (tx[offset + i] != 0xff) goto cleanup;
    }
    offset += 36;
    uint64_t script_len;
    if (!coinbase_decode_varint(tx, tx_len, &offset, &script_len) || script_len < 2 ||
        script_len > 100 || script_len > tx_len - offset) goto cleanup;
    size_t script_start = offset, script_end = offset + (size_t)script_len;
    if (part1_len < script_start || part1_len + extra_len > script_end) goto cleanup;

    uint8_t height_len = tx[offset++];
    if (height_len == 0 || height_len > 5 || height_len > script_end - offset ||
        (tx[offset + height_len - 1] & 0x80)) goto cleanup;
    uint64_t height = 0;
    for (size_t i = 0; i < height_len; i++) height |= (uint64_t)tx[offset + i] << (8 * i);
    if (height == 0 || height > INT32_MAX || offset + height_len > part1_len) goto cleanup;
    result->block_height = (uint32_t)height;
    size_t tag_start = offset + height_len;

    offset = script_end;
    if (tx_len - offset < 4) goto cleanup;
    offset += 4; // Input sequence.
    uint64_t output_count;
    if (!coinbase_decode_varint(tx, tx_len, &offset, &output_count) || output_count == 0 ||
        output_count > (tx_len - offset) / 9) goto cleanup;
    for (uint64_t i = 0; i < output_count; i++) {
        if (tx_len - offset < 8) goto cleanup;
        uint64_t value = 0;
        for (size_t j = 0; j < 8; j++) value |= (uint64_t)tx[offset + j] << (8 * j);
        offset += 8;
        if (value > INT64_MAX || value > (uint64_t)INT64_MAX - result->total_value_satoshis) goto cleanup;
        uint64_t pubkey_len;
        if (!coinbase_decode_varint(tx, tx_len, &offset, &pubkey_len) || pubkey_len > tx_len - offset) goto cleanup;
        result->total_value_satoshis += value;
        if (decode_outputs) {
            record_output(&context, value, tx + offset, (size_t)pubkey_len);
        }
        offset += (size_t)pubkey_len;
    }
    if (has_witness) {
        uint64_t items;
        if (!coinbase_decode_varint(tx, tx_len, &offset, &items) || items > tx_len - offset) goto cleanup;
        for (uint64_t i = 0; i < items; i++) {
            uint64_t item_len;
            if (!coinbase_decode_varint(tx, tx_len, &offset, &item_len) || item_len > tx_len - offset) goto cleanup;
            offset += (size_t)item_len;
        }
    }
    if (tx_len - offset != 4) goto cleanup; // Locktime, with no truncated/trailing data.
#endif

    // Exclude extranonces from the human-readable pool tag, wherever the split falls.
    result->scriptsig = malloc((size_t)script_len + 1);
    if (!result->scriptsig) {
        status = ESP_ERR_NO_MEM;
        goto cleanup;
    }
    size_t tag_len = 0;
    for (size_t i = tag_start; i < script_end; i++) {
        if (i >= part1_len && i < part1_len + extra_len) continue;
        result->scriptsig[tag_len++] = isprint(tx[i]) ? (char)tx[i] : '.';
    }
    result->scriptsig[tag_len] = '\0';
    status = ESP_OK;
cleanup:
    free(tx);
    if (status != ESP_OK) {
        // Never return apparently valid block/output values from a truncated job.
        result->block_height = 0;
        result->output_count = 0;
        result->total_value_satoshis = 0;
        result->user_value_satoshis = 0;
    }
    return status;
}

esp_err_t coinbase_process_notification(const mining_notify *notification,
                                       const char *extranonce1, int extranonce2_len,
                                       const char *user_address, mining_network_t network, bool decode_outputs,
                                       mining_notification_result_t *result) {
#if CONFIG_COINBASE_PROFILE
    size_t heap_before = heap_caps_get_free_size(MALLOC_CAP_8BIT);
    int64_t started = esp_timer_get_time();
#endif
    esp_err_t status = process_notification(notification, extranonce1, extranonce2_len,
                                            user_address, network, decode_outputs, result);
#if CONFIG_COINBASE_PROFILE
    int64_t elapsed = esp_timer_get_time() - started;
#if CONFIG_COINBASE_RUST
    const char *backend = "rust";
#else
    const char *backend = "c";
#endif
    // Measurements are task-local. Heap values are system snapshots: other tasks
    // can allocate concurrently. IDF stack high-water marks are bytes, not words.
    ESP_LOGI("coinbase_profile", "backend=%s outputs=%d status=%d us=%" PRId64
             " heap_before=%u heap_after=%u heap_min=%u stack_free_min=%u",
             backend, decode_outputs, (int)status, elapsed, (unsigned)heap_before,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
             (unsigned)uxTaskGetStackHighWaterMark(NULL));
#endif
    return status;
}
