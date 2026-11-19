idf_component_register(
SRCS
    "dns_server.c"

INCLUDE_DIRS
    "include"

PRIV_REQUIRES
    "esp_netif"
)

# Project code uses C23 (the ESP-IDF 6 default); ESP-IDF 5.5 itself stays on gnu17.
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:C>:-std=gnu23>)
