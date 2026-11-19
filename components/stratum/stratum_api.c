/******************************************************************************
 *  *
 * References:
 *  1. Stratum Protocol - [link](https://reference.cash/mining/stratum-protocol)
 *****************************************************************************/

#include "stratum_api.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_transport.h"
#include "esp_transport_ssl.h"
#include "esp_transport_tcp.h"
#include "esp_crt_bundle.h"
#include "utils.h"
#include "esp_timer.h"
#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdbool.h>
#include <pthread.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TRANSPORT_TIMEOUT_MS 5000
#define BUFFER_SIZE 1024
#define MAX_STRATUM_BUFFER (256 * 1024)
#define SHARE_WRITE_TIMEOUT_MS 250
#define MAX_EXTRANONCE_2_LEN 32
static const char * TAG = "stratum_api";

// esp_transport_write() does a single send(): with SO_SNDTIMEO it may accept only part
// of a line. Finish the line within the same overall timeout. A line left incomplete
// corrupts the Stratum stream, so that case returns -1 and the caller reconnects.
static int write_all(esp_transport_handle_t transport, const char *data, int length, int timeout_ms)
{
    const int64_t deadline_us = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    int sent = 0;
    while (sent < length) {
        int wait_ms = timeout_ms;
        if (sent > 0) {
            const int64_t left_us = deadline_us - esp_timer_get_time();
            if (left_us <= 0) return -1;
            wait_ms = (int)((left_us + 999) / 1000);
        }
        const int ret = esp_transport_write(transport, data + sent, length - sent, wait_ms);
        if (ret <= 0) return sent == 0 ? ret : -1;
        sent += ret;
    }
    return sent;
}

static char * json_rpc_buffer = NULL;
static size_t json_rpc_buffer_size = 0;
static size_t json_rpc_used = 0;

typedef struct {
    int64_t timestamp_us;
    int request_id; // Zero means there is no outstanding share in this slot.
} RequestTiming;

static RequestTiming request_timings[MAX_REQUEST_IDS];
static pthread_mutex_t request_timing_lock = PTHREAD_MUTEX_INITIALIZER;

float STRATUM_V1_get_response_time_ms(int request_id, int64_t receive_time_us)
{
    if (request_id < STRATUM_FIRST_SHARE_ID) return -1.0f;

    pthread_mutex_lock(&request_timing_lock);
    RequestTiming *timing = &request_timings[request_id % MAX_REQUEST_IDS];
    float elapsed = -1.0f;
    if (timing->request_id == request_id) {
        elapsed = (receive_time_us - timing->timestamp_us) / 1000.0f;
        timing->request_id = 0;
    }
    pthread_mutex_unlock(&request_timing_lock);
    return elapsed;
}

esp_transport_handle_t STRATUM_V1_transport_init(tls_mode tls, char * cert)
{
    esp_transport_handle_t transport;
    // tls_transport
    if (tls == DISABLED)
    {
        // tcp_transport
        ESP_LOGI(TAG, "TLS disabled, Using TCP transport");
        transport = esp_transport_tcp_init();
    }
    else{
        // tls_transport
        ESP_LOGI(TAG, "Using TLS transport");
        transport = esp_transport_ssl_init();
        if (transport == NULL) {
            ESP_LOGE(TAG, "Failed to initialize SSL transport");
            return NULL;
        }
        switch(tls){
            case BUNDLED_CRT:
                ESP_LOGI(TAG, "Using default cert bundle");
                esp_transport_ssl_crt_bundle_attach(transport, esp_crt_bundle_attach);
                break;
            case CUSTOM_CRT:
                ESP_LOGI(TAG, "Using custom cert");
                if (cert == NULL) {
                    ESP_LOGE(TAG, "Error: no TLS certificate");
                    return NULL;
                }
                esp_transport_ssl_set_cert_data(transport, cert, strlen(cert));
                break;
            default:
                ESP_LOGE(TAG, "Invalid TLS mode");
                esp_transport_destroy(transport);
                return NULL;
        }
    }
    return transport;
}

void STRATUM_V1_initialize_buffer()
{
    json_rpc_used = 0;

    pthread_mutex_lock(&request_timing_lock);
    memset(request_timings, 0, sizeof(request_timings));
    pthread_mutex_unlock(&request_timing_lock);
}

void cleanup_stratum_buffer(void)
{
    free(json_rpc_buffer);
    json_rpc_buffer = NULL;
    json_rpc_buffer_size = json_rpc_used = 0;
}

