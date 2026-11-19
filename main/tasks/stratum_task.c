#include "miner_diagnostics.h"
#include "esp_log.h"
#include "system.h"
#include "global_state.h"
#include <lwip/tcpip.h>
#include <lwip/netdb.h>
#include "stratum_task.h"
#include "work_queue.h"
#include "esp_wifi.h"
#include <esp_sntp.h>
#include "esp_timer.h"
#include <sys/time.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <pthread.h>
#include "mining.h"
#include "utils.h"
#include "coinbase_decoder.h"
#include <esp_heap_caps.h>
#include "asic.h"
#if CONFIG_BM1370_FIXED_JOBS
#include "bm1370_jobs.h"
#endif

#define MAX_RETRY_ATTEMPTS 3
#define MAX_CRITICAL_RETRY_ATTEMPTS 5
#define MAX_EXTRANONCE_2_LEN 32

#define PORT CONFIG_STRATUM_PORT
#define STRATUM_URL CONFIG_STRATUM_URL
#define STRATUM_TLS CONFIG_STRATUM_TLS
#define STRATUM_CERT CONFIG_STRATUM_CERT

#define FALLBACK_PORT CONFIG_FALLBACK_STRATUM_PORT
#define FALLBACK_STRATUM_URL CONFIG_FALLBACK_STRATUM_URL
#define FALLBACK_STRATUM_TLS CONFIG_FALLBACK_STRATUM_TLS
#define FALLBACK_STRATUM_CERT CONFIG_FALLBACK_STRATUM_CERT

#define STRATUM_PW CONFIG_STRATUM_PW
#define FALLBACK_STRATUM_PW CONFIG_FALLBACK_STRATUM_PW
#define STRATUM_DIFFICULTY CONFIG_STRATUM_DIFFICULTY

#define TRANSPORT_TIMEOUT_MS 5000

#define BUFFER_SIZE 1024

static const char * TAG = "stratum_task";

static StratumApiV1Message stratum_api_v1_message = {};

// Snapshot for AxeOS. The HTTP reader copies it before doing any allocation.
static zpool_job_header_t zpool_job_header;
static pthread_mutex_t zpool_job_header_lock = PTHREAD_MUTEX_INITIALIZER;

bool stratum_get_zpool_job_header(zpool_job_header_t *header)
{
    pthread_mutex_lock(&zpool_job_header_lock);
    *header = zpool_job_header;
    pthread_mutex_unlock(&zpool_job_header_lock);
    return header->previous_block_hash[0] != '\0';
}

static void clear_zpool_job_header(void)
{
    pthread_mutex_lock(&zpool_job_header_lock);
    zpool_job_header.previous_block_hash[0] = '\0';
    pthread_mutex_unlock(&zpool_job_header_lock);
}

static void publish_zpool_job_header(const mining_notify *job, const char *extra1, int extra2_len,
                                    double difficulty)
{
    zpool_job_header_t header = {
        .version = job->version, .bits = job->target, .timestamp = job->ntime, .difficulty = difficulty,
    };
    if (!mining_prevhash_to_display(job->prev_block_hash, header.previous_block_hash)) {
        clear_zpool_job_header();
        return;
    }
    if (job->job_id) snprintf(header.job_id, sizeof(header.job_id), "%s", job->job_id);
    size_t extra1_digits = extra1 ? strlen(extra1) : 0;
    if (extra1 && extra1_digits % 2 == 0 && extra1_digits <= 64 &&
        extra2_len >= 0 && extra2_len <= MAX_EXTRANONCE_2_LEN) {
        header.height = coinbase_extract_height(job->coinbase_1, extra1_digits / 2 + extra2_len);
        // Some older coinbase scripts start with the compact difficulty rather than a height.
        if (header.height == header.bits) header.height = 0;
    }

    pthread_mutex_lock(&zpool_job_header_lock);
    zpool_job_header = header;
    pthread_mutex_unlock(&zpool_job_header_lock);
}

static const char * primary_stratum_url;
static uint16_t primary_stratum_port;

struct timeval tcp_snd_timeout = {
    .tv_sec = 5,
    .tv_usec = 0
};

struct timeval tcp_rcv_timeout = {
    .tv_sec = 60 * 3,
    .tv_usec = 0
};

static uint16_t primary_stratum_tls;
static char * primary_stratum_cert;

typedef struct {
    struct sockaddr_storage dest_addr;  // Stores IPv4 or IPv6 address with scope_id for IPv6
    socklen_t addrlen;
    int addr_family;
    int ip_protocol;
    char host_ip[INET6_ADDRSTRLEN + 16];  // IPv6 address + zone identifier (e.g., "fe80::1%wlan0")
} stratum_connection_info_t;

