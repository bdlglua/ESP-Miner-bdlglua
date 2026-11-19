idf_component_register(
SRCS
    "connect.c"

INCLUDE_DIRS 
    "include"
    "../../main"
    "../../main/tasks"
    "../asic/include"

REQUIRES
    "nvs_flash"
    "esp_wifi"
    "esp_event"
    "stratum"
)

# Project code uses C23 (the ESP-IDF 6 default); ESP-IDF 5.5 itself stays on gnu17.
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:C>:-std=gnu23>)