static bool append_rpc_bytes(const char *chunk, size_t length)
{
    if (length > MAX_STRATUM_BUFFER - json_rpc_used || memchr(chunk, 0, length)) return false;
    if (json_rpc_used + length > json_rpc_buffer_size) {
        size_t capacity = json_rpc_buffer_size ? json_rpc_buffer_size : BUFFER_SIZE;
        while (capacity < json_rpc_used + length) capacity *= 2;
        char *buffer = realloc(json_rpc_buffer, capacity);
        if (!buffer) return false;
        json_rpc_buffer = buffer;
        json_rpc_buffer_size = capacity;
    }
    memcpy(json_rpc_buffer + json_rpc_used, chunk, length);
    json_rpc_used += length;
    return true;
}

stratum_read_result STRATUM_V1_read_step(esp_transport_handle_t transport, int timeout_ms, char **line)
{
    *line = NULL;
    char *newline = json_rpc_used ? memchr(json_rpc_buffer, '\n', json_rpc_used) : NULL;
    if (!newline) {
        char chunk[BUFFER_SIZE];
        int count = esp_transport_read(transport, chunk, sizeof(chunk), timeout_ms);
        if (count < 0) {
            ESP_LOGW(TAG, "Stratum transport read failed (%d)", count);
            json_rpc_used = 0;
            return STRATUM_READ_ERROR;
        }
        if (count > 0 && !append_rpc_bytes(chunk, count)) {
            ESP_LOGW(TAG, "Stratum line exceeds buffer capacity or contains a NUL");
            json_rpc_used = 0;
            return STRATUM_READ_ERROR;
        }
        newline = json_rpc_used ? memchr(json_rpc_buffer, '\n', json_rpc_used) : NULL;
        if (!newline) return json_rpc_used ? STRATUM_READ_MORE : STRATUM_READ_IDLE;
    }
    size_t length = newline - json_rpc_buffer;
    *line = strndup(json_rpc_buffer, length);
    json_rpc_used -= length + 1;
    memmove(json_rpc_buffer, newline + 1, json_rpc_used);
    return *line ? STRATUM_READ_LINE : STRATUM_READ_ERROR;
}

char *STRATUM_V1_receive_jsonrpc_line(esp_transport_handle_t transport)
{
    char *line;
    while (true) {
        switch (STRATUM_V1_read_step(transport, TRANSPORT_TIMEOUT_MS, &line)) {
            case STRATUM_READ_ERROR: return NULL;
            case STRATUM_READ_LINE: return line;
            default: break;
        }
    }
}

static char *stratum_error_reason(const cJSON *error, const cJSON *reject_reason)
{
    const cJSON *text = NULL;
    if (cJSON_IsArray(error)) text = cJSON_GetArrayItem(error, 1);
    else if (cJSON_IsObject(error)) text = cJSON_GetObjectItem(error, "message");
    else if (cJSON_IsString(error)) text = error;
    if (!cJSON_IsString(text) || !text->valuestring[0]) text = reject_reason;
    const char *reason = cJSON_IsString(text) && text->valuestring[0] ? text->valuestring : "unknown";
    return strdup(reason);
}