static esp_err_t resolve_stratum_address(const char *hostname, uint16_t port, stratum_connection_info_t *conn_info)
{
    // Input validation
    if (hostname == NULL || conn_info == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (port == 0) {
        ESP_LOGE(TAG, "Invalid port: 0");
        return ESP_ERR_INVALID_ARG;
    }

    char port_str[6];
    snprintf(port_str, sizeof(port_str), "%u", port);

    ESP_LOGD(TAG, "Resolving address for %s:%u", hostname, port);

    struct addrinfo hints = {
        .ai_family   = AF_UNSPEC,
        .ai_socktype = SOCK_STREAM,
        .ai_protocol = IPPROTO_TCP,
        .ai_flags    = AI_NUMERICSERV
    };

    struct addrinfo *res = NULL;
    int gai_err = esp_getaddrinfo(hostname, port_str, &hints, &res);
    if (gai_err != 0 || res == NULL) {
        ESP_LOGE(TAG, "DNS resolution failed for %s:%u (error: %d)", hostname, port, gai_err);
        return ESP_ERR_NOT_FOUND;
    }

    // Initialize connection info
    memset(conn_info, 0, sizeof(*conn_info));
    conn_info->addr_family = AF_UNSPEC;

    // Preferred order: IPv4 first, then IPv6
    const int preferred_families[] = { AF_INET, AF_INET6 };
    const size_t num_families = sizeof(preferred_families) / sizeof(preferred_families[0]);

    const struct addrinfo *selected = NULL;

    for (size_t i = 0; i < num_families && selected == NULL; i++) {
        int family = preferred_families[i];

        for (const struct addrinfo *p = res; p != NULL; p = p->ai_next) {
            if (p->ai_family == family) {
                selected = p;
                break;
            }
        }
    }

    if (selected == NULL) {
        ESP_LOGE(TAG, "No supported address family (IPv4 or IPv6) found for %s", hostname);
        freeaddrinfo(res);
        return ESP_ERR_NOT_SUPPORTED;
    }

    // Copy selected address
    memcpy(&conn_info->dest_addr, selected->ai_addr, selected->ai_addrlen);
    conn_info->addrlen     = selected->ai_addrlen;
    conn_info->addr_family = selected->ai_family;
    conn_info->ip_protocol = (selected->ai_family == AF_INET) ? IPPROTO_IP : IPPROTO_IPV6;

    // Handle IPv6 link-local scope ID if needed
    if (selected->ai_family == AF_INET6) {
        struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *)&conn_info->dest_addr;

        if (IN6_IS_ADDR_LINKLOCAL(&addr6->sin6_addr)) {
            if (addr6->sin6_scope_id == 0) {
                ESP_LOGW(TAG, "Link-local IPv6 address without scope ID - attempting to set from WiFi STA interface");

                esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
                if (netif) {
                    int index = esp_netif_get_netif_impl_index(netif);
                    if (index >= 0) {
                        addr6->sin6_scope_id = (uint32_t)index;
                        ESP_LOGI(TAG, "Set IPv6 scope_id to interface index: %lu", (unsigned long)addr6->sin6_scope_id);
                    } else {
                        ESP_LOGW(TAG, "Failed to get valid interface index for WIFI_STA_DEF");
                    }
                } else {
                    ESP_LOGW(TAG, "Could not get netif handle for WIFI_STA_DEF");
                }
            } else {
                ESP_LOGI(TAG, "Link-local IPv6 address with existing scope_id: %lu", (unsigned long)addr6->sin6_scope_id);
            }
        }
    }

    // Convert resolved address to string for logging and storage
    const void *src_addr;
    int af = conn_info->addr_family;

    if (af == AF_INET) {
        struct sockaddr_in *addr4 = (struct sockaddr_in *)&conn_info->dest_addr;
        src_addr = &addr4->sin_addr;
    } else {
        struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *)&conn_info->dest_addr;
        src_addr = &addr6->sin6_addr;
    }

    if (inet_ntop(af, src_addr, conn_info->host_ip, sizeof(conn_info->host_ip)) == NULL) {
        ESP_LOGW(TAG, "inet_ntop failed (errno: %d)", errno);
        snprintf(conn_info->host_ip, sizeof(conn_info->host_ip), "[invalid %s addr]",
                 (af == AF_INET) ? "IPv4" : "IPv6");
    } else if (af == AF_INET6) {
        struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *)&conn_info->dest_addr;
        if (IN6_IS_ADDR_LINKLOCAL(&addr6->sin6_addr) && addr6->sin6_scope_id != 0) {
            char zone[16];
            snprintf(zone, sizeof(zone), "%%%lu", (unsigned long)addr6->sin6_scope_id);
            strncat(conn_info->host_ip, zone,
                    sizeof(conn_info->host_ip) - strlen(conn_info->host_ip) - 1);
            // Ensure null termination
            conn_info->host_ip[sizeof(conn_info->host_ip) - 1] = '\0';
        }
    }

    ESP_LOGI(TAG, "Resolved %s:%u → %s", hostname, port, conn_info->host_ip);

    freeaddrinfo(res);
    return ESP_OK;
}

static void set_socket_options(esp_transport_handle_t transport)
{
    int sock = esp_transport_get_socket(transport);
    if (sock >= 0) {
        // Set send and receive timeouts
        if (setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tcp_snd_timeout, sizeof(tcp_snd_timeout)) < 0) {
            ESP_LOGE(TAG, "Failed to set SO_SNDTIMEO");
        }
        if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tcp_rcv_timeout, sizeof(tcp_rcv_timeout)) < 0) {
            ESP_LOGE(TAG, "Failed to set SO_RCVTIMEO");
        }

        // Disable Nagle: a share submit leaves at once instead of waiting for the
        // ACK of the previous segment (pool delayed-ACK adds latency per share).
        int nodelay = 1;
        if (setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay)) < 0) {
            ESP_LOGE(TAG, "Failed to set TCP_NODELAY");
        }

        // Enable keepalive
        int keepalive = 1;
        if (setsockopt(sock, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive)) < 0) {
            ESP_LOGE(TAG, "Failed to set SO_KEEPALIVE");
        }

        // Set keepalive parameters (adjust values as needed)
        int keepidle = 60;  // TCP_KEEPIDLE: seconds before sending keepalive
        int keepintvl = 10; // TCP_KEEPINTVL: seconds between keepalive probes
        int keepcnt = 3;    // TCP_KEEPCNT: number of keepalive probes
        if (setsockopt(sock, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle)) < 0) {
            ESP_LOGE(TAG, "Failed to set TCP_KEEPIDLE");
        }
        if (setsockopt(sock, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl)) < 0) {
            ESP_LOGE(TAG, "Failed to set TCP_KEEPINTVL");
        }
        if (setsockopt(sock, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt)) < 0) {
            ESP_LOGE(TAG, "Failed to set TCP_KEEPCNT");
        }
    } else {
        ESP_LOGE(TAG, "Failed to get socket from transport");
    }
}

