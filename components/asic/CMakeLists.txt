idf_component_register(
SRCS 
    "bm1370.c"
    "bm1370_protocol.c"
    "bm1368.c"
    "bm1366.c"
    "bm1397.c"
    "serial.c"
    "crc.c"
    "asic_common.c"
    "asic.c"
    "frequency_transition_bmXX.c"
    "pll.c"

INCLUDE_DIRS 
    "include"

REQUIRES 
    "freertos"
    "driver"
    "esp_driver_uart"
    "stratum"
    "tcp_transport"
)

if(CONFIG_BM1370_PROTOCOL_RUST OR CONFIG_BM1370_FIXED_JOBS)
    # Shared archive with the coinbase reader: one Rust core/panic handler.
    target_link_libraries(${COMPONENT_LIB} PRIVATE coinbase_rust)
endif()
if(CONFIG_BM1370_FIXED_JOBS)
    target_sources(${COMPONENT_LIB} PRIVATE "bm1370_jobs.c")
endif()
if(CONFIG_BM1370_PROTOCOL_BENCHMARK)
    target_sources(${COMPONENT_LIB} PRIVATE "bm1370_benchmark.c")
endif()


# Include the header files from "main" directory
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../main")

# Include the header files from "main/tasks" directory
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../main/tasks")

# Project code uses C23 (the ESP-IDF 6 default); ESP-IDF 5.5 itself stays on gnu17.
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:C>:-std=gnu23>)