// Pool messages are untrusted: every field is type-checked before use.
static const char *string_at(const cJSON *array, int index)
{
    const cJSON *item = cJSON_GetArrayItem(array, index);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static bool integer_at(const cJSON *array, int index, int *value)
{
    const cJSON *item = cJSON_GetArrayItem(array, index);
    if (!cJSON_IsNumber(item) || item->valuedouble != (double)item->valueint) return false;
    *value = item->valueint;
    return true;
}

static bool is_hex(const char *text, size_t min_digits, size_t max_digits)
{
    if (!text) return false;
    size_t digits = strlen(text);
    if (digits < min_digits || digits > max_digits) return false;
    for (size_t i = 0; i < digits; i++) {
        if (!isxdigit((unsigned char)text[i])) return false;
    }
    return true;
}

static bool hex_u32_at(const cJSON *array, int index, uint32_t *value)
{
    const char *text = string_at(array, index);
    if (!is_hex(text, 1, 8)) return false;
    *value = strtoul(text, NULL, 16);
    return true;
}

static mining_notify *parse_mining_notify(const cJSON *params)
{
    if (!cJSON_IsArray(params) || cJSON_GetArraySize(params) < 8) {
        ESP_LOGE(TAG, "Invalid params in mining.notify");
        return NULL;
    }
    const char *job_id = string_at(params, 0), *prev_hash = string_at(params, 1);
    const char *coinbase_1 = string_at(params, 2), *coinbase_2 = string_at(params, 3);
    const cJSON *merkle_branch = cJSON_GetArrayItem(params, 4);
    mining_notify *work = calloc(1, sizeof(mining_notify));
    if (!work) return NULL;

    if (!job_id || !is_hex(prev_hash, 64, 64) || !coinbase_1 || !coinbase_2 ||
        !hex_u32_at(params, 5, &work->version) || !hex_u32_at(params, 6, &work->target) ||
        !hex_u32_at(params, 7, &work->ntime) || !cJSON_IsArray(merkle_branch)) {
        ESP_LOGE(TAG, "Invalid field in mining.notify");
        goto fail;
    }
    int branches = cJSON_GetArraySize(merkle_branch);
    if (branches > MAX_MERKLE_BRANCHES) {
        ESP_LOGE(TAG, "Too many Merkle branches: %d", branches);
        goto fail;
    }
    work->n_merkle_branches = branches;
    work->job_id = strdup(job_id);
    work->prev_block_hash = strdup(prev_hash);
    work->coinbase_1 = strdup(coinbase_1);
    work->coinbase_2 = strdup(coinbase_2);
    work->merkle_branches = malloc(HASH_SIZE * (branches ? branches : 1));
    if (!work->job_id || !work->prev_block_hash || !work->coinbase_1 || !work->coinbase_2 ||
        !work->merkle_branches) {
        ESP_LOGE(TAG, "Out of memory parsing mining.notify");
        goto fail;
    }
    for (int i = 0; i < branches; i++) {
        const char *branch = string_at(merkle_branch, i);
        if (!is_hex(branch, 2 * HASH_SIZE, 2 * HASH_SIZE)) {
            ESP_LOGE(TAG, "Invalid Merkle branch %d in mining.notify", i);
            goto fail;
        }
        hex2bin(branch, work->merkle_branches + HASH_SIZE * i, HASH_SIZE);
    }
    // params can be variable length; clean_jobs is the last item.
    work->clean_jobs = cJSON_IsTrue(cJSON_GetArrayItem(params, cJSON_GetArraySize(params) - 1));
    return work;

fail:
    STRATUM_V1_free_mining_notify(work);
    return NULL;
}

// Shares are tested against an integer target. Rounding a fractional pool
// difficulty up never submits a share the pool considers too weak.
static bool difficulty_at(const cJSON *params, uint32_t *difficulty)
{
    const cJSON *item = cJSON_GetArrayItem(params, 0);
    if (!cJSON_IsArray(params) || !cJSON_IsNumber(item) || !isfinite(item->valuedouble) ||
        item->valuedouble <= 0) return false;
    double value = item->valuedouble;
    *difficulty = value >= (double)UINT32_MAX ? UINT32_MAX : (uint32_t)ceil(value);
    if ((double)*difficulty != value) {
        ESP_LOGW(TAG, "Pool difficulty %g rounded up to %" PRIu32, value, *difficulty);
    }
    return true;
}

void STRATUM_V1_parse(StratumApiV1Message * message, const char * stratum_json)
{
    message->mining_notification = NULL;
    message->response_success = false;
    // The Stratum task takes ownership of every extranonce string it receives.
    message->extranonce_str = NULL;
    free(message->error_str);
    message->error_str = NULL;
    message->method = STRATUM_UNKNOWN;
    message->message_id = -1;

    cJSON * json = cJSON_Parse(stratum_json);
    if (!cJSON_IsObject(json)) {
        cJSON_Delete(json);
        return;
    }

    cJSON * id_json = cJSON_GetObjectItem(json, "id");
    int parsed_id = -1;
    if (id_json != NULL && cJSON_IsNumber(id_json)) {
        parsed_id = id_json->valueint;
    }
    message->message_id = parsed_id;

    cJSON * method_json = cJSON_GetObjectItem(json, "method");
    // A full job can occupy the serial log sink for tens of milliseconds.
    // Invalidate the old epoch before the Stratum task logs the new job.
    if (!cJSON_IsString(method_json) || strcmp(method_json->valuestring, "mining.notify") != 0) {
        ESP_LOGI(TAG, "rx: %s", stratum_json);
    }
    stratum_method result = STRATUM_UNKNOWN;

    //if there is a method, then use that to decide what to do
    if (method_json != NULL && cJSON_IsString(method_json)) {
        if (strcmp("mining.notify", method_json->valuestring) == 0) {
            result = MINING_NOTIFY;
        } else if (strcmp("mining.set_difficulty", method_json->valuestring) == 0) {
            result = MINING_SET_DIFFICULTY;
        } else if (strcmp("mining.set_version_mask", method_json->valuestring) == 0) {
            result = MINING_SET_VERSION_MASK;
        } else if (strcmp("mining.set_extranonce", method_json->valuestring) == 0) {
            result = MINING_SET_EXTRANONCE;
        } else if (strcmp("client.reconnect", method_json->valuestring) == 0) {
            result = CLIENT_RECONNECT;
        } else if (strcmp("mining.ping", method_json->valuestring) == 0) {
            result = MINING_PING;
        } else {
            ESP_LOGI(TAG, "unhandled method in stratum message: %s", stratum_json);
        }

    //if there is no method, then it is a result
    } else {
        // parse results
        cJSON * result_json = cJSON_GetObjectItem(json, "result");
        cJSON * error_json = cJSON_GetObjectItem(json, "error");
        cJSON * reject_reason_json = cJSON_GetObjectItem(json, "reject-reason");

        // A rejected response may omit result, return null, or use either
        // Stratum's error array or a JSON-RPC error object.
        if (result_json == NULL || cJSON_IsNull(result_json) ||
            (error_json != NULL && !cJSON_IsNull(error_json))) {
            message->response_success = false;
            if (parsed_id >= 0) result = parsed_id < STRATUM_FIRST_SHARE_ID ? STRATUM_RESULT_SETUP : STRATUM_RESULT;
            message->error_str = stratum_error_reason(error_json, reject_reason_json);

        // if the result is a boolean, then parse it
        } else if (cJSON_IsBool(result_json)) {
            if (parsed_id >= 0) result = parsed_id < STRATUM_FIRST_SHARE_ID ? STRATUM_RESULT_SETUP : STRATUM_RESULT;
            if (cJSON_IsTrue(result_json)) {
                message->response_success = true;
            } else {
                message->response_success = false;
                message->error_str = stratum_error_reason(error_json, reject_reason_json);
            }
        
        //if the id is STRATUM_ID_SUBSCRIBE parse it
        } else if (parsed_id == STRATUM_ID_SUBSCRIBE) {
            // The size is passed on unchanged: the Stratum task rejects an
            // unsupported one, since a shortened extranonce2 makes invalid shares.
            int extranonce_2_len;
            const char *extranonce = cJSON_IsArray(result_json) ? string_at(result_json, 1) : NULL;
            if (!extranonce || !integer_at(result_json, 2, &extranonce_2_len)) {
                ESP_LOGE(TAG, "Unable to parse subscribe result: %s", stratum_json);
                goto done;
            }
            message->extranonce_str = strdup(extranonce);
            if (!message->extranonce_str) goto done;
            message->extranonce_2_len = extranonce_2_len;
            message->response_success = true;
            result = STRATUM_RESULT_SUBSCRIBE;
        //if the id is STRATUM_ID_CONFIGURE parse it
        } else if (parsed_id == STRATUM_ID_CONFIGURE) {
            cJSON * mask = cJSON_IsObject(result_json) ? cJSON_GetObjectItem(result_json, "version-rolling.mask") : NULL;
            if (cJSON_IsString(mask) && is_hex(mask->valuestring, 1, 8)) {
                result = STRATUM_RESULT_VERSION_MASK;
                message->version_mask = strtoul(mask->valuestring, NULL, 16);
            } else {
                ESP_LOGI(TAG, "error setting version mask: %s", stratum_json);
            }

        } else {
            ESP_LOGI(TAG, "unhandled result in stratum message: %s", stratum_json);
        }
    }

    cJSON * params = cJSON_GetObjectItem(json, "params");
    if (result == MINING_NOTIFY) {
        message->mining_notification = parse_mining_notify(params);
        if (!message->mining_notification) result = STRATUM_UNKNOWN;
    } else if (result == MINING_SET_DIFFICULTY) {
        if (!difficulty_at(params, &message->new_difficulty)) {
            ESP_LOGE(TAG, "Invalid mining.set_difficulty: %s", stratum_json);
            result = STRATUM_UNKNOWN;
        }
    } else if (result == MINING_SET_VERSION_MASK) {
        if (!cJSON_IsArray(params) || !hex_u32_at(params, 0, &message->version_mask)) {
            ESP_LOGE(TAG, "Invalid mining.set_version_mask: %s", stratum_json);
            result = STRATUM_UNKNOWN;
        }
    } else if (result == MINING_SET_EXTRANONCE) {
        const char *extranonce = cJSON_IsArray(params) ? string_at(params, 0) : NULL;
        int extranonce_2_len;
        if (!extranonce || !integer_at(params, 1, &extranonce_2_len)) {
            ESP_LOGE(TAG, "Invalid mining.set_extranonce: %s", stratum_json);
            result = STRATUM_UNKNOWN;
        } else if (!(message->extranonce_str = strdup(extranonce))) {
            result = STRATUM_UNKNOWN;
        } else {
            message->extranonce_2_len = extranonce_2_len;
        }
    }
    message->method = result;
    done:
    cJSON_Delete(json);
}

void STRATUM_V1_free_mining_notify(mining_notify * params)
{
    free(params->work_extranonce1);
    free(params->work_template);
    free(params->job_id);
    free(params->prev_block_hash);
    free(params->coinbase_1);
    free(params->coinbase_2);
    free(params->merkle_branches);
    free(params);
}

static void stamp_tx(int request_id)
{
    if (request_id < STRATUM_FIRST_SHARE_ID) return;
    pthread_mutex_lock(&request_timing_lock);
    request_timings[request_id % MAX_REQUEST_IDS] = (RequestTiming){esp_timer_get_time(), request_id};
    pthread_mutex_unlock(&request_timing_lock);
}

// Length of text once escaped as JSON string contents, without quotes.
static size_t json_escaped_length(const char *text)
{
    size_t length = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        length += (*p == '"' || *p == '\\') ? 2 : (*p < 0x20 ? 6 : 1);
    }
    return length;
}