bool is_wifi_connected() {
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        return true;
    } else {
        return false;
    }
}

static void clean_queue_locked(GlobalState * GLOBAL_STATE, const char *reason) {
#if CONFIG_BM1370_FIXED_JOBS
    if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
        bm1370_jobs_clear_locked(reason);
        queue_clear(&GLOBAL_STATE->stratum_queue);
        clear_zpool_job_header();
        return;
    }
#endif
    (void)reason;
    queue_clear(&GLOBAL_STATE->stratum_queue);

    pthread_mutex_lock(&GLOBAL_STATE->valid_jobs_lock);
    for (int i = 0; i < 128; i = i + 4) {
        if (GLOBAL_STATE->valid_jobs) GLOBAL_STATE->valid_jobs[i] = 0;
    }
    pthread_mutex_unlock(&GLOBAL_STATE->valid_jobs_lock);
    clear_zpool_job_header();
}

void stratum_reset_uid(GlobalState * GLOBAL_STATE)
{
    ESP_LOGI(TAG, "Resetting stratum uid");
    GLOBAL_STATE->send_uid = STRATUM_FIRST_SHARE_ID;
}

static void close_connection_locked(GlobalState *state)
{
    // With fixed jobs, only the owner task ever closes the socket. Other
    // tasks invalidate the session; the owner observes it on the next pump.
    if (state->transport && !ASIC_uses_fixed_jobs(state)) esp_transport_close(state->transport);
    state->transport = NULL;
    clean_queue_locked(state, "disconnect");
}

void stratum_close_connection(GlobalState *state)
{
#if CONFIG_BM1370_FIXED_JOBS
    if (ASIC_uses_fixed_jobs(state)) {
        bm1370_jobs_lock();
        if (state->transport) close_connection_locked(state);
        bm1370_jobs_unlock();
        return;
    }
#endif
    close_connection_locked(state);
    vTaskDelay(pdMS_TO_TICKS(1000));
}

#if CONFIG_BM1370_FIXED_JOBS
static bool session_current(GlobalState *state, esp_transport_handle_t transport)
{
    bm1370_jobs_lock();
    bool current = state->transport == transport;
    bm1370_jobs_unlock();
    return current;
}

static bool flush_one_share(GlobalState *state, esp_transport_handle_t transport, const char *username)
{
    bm1370_pending_share share;
    bm1370_jobs_lock();
    bool ready = state->transport == transport && bm1370_jobs_take_share_locked(&share);
    bm1370_jobs_unlock();
    if (!ready) return true;

    const int id = state->send_uid++;
    const int64_t sent = esp_timer_get_time();
    // This socket belongs to this loop until teardown, so it can never
    // become the next session's socket between the epoch check and the write.
    if (STRATUM_V1_submit_share(transport, id, username, share.id, share.extra,
                                 share.ntime, share.nonce, share.version_bits) < 0) return false;
    ESP_LOGI("asic_result", "Share id=%d job=%.32s sent_ms=%lld", id, share.id, (long long)(sent / 1000));
    return true;
}
#endif

#if CONFIG_BM1370_JOBSTORE_TEST
static void jobstore_reconnect_test(void *context)
{
    for (int i = 1; i <= 2; i++) {
        vTaskDelay(pdMS_TO_TICKS(120000));
        ESP_LOGI("job_store", "test reconnect=%d", i);
        stratum_close_connection(context);
    }
    vTaskDelete(NULL);
}
#endif

#define HEARTBEAT_WAIT_MS 10000
#define HEARTBEAT_MAX_LINE (64 * 1024)

// The subscribe result also names "mining.notify", so a substring match would
// succeed before the pool has authorized the worker or sent any job.
static bool line_is_mining_notify(const char *line)
{
    cJSON *json = cJSON_Parse(line);
    const cJSON *method = cJSON_GetObjectItem(json, "method");
    const bool notify = cJSON_IsString(method) && strcmp(method->valuestring, "mining.notify") == 0;
    cJSON_Delete(json);
    return notify;
}

// Reads complete lines until the primary pool sends a job, fails, or the wait
// expires. Replies and jobs often arrive in separate TCP segments.
static bool heartbeat_receives_job(esp_transport_handle_t transport)
{
    char *buffer = malloc(HEARTBEAT_MAX_LINE + 1);
    if (!buffer) return false;
    size_t used = 0;
    bool found = false;
    const int64_t deadline_us = esp_timer_get_time() + (int64_t)HEARTBEAT_WAIT_MS * 1000;
    while (!found && used < HEARTBEAT_MAX_LINE) {
        const int remaining_ms = (int)((deadline_us - esp_timer_get_time()) / 1000);
        if (remaining_ms <= 0) break;
        const int count = esp_transport_read(transport, buffer + used, HEARTBEAT_MAX_LINE - used, remaining_ms);
        if (count < 0) break;
        used += count;
        buffer[used] = '\0';
        char *start = buffer, *newline;
        while (!found && (newline = memchr(start, '\n', used - (start - buffer)))) {
            *newline = '\0';
            found = line_is_mining_notify(start);
            start = newline + 1;
        }
        used -= start - buffer;
        memmove(buffer, start, used);
    }
    free(buffer);
    return found;
}

