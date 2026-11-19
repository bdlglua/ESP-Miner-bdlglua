idf_component_register(
SRCS
    "utils.c"
    "mining.c"
    "mining_network.c"
    "stratum_api.c"
    "coinbase_decoder.c"
    "segwit_addr.c"
    "base58.c"
    "bitcoin_hash.c"
                    
INCLUDE_DIRS
    "include"

REQUIRES
    "mbedtls"
    "app_update"
    "esp_timer"
    "tcp_transport"
)

if(CONFIG_COINBASE_RUST OR CONFIG_BM1370_PROTOCOL_RUST OR CONFIG_BM1370_FIXED_JOBS)
    find_program(COINBASE_CARGO cargo REQUIRED)
    set(COINBASE_CRATE "${CMAKE_CURRENT_LIST_DIR}/rust")
    set(COINBASE_TARGET "xtensa-esp32s3-espidf")
    set(COINBASE_FEATURES "")
    if(CONFIG_BM1370_FIXED_JOBS)
        list(APPEND COINBASE_FEATURES --features fixed-jobs)
    endif()
    if(CONFIG_BM1370_PROTOCOL_RUST)
        list(APPEND COINBASE_FEATURES --features asic-protocol)
    endif()
    if(CONFIG_BM1370_PROTOCOL_BENCHMARK)
        list(APPEND COINBASE_FEATURES --features protocol-bench)
    endif()
    set(COINBASE_ARCHIVE "${CMAKE_CURRENT_BINARY_DIR}/rust/${COINBASE_TARGET}/release/libaxeos_coinbase.a")
    add_custom_command(
        OUTPUT "${COINBASE_ARCHIVE}"
        COMMAND "${COINBASE_CARGO}" +axeos-esp build
                --manifest-path "${COINBASE_CRATE}/Cargo.toml"
                --target-dir "${CMAKE_CURRENT_BINARY_DIR}/rust"
                --target "${COINBASE_TARGET}" --release --locked --offline
                ${COINBASE_FEATURES}
                -Zbuild-std=core
        DEPENDS "${COINBASE_CRATE}/Cargo.toml" "${COINBASE_CRATE}/Cargo.lock"
                "${COINBASE_CRATE}/src/lib.rs" "${COINBASE_CRATE}/src/bm1370.rs"
                "${COINBASE_CRATE}/src/bm1370_legacy.rs"
                "${COINBASE_CRATE}/src/jobbook.rs" "${COINBASE_CRATE}/src/jobstore.rs"
        COMMENT "Building experimental no_std Rust readers/codecs"
        VERBATIM
    )
    add_custom_target(coinbase_rust_build DEPENDS "${COINBASE_ARCHIVE}")
    add_prebuilt_library(coinbase_rust "${COINBASE_ARCHIVE}")
    # IDF's helper creates a directory-scoped imported target. The ASIC component
    # must see the same archive, rather than resolving a literal -lcoinbase_rust.
    set_property(TARGET coinbase_rust PROPERTY IMPORTED_GLOBAL TRUE)
    add_dependencies(coinbase_rust coinbase_rust_build)
    target_link_libraries(${COMPONENT_LIB} PRIVATE coinbase_rust)
endif()

# Project code uses C23 (the ESP-IDF 6 default); ESP-IDF 5.5 itself stays on gnu17.
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:C>:-std=gnu23>)