static bool append_format(char *out, size_t capacity, size_t *used, const char *format, ...)
{
    if (*used >= capacity) return false;
    va_list args;
    va_start(args, format);
    int written = vsnprintf(out + *used, capacity - *used, format, args);
    va_end(args);
    if (written < 0 || (size_t)written >= capacity - *used) return false;
    *used += written;
    return true;
}

// Appends text as a quoted JSON string; user names, passwords and pool job IDs
// may contain quotes, backslashes or control characters.
static bool append_json_string(char *out, size_t capacity, size_t *used, const char *text)
{
    if (!text) text = "";
    if (*used >= capacity || json_escaped_length(text) + 2 >= capacity - *used) return false;
    char *write = out + *used;
    *write++ = '"';
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') {
            *write++ = '\\';
            *write++ = (char)*p;
        } else if (*p < 0x20) {
            write += snprintf(write, 7, "\\u%04x", *p);
        } else {
            *write++ = (char)*p;
        }
    }
    *write++ = '"';
    *write = '\0';
    *used = write - out;
    return true;
}

static void debug_stratum_tx(const char * msg)
{
    const char *newline = strchr(msg, '\n');
    if (newline) {
        ESP_LOGI(TAG, "tx: %.*s", (int)(newline - msg), msg);
    } else {
        ESP_LOGI(TAG, "tx: %s", msg);
    }
}