void stratum_primary_heartbeat(void * pvParameters)
{
    GlobalState * GLOBAL_STATE = (GlobalState *) pvParameters;

    ESP_LOGI(TAG, "Starting heartbeat thread for primary pool: %s:%d", primary_stratum_url, primary_stratum_port);
    vTaskDelay(10000 / portTICK_PERIOD_MS);

    while (1)
    {
        if (GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback == false) {
            vTaskDelay(10000 / portTICK_PERIOD_MS);
            continue;
        }

        ESP_LOGD(TAG, "Running Heartbeat on: %s!", primary_stratum_url);

        if (!is_wifi_connected()) {
            ESP_LOGD(TAG, "Heartbeat. Failed WiFi check!");
            vTaskDelay(10000 / portTICK_PERIOD_MS);
            continue;
        }

        stratum_connection_info_t conn_info;
        if (resolve_stratum_address(primary_stratum_url, primary_stratum_port, &conn_info) != ESP_OK) {
            ESP_LOGD(TAG, "Heartbeat. Address resolution failed for: %s", primary_stratum_url);
            vTaskDelay(60000 / portTICK_PERIOD_MS);
            continue;
        }
       
        tls_mode tls = GLOBAL_STATE->SYSTEM_MODULE.pool_tls;
        char * cert = GLOBAL_STATE->SYSTEM_MODULE.pool_cert;
        esp_transport_handle_t transport = STRATUM_V1_transport_init(tls, cert);
        if (transport == NULL) {
            ESP_LOGD(TAG, "Heartbeat. Failed transport init check!");
            vTaskDelay(60000 / portTICK_PERIOD_MS);
            continue;
        }

        esp_err_t err = esp_transport_connect(transport, primary_stratum_url, primary_stratum_port, TRANSPORT_TIMEOUT_MS);
        if (err != ESP_OK) {
            ESP_LOGD(TAG, "Heartbeat. Failed connect check: %s:%d (errno %d: %s)", primary_stratum_url, primary_stratum_port, err, strerror(err));
            esp_transport_destroy(transport);
            vTaskDelay(60000 / portTICK_PERIOD_MS);
            continue;
        }

        set_socket_options(transport);

        int send_uid = 1;
        STRATUM_V1_subscribe(transport, send_uid++, GLOBAL_STATE->DEVICE_CONFIG.family.asic.name);
        STRATUM_V1_authorize(transport, send_uid++, GLOBAL_STATE->SYSTEM_MODULE.pool_user, GLOBAL_STATE->SYSTEM_MODULE.pool_pass);

        const bool primary_sends_jobs = heartbeat_receives_job(transport);
        esp_transport_destroy(transport);

        if (primary_sends_jobs && !GLOBAL_STATE->SYSTEM_MODULE.use_fallback_stratum) {
            ESP_LOGI(TAG, "Heartbeat successful and in fallback mode. Switching back to primary.");
#if CONFIG_BM1370_FIXED_JOBS
            if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
                bm1370_jobs_lock();
                GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback = false;
                pool_stats_select(false, "Primary pool reachable again");
                close_connection_locked(GLOBAL_STATE);
                bm1370_jobs_unlock();
            } else
#endif
            {
                GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback = false;
                pool_stats_select(false, "Primary pool reachable again");
                stratum_close_connection(GLOBAL_STATE);
            }
            continue;
        }

        vTaskDelay(60000 / portTICK_PERIOD_MS);
    }
}

static void clear_coinbase_info(GlobalState *state)
{
    state->block_height = 0;
    state->scriptsig[0] = '\0';
    state->coinbase_output_count = 0;
    state->coinbase_value_total_satoshis = 0;
    state->coinbase_value_user_satoshis = 0;
    state->coinbase_network = MINING_NETWORK_AUTO;
}

