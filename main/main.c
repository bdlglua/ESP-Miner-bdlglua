#include "esp_event.h"
#include "esp_log.h"
#include "esp_psram.h"

#include "asic_result_task.h"
#include "create_jobs_task.h"
#include "hashrate_monitor_task.h"
#include "fan_controller_task.h"
#include "statistics_task.h"
#include "system.h"
#include "http_server.h"
#include "serial.h"
#include "stratum_task.h"
#include "i2c_bitaxe.h"
#include "adc.h"
#include "nvs_config.h"
#include "miner_diagnostics.h"
#include "self_test.h"
#include "asic.h"
#include "bap/bap.h"
#include "device_config.h"
#include "connect.h"
#include "asic_reset.h"
#include "asic_init.h"
#include "esp_ota_ops.h"

static GlobalState GLOBAL_STATE;

static const char * TAG = "bitaxe";

#define APP_CONFIRM_DELAY_MS (10 * 60 * 1000)

// With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, an OTA image boots once as
// "pending verify". Unless confirmed before the next reset, the bootloader
// returns to the previous firmware.
static void confirm_running_app(const char *reason)
{
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (!running || esp_ota_get_state_partition(running, &state) != ESP_OK ||
        state != ESP_OTA_IMG_PENDING_VERIFY) return;
    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) ESP_LOGI(TAG, "Firmware confirmed (%s); rollback cancelled", reason);
    else ESP_LOGE(TAG, "Firmware confirmation failed: %s", esp_err_to_name(err));
}

// Fallback when Wi-Fi never joins: an image that stays up this long, with
// AxeOS reachable through its access point, is kept.
static void confirm_app_after_delay(void *unused)
{
    vTaskDelay(pdMS_TO_TICKS(APP_CONFIRM_DELAY_MS));
    confirm_running_app("10 minutes without restart");
    vTaskDelete(NULL);
}

void app_main(void)
{
    if (xTaskCreate(confirm_app_after_delay, "app confirm", 3072, NULL, 1, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating firmware confirmation task");
    }

    ESP_LOGI(TAG, "Welcome to the bitaxe - FOSS || GTFO!");

    if (!esp_psram_is_initialized()) {
        ESP_LOGE(TAG, "No PSRAM available on ESP32 device!");
        GLOBAL_STATE.psram_is_available = false;
    } else {
        GLOBAL_STATE.psram_is_available = true;
    }

    // Init I2C
    ESP_ERROR_CHECK(i2c_bitaxe_init());
    ESP_LOGI(TAG, "I2C initialized successfully");

    // Initialize RST pin to low early to minimize ASIC power consumption
    ESP_ERROR_CHECK(asic_hold_reset_low());
    ESP_LOGI(TAG, "RST pin initialized to low");

    // wait for I2C to init
    vTaskDelay(100 / portTICK_PERIOD_MS);

    // Init ADC
    ADC_init();

    // initialize the ESP32 NVS
    if (nvs_config_init() != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init NVS");
        return;
    }

    incidents_init();

    // Ensure SSID is initialized before any screen/self-test uses it.
    GLOBAL_STATE.SYSTEM_MODULE.ssid = nvs_config_get_string(NVS_CONFIG_WIFI_SSID);
    if (GLOBAL_STATE.SYSTEM_MODULE.ssid == NULL) {
        ESP_LOGW(TAG, "No SSID configured in NVS, using empty string");
        GLOBAL_STATE.SYSTEM_MODULE.ssid = strdup("");
        if (GLOBAL_STATE.SYSTEM_MODULE.ssid == NULL) {
            ESP_LOGE(TAG, "Failed to allocate memory for SSID");
            return;
        }
    }

    if (device_config_init(&GLOBAL_STATE) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init device config");
        return;
    }

    if (self_test(&GLOBAL_STATE))
        return;

    SYSTEM_init_system(&GLOBAL_STATE);

    // init AP and connect to wifi
    wifi_init(&GLOBAL_STATE);

    SYSTEM_init_peripherals(&GLOBAL_STATE);

    if (xTaskCreate(POWER_MANAGEMENT_task, "power management", 8192, (void *) &GLOBAL_STATE, 10, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating power management task");
    }
    if (xTaskCreate(FAN_CONTROLLER_task, "fan_controller", 8192, (void *) &GLOBAL_STATE, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating fan controller task");
    }

    // start the API for AxeOS
    start_rest_server((void *) &GLOBAL_STATE);

    // After mounting SPIFFS
    SYSTEM_init_versions(&GLOBAL_STATE);

    // Initialize BAP interface
    esp_err_t bap_ret = BAP_init(&GLOBAL_STATE);
    if (bap_ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize BAP interface: %d", bap_ret);
        // Continue anyway, as BAP is not critical for core functionality
    }

    while (!GLOBAL_STATE.SYSTEM_MODULE.is_connected) {
        vTaskDelay(100 / portTICK_PERIOD_MS);
    }

    // Wi-Fi joined and AxeOS is serving: a later firmware can be uploaded from here.
    confirm_running_app("Wi-Fi connected, web server running");

    queue_init(&GLOBAL_STATE.stratum_queue);

    if (asic_initialize(&GLOBAL_STATE, ASIC_INIT_COLD_BOOT, 0) == 0) {
        return;
    }

    if (xTaskCreate(stratum_task, "stratum admin", 8192, (void *) &GLOBAL_STATE, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating stratum admin task");
    }
    if (xTaskCreate(create_jobs_task, "stratum miner", 8192, (void *) &GLOBAL_STATE, 20, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating stratum miner task");
    }
    if (xTaskCreate(ASIC_result_task, "asic result", 8192, (void *) &GLOBAL_STATE, 15, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating asic result task");
    }
    if (xTaskCreateWithCaps(hashrate_monitor_task, "hashrate monitor", 8192, (void *) &GLOBAL_STATE, 5, NULL, MALLOC_CAP_SPIRAM) !=
        pdPASS) {
        ESP_LOGE(TAG, "Error creating hashrate monitor task");
    }
    if (xTaskCreateWithCaps(statistics_task, "statistics", 8192, (void *) &GLOBAL_STATE, 3, NULL, MALLOC_CAP_SPIRAM) != pdPASS) {
        ESP_LOGE(TAG, "Error creating statistics task");
    }
}