int STRATUM_V1_subscribe(esp_transport_handle_t transport, int send_uid, const char * model)
{
    // Subscribe
    char subscribe_msg[BUFFER_SIZE];
    const esp_app_desc_t *app_desc = esp_app_get_description();
    const char *version = app_desc->version;	
    snprintf(subscribe_msg, sizeof(subscribe_msg),
        "{\"id\":%d,\"method\":\"mining.subscribe\",\"params\":[\"bitaxe/%s/%s\"]}\n",
        send_uid, model, version);
    debug_stratum_tx(subscribe_msg);

    return write_all(transport, subscribe_msg, strlen(subscribe_msg), TRANSPORT_TIMEOUT_MS);
}

int STRATUM_V1_suggest_difficulty(esp_transport_handle_t transport, int send_uid, uint32_t difficulty)
{
    char difficulty_msg[BUFFER_SIZE];
    snprintf(difficulty_msg, sizeof(difficulty_msg),
        "{\"id\":%d,\"method\":\"mining.suggest_difficulty\",\"params\":[%" PRIu32 "]}\n",
        send_uid, difficulty);
    debug_stratum_tx(difficulty_msg);

    return write_all(transport, difficulty_msg, strlen(difficulty_msg), TRANSPORT_TIMEOUT_MS);
}