static void decode_mining_notification(GlobalState * GLOBAL_STATE, const mining_notify *mining_notification,
                                       const char *user, mining_network_t network, bool decode_coinbase,
                                       bool multipool)
{
    // nBits belongs to the block header and remains usable if coinbase parsing fails.
    double network_diff = networkDifficulty(mining_notification->target);
    GLOBAL_STATE->network_nonce_diff = isfinite(network_diff) && network_diff > 0 ? network_diff : 0;
    suffixString(GLOBAL_STATE->network_nonce_diff, GLOBAL_STATE->network_diff_string, DIFF_STRING_SIZE, 0);

    // A zpool payout address selects a payment currency, not the chain being mined.
    // The Stratum job does not identify that chain or its coinbase format.
    if (multipool) {
        clear_coinbase_info(GLOBAL_STATE);
        const bool fixed = ASIC_uses_fixed_jobs(GLOBAL_STATE);
        publish_zpool_job_header(mining_notification,
                                 fixed ? mining_notification->work_extranonce1 : GLOBAL_STATE->extranonce_str,
                                 fixed ? mining_notification->work_extranonce2_len : GLOBAL_STATE->extranonce_2_len,
                                 GLOBAL_STATE->network_nonce_diff);
        return;
    }

    mining_notification_result_t *result = heap_caps_malloc(sizeof(mining_notification_result_t), MALLOC_CAP_SPIRAM);
    if (!result) {
        ESP_LOGE(TAG, "Failed to allocate result in PSRAM");
        return;
    }
    memset(result, 0, sizeof(mining_notification_result_t));

    if (coinbase_process_notification(mining_notification,
                                     GLOBAL_STATE->extranonce_str,
                                     GLOBAL_STATE->extranonce_2_len,
                                     user,
                                     network,
                                     decode_coinbase,
                                     result) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to process mining notification");
        clear_coinbase_info(GLOBAL_STATE);
        free(result);
        return;
    }

    // Update block height
    if (result->block_height != GLOBAL_STATE->block_height) {
        ESP_LOGI(TAG, "Block height %d", result->block_height);
        GLOBAL_STATE->block_height = result->block_height;
    }

    // Update scriptsig
    if (result->scriptsig) {
        if (strcmp(result->scriptsig, GLOBAL_STATE->scriptsig) != 0) {
            ESP_LOGI(TAG, "Scriptsig: %s", result->scriptsig);
            strncpy(GLOBAL_STATE->scriptsig, result->scriptsig, sizeof(GLOBAL_STATE->scriptsig) - 1);
            GLOBAL_STATE->scriptsig[sizeof(GLOBAL_STATE->scriptsig) - 1] = '\0';
        }
        free(result->scriptsig);
    }

    // Update coinbase outputs
    // Safety guard: ensure output_count doesn't exceed array capacity
    if (result->output_count > MAX_COINBASE_TX_OUTPUTS) {
        result->output_count = MAX_COINBASE_TX_OUTPUTS;
    }

    GLOBAL_STATE->coinbase_value_total_satoshis = result->total_value_satoshis;
    GLOBAL_STATE->coinbase_value_user_satoshis = result->user_value_satoshis;
    GLOBAL_STATE->coinbase_network = result->network;
    const char *currency = mining_network_params(result->network)->symbol;
    ESP_LOGI(TAG, "Coinbase outputs: %d, total value: %llu atomic units (%s)", result->output_count,
             result->total_value_satoshis, currency);
    
    if (result->output_count != GLOBAL_STATE->coinbase_output_count ||
        memcmp(result->outputs, GLOBAL_STATE->coinbase_outputs, sizeof(coinbase_output_t) * result->output_count) != 0) {
            
        GLOBAL_STATE->coinbase_output_count = result->output_count;
        memcpy(GLOBAL_STATE->coinbase_outputs, result->outputs, sizeof(coinbase_output_t) * result->output_count);
        for (int i = 0; i < result->output_count; i++) {
            if (result->outputs[i].value_satoshis > 0) {
                if (result->outputs[i].is_user_output) {
                    ESP_LOGI(TAG, "  Output %d: %s (%llu atomic %s units) (Your payout address)", i, result->outputs[i].address, result->outputs[i].value_satoshis, currency);
                } else {
                    ESP_LOGI(TAG, "  Output %d: %s (%llu atomic %s units)", i, result->outputs[i].address, result->outputs[i].value_satoshis, currency);
                }
            } else {
                ESP_LOGI(TAG, "  Output %d: %s", i, result->outputs[i].address);
            }
        }
    }

    free(result);
}

