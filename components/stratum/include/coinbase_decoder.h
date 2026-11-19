#ifndef COINBASE_DECODER_H
#define COINBASE_DECODER_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"
#include "stratum_api.h"
#include "mining_network.h"

#define MAX_ADDRESS_STRING_LEN 128
#define MAX_COINBASE_TX_OUTPUTS 6

// Bitcoin Script Opcodes
#define OP_0            0x00
#define OP_PUSHDATA_20  0x14  // Push next 20 bytes
#define OP_PUSHDATA_32  0x20  // Push next 32 bytes
#define OP_1            0x51
#define OP_RETURN       0x6a
#define OP_DUP          0x76
#define OP_EQUAL        0x87
#define OP_EQUALVERIFY  0x88
#define OP_HASH160      0xa9
#define OP_CHECKSIG     0xac

/**
 * @brief Decode a bounded, canonical CompactSize integer
 * 
 * @param data Binary data containing the varint
 * @param data_len Available bytes
 * @param offset Updated only after a successful read
 * @param value Output value
 * @return true on success; false for truncated/non-canonical encodings
 */
bool coinbase_decode_varint(const uint8_t *data, size_t data_len, size_t *offset, uint64_t *value);

// Read a minimally encoded height from the first coinbase input, without
// identifying a chain or decoding outputs. Zero means no unambiguous height.
uint32_t coinbase_extract_height(const char *coinbase1, size_t extranonce_bytes);

/**
 * @brief Decode Bitcoin address from scriptPubKey
 * 
 * Supports P2PK, P2PKH, P2SH, P2WPKH, P2WSH, and P2TR scripts.
 * P2PK displays the address of the public key hash. Unsupported scripts use
 * a descriptive prefix followed by hexadecimal data.
 * 
 * @param script ScriptPubKey binary data
 * @param script_len Length of scriptPubKey
 * @param output Output buffer for address string
 * @param output_len Size of output buffer (should be at least MAX_ADDRESS_STRING_LEN)
 */
void coinbase_decode_address_from_scriptpubkey(const uint8_t *script, size_t script_len, 
                                                char *output, size_t output_len);

/**
 * @brief Structure representing a decoded coinbase transaction output
 */
typedef struct {
    uint64_t value_satoshis;
    char address[MAX_ADDRESS_STRING_LEN];
    bool is_user_output;
} coinbase_output_t;

/**
 * @brief Result structure for full mining notification processing
 */
typedef struct {
    double network_difficulty;
    uint32_t block_height;
    char *scriptsig; // Allocated, must be freed by caller
    coinbase_output_t outputs[MAX_COINBASE_TX_OUTPUTS];
    int output_count;
    uint64_t total_value_satoshis;
    uint64_t user_value_satoshis;
    bool decoding_enabled;
    bool is_peercoin;
    mining_network_t network;
} mining_notification_result_t;

/**
 * @brief Process a mining notification to extract all relevant data
 * 
 * @param notification Pointer to the mining notification
 * @param extranonce1 Hex string of extranonce1
 * @param extranonce2_len Length of extranonce2 in bytes
 * @param user_address Payout address of the user
 * @param network Auto-detect from the payout address or an explicit mainnet coin
 * @param decode_outputs Enable coinbase tx decoding
 * @param result Pointer to store the results
 * @return esp_err_t
 */
esp_err_t coinbase_process_notification(const mining_notify *notification,
                                 const char *extranonce1,
                                 int extranonce2_len,
                                 const char *user_address,
                                 mining_network_t network,
                                 bool decode_outputs,
                                 mining_notification_result_t *result);

#endif // COINBASE_DECODER_H