int STRATUM_V1_extranonce_subscribe(esp_transport_handle_t transport, int send_uid)
{
    char extranonce_msg[BUFFER_SIZE];
    snprintf(extranonce_msg, sizeof(extranonce_msg),
        "{\"id\":%d,\"method\":\"mining.extranonce.subscribe\",\"params\":[]}\n",
        send_uid);
    debug_stratum_tx(extranonce_msg);

    return write_all(transport, extranonce_msg, strlen(extranonce_msg), TRANSPORT_TIMEOUT_MS);
}

int STRATUM_V1_authorize(esp_transport_handle_t transport, int send_uid, const char * username, const char * pass)
{
    if (!username) username = "";
    if (!pass) pass = "";
    // Credentials may be up to 4 kB each, so size the message exactly.
    size_t capacity = 96 + json_escaped_length(username) + json_escaped_length(pass);
    char *authorize_msg = malloc(capacity);
    if (!authorize_msg) return -1;
    size_t length = 0;
    int ret = -1;
    if (append_format(authorize_msg, capacity, &length, "{\"id\":%d,\"method\":\"mining.authorize\",\"params\":[", send_uid) &&
        append_json_string(authorize_msg, capacity, &length, username) &&
        append_format(authorize_msg, capacity, &length, ",") &&
        append_json_string(authorize_msg, capacity, &length, pass) &&
        append_format(authorize_msg, capacity, &length, "]}\n")) {
        debug_stratum_tx(authorize_msg);
        ret = write_all(transport, authorize_msg, length, TRANSPORT_TIMEOUT_MS);
    }
    free(authorize_msg);
    return ret;
}

int STRATUM_V1_pong(esp_transport_handle_t transport, int message_id)
{
    char pong_msg[BUFFER_SIZE];
    snprintf(pong_msg, sizeof(pong_msg),
        "{\"id\":%d,\"method\":\"pong\",\"params\":[]}\n",
        message_id);
    debug_stratum_tx(pong_msg);
    
    return write_all(transport, pong_msg, strlen(pong_msg), TRANSPORT_TIMEOUT_MS);
}

/// @param transport Transport to write to
/// @param send_uid Message ID
/// @param username The client’s user name.
/// @param job_id The job ID for the work being submitted.
/// @param extranonce_2 The hex-encoded value of extra nonce 2.
/// @param ntime The hex-encoded time value use in the block header.
/// @param nonce The hex-encoded nonce value to use in the block header.
/// @param version_bits The hex-encoded version bits set by miner (BIP310).
int STRATUM_V1_submit_share(esp_transport_handle_t transport, int send_uid, const char * username, const char * job_id,
                            const char * extranonce_2, const uint32_t ntime,
                            const uint32_t nonce, const uint32_t version_bits)
{
    char submit_msg[BUFFER_SIZE];
    size_t used = 0;
    if (!append_format(submit_msg, sizeof(submit_msg), &used, "{\"id\":%d,\"method\":\"mining.submit\",\"params\":[", send_uid) ||
        !append_json_string(submit_msg, sizeof(submit_msg), &used, username) ||
        !append_format(submit_msg, sizeof(submit_msg), &used, ",") ||
        !append_json_string(submit_msg, sizeof(submit_msg), &used, job_id) ||
        !append_format(submit_msg, sizeof(submit_msg), &used, ",") ||
        !append_json_string(submit_msg, sizeof(submit_msg), &used, extranonce_2) ||
        !append_format(submit_msg, sizeof(submit_msg), &used, ",\"%08" PRIx32 "\",\"%08" PRIx32 "\",\"%08" PRIx32 "\"]}\n",
                       ntime, nonce, version_bits)) {
        return -1;
    }
    const int length = (int)used;
    stamp_tx(send_uid);
    int ret = write_all(transport, submit_msg, length, SHARE_WRITE_TIMEOUT_MS);
    if (ret == length) return ret;
    STRATUM_V1_get_response_time_ms(send_uid, esp_timer_get_time());
    return -1; // Not sent completely in time: the caller reconnects.
}

int STRATUM_V1_configure_version_rolling(esp_transport_handle_t transport, int send_uid, uint32_t * version_mask)
{
    char configure_msg[BUFFER_SIZE];
    snprintf(configure_msg, sizeof(configure_msg),
        "{\"id\":%d,\"method\":\"mining.configure\",\"params\":[[\"version-rolling\"],{\"version-rolling.mask\":\"ffffffff\"}]}\n",
        send_uid);
    debug_stratum_tx(configure_msg);

    return write_all(transport, configure_msg, strlen(configure_msg), TRANSPORT_TIMEOUT_MS);
}