void stratum_task(void * pvParameters)
{
    GlobalState * GLOBAL_STATE = (GlobalState *) pvParameters;

    primary_stratum_url = GLOBAL_STATE->SYSTEM_MODULE.pool_url;
    primary_stratum_port = GLOBAL_STATE->SYSTEM_MODULE.pool_port;
    primary_stratum_tls = GLOBAL_STATE->SYSTEM_MODULE.pool_tls;
    primary_stratum_cert = GLOBAL_STATE->SYSTEM_MODULE.pool_cert;
    char * stratum_url = GLOBAL_STATE->SYSTEM_MODULE.pool_url;
    uint16_t port = GLOBAL_STATE->SYSTEM_MODULE.pool_port;
    bool extranonce_subscribe = GLOBAL_STATE->SYSTEM_MODULE.pool_extranonce_subscribe;
    uint16_t difficulty = GLOBAL_STATE->SYSTEM_MODULE.pool_difficulty;
    tls_mode tls = GLOBAL_STATE->SYSTEM_MODULE.pool_tls;
    char * cert = GLOBAL_STATE->SYSTEM_MODULE.pool_cert;

    STRATUM_V1_initialize_buffer();
#if CONFIG_BM1370_JOBSTORE_TEST
    if (ASIC_uses_fixed_jobs(GLOBAL_STATE))
        xTaskCreate(jobstore_reconnect_test, "jobstore test", 4096, GLOBAL_STATE, 1, NULL);
#endif
    pool_stats_select(GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback, "Startup preference");
    int retry_attempts = 0;
    int retry_critical_attempts = 0;

    xTaskCreateWithCaps(stratum_primary_heartbeat, "stratum primary heartbeat", 8192, pvParameters, 1, NULL, MALLOC_CAP_SPIRAM);

    ESP_LOGI(TAG, "Opening connection to pool: %s:%d", stratum_url, port);
    while (1) {
        if (!is_wifi_connected()) {
            ESP_LOGI(TAG, "WiFi disconnected, attempting to reconnect...");
            vTaskDelay(10000 / portTICK_PERIOD_MS);
            continue;
        }

        if (retry_attempts >= MAX_RETRY_ATTEMPTS)
        {
            if (GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_url == NULL || GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_url[0] == '\0') {
                ESP_LOGI(TAG, "Unable to switch to fallback. No url configured. (retries: %d)...", retry_attempts);
                GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback = false;
                pool_stats_select(false, "Fallback pool is unconfigured");
                retry_attempts = 0;
                continue;
            }

            GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback = !GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback;
            pool_stats_select(GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback, "Connection retry limit reached");
            
            // Reset share stats at failover
            for (int i = 0; i < GLOBAL_STATE->SYSTEM_MODULE.rejected_reason_stats_count; i++) {
                GLOBAL_STATE->SYSTEM_MODULE.rejected_reason_stats[i].count = 0;
                GLOBAL_STATE->SYSTEM_MODULE.rejected_reason_stats[i].message[0] = '\0';
            }
            GLOBAL_STATE->SYSTEM_MODULE.rejected_reason_stats_count = 0;
            GLOBAL_STATE->SYSTEM_MODULE.shares_accepted = 0;
            GLOBAL_STATE->SYSTEM_MODULE.shares_rejected = 0;
            GLOBAL_STATE->SYSTEM_MODULE.work_received = 0;

            ESP_LOGI(TAG, "Switching target due to too many failures (retries: %d)...", retry_attempts);
            retry_attempts = 0;
        }

        const bool session_fallback = GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback;
        stratum_url = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_url : GLOBAL_STATE->SYSTEM_MODULE.pool_url;
        port = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_port : GLOBAL_STATE->SYSTEM_MODULE.pool_port;
        extranonce_subscribe = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_extranonce_subscribe : GLOBAL_STATE->SYSTEM_MODULE.pool_extranonce_subscribe;
        difficulty = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_difficulty : GLOBAL_STATE->SYSTEM_MODULE.pool_difficulty;

        stratum_connection_info_t conn_info;
        if (resolve_stratum_address(stratum_url, port, &conn_info) != ESP_OK) {
            ESP_LOGE(TAG, "Address resolution failed for %s", stratum_url);
            retry_attempts++;
            vTaskDelay(1000 / portTICK_PERIOD_MS);
            continue;
        }

        ESP_LOGI(TAG, "Connecting to: stratum+tcp://%s:%d (%s)", stratum_url, port, conn_info.host_ip);

        tls = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_tls : GLOBAL_STATE->SYSTEM_MODULE.pool_tls;
        cert = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_cert : GLOBAL_STATE->SYSTEM_MODULE.pool_cert;
        retry_critical_attempts = 0;

        esp_transport_handle_t session_transport = STRATUM_V1_transport_init(tls, cert);
        // Check if transport was initialized
        if(session_transport == NULL) {
            ESP_LOGE(TAG, "Transport initialization failed.");
            if (++retry_critical_attempts > MAX_CRITICAL_RETRY_ATTEMPTS) {
                ESP_LOGE(TAG, "Max retry attempts reached, restarting...");
                esp_restart();
            }
            vTaskDelay(5000 / portTICK_PERIOD_MS);
            continue;
        }
        retry_critical_attempts = 0;

        ESP_LOGI(TAG, "Transport initialized, connecting to %s:%d", stratum_url, port);
        esp_err_t ret = esp_transport_connect(session_transport, stratum_url, port, TRANSPORT_TIMEOUT_MS);
        if (ret != ESP_OK) {
            retry_attempts ++;
            ESP_LOGE(TAG, "Transport unable to connect to %s:%d (errno %d). Attempt: %d", stratum_url, port, ret, retry_attempts);
            // close the transport
            esp_transport_destroy(session_transport);
            // instead of restarting, retry this every 5 seconds
            vTaskDelay(5000 / portTICK_PERIOD_MS);
            continue;
        }

        set_socket_options(session_transport);
        const bool fixed_session = ASIC_uses_fixed_jobs(GLOBAL_STATE);
        if (fixed_session) {
            int sock = esp_transport_get_socket(session_transport);
            struct timeval short_timeout = {.tv_usec = 250000};
            if (sock >= 0) setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &short_timeout, sizeof(short_timeout));
        }


        const char* protocol = (conn_info.addr_family == AF_INET6) ? "IPv6" : "IPv4";
        const char *tls_status;

        switch (tls) {
            case DISABLED:     tls_status = ""; break;
            case BUNDLED_CRT:  tls_status = " (TLS)"; break;
            case CUSTOM_CRT:   tls_status = " (TLS Cert)"; break;
            default:           tls_status = ""; break;
        }

        snprintf(GLOBAL_STATE->SYSTEM_MODULE.pool_connection_info,
                 sizeof(GLOBAL_STATE->SYSTEM_MODULE.pool_connection_info),
                 "%s%s", protocol, tls_status);        

#if CONFIG_BM1370_FIXED_JOBS
        if (fixed_session) {
            bm1370_jobs_lock();
            if (session_fallback != GLOBAL_STATE->SYSTEM_MODULE.is_using_fallback) {
                bm1370_jobs_unlock();
                esp_transport_destroy(session_transport);
                continue;
            }
        }
#endif
        stratum_reset_uid(GLOBAL_STATE);
        clean_queue_locked(GLOBAL_STATE, "connect");
        GLOBAL_STATE->transport = session_transport;
        STRATUM_V1_initialize_buffer();
#if CONFIG_BM1370_FIXED_JOBS
        if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) bm1370_jobs_unlock();
#endif

        ///// Start Stratum Action
        // mining.configure - ID: 1
        STRATUM_V1_configure_version_rolling(session_transport, STRATUM_ID_CONFIGURE, &GLOBAL_STATE->version_mask);

        // mining.subscribe - ID: 2
        STRATUM_V1_subscribe(session_transport, STRATUM_ID_SUBSCRIBE, GLOBAL_STATE->DEVICE_CONFIG.family.asic.name);

        char * username = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_user : GLOBAL_STATE->SYSTEM_MODULE.pool_user;
        const bool multipool = mining_pool_is_zpool_sha256(stratum_url);
        const mining_network_t network = multipool ? MINING_NETWORK_AUTO : mining_network_resolve(
            session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_coin : GLOBAL_STATE->SYSTEM_MODULE.pool_coin, username);
        const bool decode_coinbase = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_decode_coinbase :
                                                      GLOBAL_STATE->SYSTEM_MODULE.pool_decode_coinbase;
        if (multipool) ESP_LOGI(TAG, "zpool SHA-256 session: chain selection is managed by the pool");
        GLOBAL_STATE->version_mask = mining_network_version_mask(network, GLOBAL_STATE->version_mask);
        char * password = session_fallback ? GLOBAL_STATE->SYSTEM_MODULE.fallback_pool_pass : GLOBAL_STATE->SYSTEM_MODULE.pool_pass;

        const int authorize_message_id = 3;

        //mining.authorize - ID: 3
        STRATUM_V1_authorize(session_transport, authorize_message_id, username, password);

#if CONFIG_BM1370_FIXED_JOBS
        int64_t partial_since_us = 0;
#endif
        while (1) {
            char *line;
#if CONFIG_BM1370_FIXED_JOBS
            if (fixed_session) {
                if (!session_current(GLOBAL_STATE, session_transport)) break;
                // Give already received jobs priority, including a fragmented
                // notification. Only try a share when the receive side is idle.
                stratum_read_result read = STRATUM_V1_read_step(session_transport, 10, &line);
                if (read == STRATUM_READ_MORE) {
                    int64_t now = esp_timer_get_time();
                    if (!partial_since_us) partial_since_us = now;
                    if (now - partial_since_us < (int64_t)TRANSPORT_TIMEOUT_MS * 1000) continue;
                    ESP_LOGW(TAG, "Incomplete Stratum line timed out");
                } else {
                    partial_since_us = 0;
                }
                if (read == STRATUM_READ_IDLE) {
                    if (flush_one_share(GLOBAL_STATE, session_transport, username)) continue;
                    ESP_LOGW(TAG, "Share write stalled or incomplete, reconnecting");
                }
            } else
#endif
            line = STRATUM_V1_receive_jsonrpc_line(session_transport);
            if (!line) {
                ESP_LOGE(TAG, "Failed to receive JSON-RPC line, reconnecting...");
                retry_attempts++;
                stratum_close_connection(GLOBAL_STATE);
                break;
            }

            int64_t receive_time_us = esp_timer_get_time();

            STRATUM_V1_parse(&stratum_api_v1_message, line);
            free(line);
            float response_time_ms = -1.0f;
            if (stratum_api_v1_message.method == STRATUM_RESULT) {
                response_time_ms = STRATUM_V1_get_response_time_ms(stratum_api_v1_message.message_id, receive_time_us);
            }

            if (stratum_api_v1_message.method == MINING_NOTIFY && stratum_api_v1_message.mining_notification) {
                if (!mining_network_job_supported(network, stratum_api_v1_message.mining_notification->version)) {
                    ESP_LOGE(TAG, "Unsupported DigiByte algorithm: select a SHA-256d pool port");
                    STRATUM_V1_free_mining_notify(stratum_api_v1_message.mining_notification);
                    retry_attempts++;
                    stratum_close_connection(GLOBAL_STATE);
                    break;
                }
                GLOBAL_STATE->SYSTEM_MODULE.work_received++;
                mining_notify *notification = stratum_api_v1_message.mining_notification;
                const uint32_t ntime = notification->ntime;
                const bool clean_jobs = notification->clean_jobs;
                char logged_job_id[33];
                int64_t invalidate_delay_us = -1;
#if CONFIG_BM1370_FIXED_JOBS
                if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
                    bm1370_jobs_lock();
                    if (GLOBAL_STATE->transport != session_transport) {
                        bm1370_jobs_unlock();
                        STRATUM_V1_free_mining_notify(notification);
                        continue;
                    }
                    if (clean_jobs) {
                        invalidate_delay_us = esp_timer_get_time() - receive_time_us;
                        clean_queue_locked(GLOBAL_STATE, "clean_jobs");
                    }
                    notification->work_epoch = bm1370_jobs_epoch_locked();
                    notification->work_version_mask = GLOBAL_STATE->version_mask;
                    notification->work_difficulty = GLOBAL_STATE->pool_difficulty;
                    notification->work_extranonce2_len = GLOBAL_STATE->extranonce_2_len;
                    notification->work_extranonce1 = GLOBAL_STATE->extranonce_str ? strdup(GLOBAL_STATE->extranonce_str) : NULL;
                    if (!notification->work_extranonce1 || !notification->job_id ||
                        strnlen(notification->job_id, BM1370_JOB_ID_CAP + 1) > BM1370_JOB_ID_CAP ||
                        notification->work_extranonce2_len < 0 || notification->work_extranonce2_len > MAX_EXTRANONCE_2_LEN) {
                        bm1370_jobs_unlock();
                        ESP_LOGE("job_store", "Notification rejected: missing context or fixed capacity exceeded");
                        STRATUM_V1_free_mining_notify(notification);
                        continue;
                    }
                } else
#endif
                if (notification->clean_jobs && GLOBAL_STATE->stratum_queue.count > 0) {
                    clean_queue_locked(GLOBAL_STATE, "clean_jobs");
                }
                if (GLOBAL_STATE->stratum_queue.count == QUEUE_SIZE) {
                    mining_notify *old = queue_dequeue_timeout(&GLOBAL_STATE->stratum_queue, 0);
                    if (old) STRATUM_V1_free_mining_notify(old);
                }
                // Decode before enqueue: the high-priority consumer can free a
                // notification as soon as the next one arrives.
                decode_mining_notification(GLOBAL_STATE, notification, username, network, decode_coinbase, multipool);
                snprintf(logged_job_id, sizeof(logged_job_id), "%s", notification->job_id ? notification->job_id : "?");
                queue_enqueue(&GLOBAL_STATE->stratum_queue, notification);
#if CONFIG_BM1370_FIXED_JOBS
                if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) bm1370_jobs_unlock();
#endif
                SYSTEM_notify_new_ntime(GLOBAL_STATE, ntime);
                ESP_LOGI(TAG, "Job id=%s clean=%d received_ms=%lld invalidate_us=%lld",
                         logged_job_id, clean_jobs, (long long)(receive_time_us / 1000),
                         (long long)invalidate_delay_us);
            } else if (stratum_api_v1_message.method == MINING_SET_DIFFICULTY) {
                ESP_LOGI(TAG, "Set pool difficulty: %ld", stratum_api_v1_message.new_difficulty);
                GLOBAL_STATE->pool_difficulty = stratum_api_v1_message.new_difficulty;
                GLOBAL_STATE->new_set_mining_difficulty_msg = true;
            } else if (stratum_api_v1_message.method == MINING_SET_VERSION_MASK ||
                    stratum_api_v1_message.method == STRATUM_RESULT_VERSION_MASK) {
                ESP_LOGI(TAG, "Set version mask: %08lx", stratum_api_v1_message.version_mask);
                GLOBAL_STATE->version_mask = mining_network_version_mask(network, stratum_api_v1_message.version_mask);
                GLOBAL_STATE->new_stratum_version_rolling_msg = true;
            } else if (stratum_api_v1_message.method == MINING_SET_EXTRANONCE ||
                    stratum_api_v1_message.method == STRATUM_RESULT_SUBSCRIBE) {
#if CONFIG_BM1370_FIXED_JOBS
                if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) {
                    bm1370_jobs_lock();
                    clean_queue_locked(GLOBAL_STATE, "extranonce");
                }
#endif
                // A resized extranonce2 would only produce shares the pool rejects.
                // Keep the context unusable (no work generated) until replaced.
                if (stratum_api_v1_message.extranonce_2_len < 0 ||
                    stratum_api_v1_message.extranonce_2_len > MAX_EXTRANONCE_2_LEN) {
                    ESP_LOGE(TAG, "Context rejected: extranonce2 size %d is outside 0..%d bytes",
                             stratum_api_v1_message.extranonce_2_len, MAX_EXTRANONCE_2_LEN);
                    stratum_api_v1_message.extranonce_2_len = -1;
                }
                ESP_LOGI(TAG, "Set extranonce: %s, extranonce_2_len: %d", stratum_api_v1_message.extranonce_str, stratum_api_v1_message.extranonce_2_len);
                char * old_extranonce_str = GLOBAL_STATE->extranonce_str;
                GLOBAL_STATE->extranonce_str = stratum_api_v1_message.extranonce_str;
                GLOBAL_STATE->extranonce_2_len = stratum_api_v1_message.extranonce_2_len;
                free(old_extranonce_str);
#if CONFIG_BM1370_FIXED_JOBS
                if (ASIC_uses_fixed_jobs(GLOBAL_STATE)) bm1370_jobs_unlock();
#endif
            } else if (stratum_api_v1_message.method == MINING_PING) { 
                STRATUM_V1_pong(session_transport, stratum_api_v1_message.message_id);
            } else if (stratum_api_v1_message.method == CLIENT_RECONNECT) {
                ESP_LOGE(TAG, "Pool requested client reconnect...");
                stratum_close_connection(GLOBAL_STATE);
                break;
            } else if (stratum_api_v1_message.method == STRATUM_RESULT && response_time_ms >= 0) {
                const char *reason = stratum_api_v1_message.error_str ? stratum_api_v1_message.error_str : "unknown";
                pool_stats_share(session_fallback, stratum_api_v1_message.response_success, reason, response_time_ms);
                if (stratum_api_v1_message.response_success) {
                    ESP_LOGI(TAG, "message result accepted");
                    SYSTEM_notify_accepted_share(GLOBAL_STATE);
                } else {
                    ESP_LOGW(TAG, "message result rejected: %s", reason);
                    SYSTEM_notify_rejected_share(GLOBAL_STATE, reason);
                }
            } else if (stratum_api_v1_message.method == STRATUM_RESULT_SETUP) {
                // Reset retry attempts after successfully receiving data.
                retry_attempts = 0;
                if (stratum_api_v1_message.response_success) {
                    ESP_LOGI(TAG, "setup message accepted");
                    if (stratum_api_v1_message.message_id == authorize_message_id) {
                        if (difficulty > 0) STRATUM_V1_suggest_difficulty(session_transport, 4, difficulty);
                        if (extranonce_subscribe) STRATUM_V1_extranonce_subscribe(session_transport, 5);
                    }
                } else {
                    ESP_LOGE(TAG, "setup message rejected: %s", stratum_api_v1_message.error_str);
                }
            }

            if (response_time_ms >= 0) {
                ESP_LOGI(TAG, "Stratum response time: %.1f ms", response_time_ms);
                GLOBAL_STATE->SYSTEM_MODULE.response_time = response_time_ms;
            }
        }

        if (fixed_session) stratum_close_connection(GLOBAL_STATE);
        esp_transport_destroy(session_transport);
        if (fixed_session) vTaskDelay(pdMS_TO_TICKS(1000));

        if (stratum_api_v1_message.error_str) {
            free(stratum_api_v1_message.error_str);
            stratum_api_v1_message.error_str = NULL;
        }
    }
    vTaskDelete(NULL);
}
