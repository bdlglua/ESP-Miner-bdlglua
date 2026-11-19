#!/usr/bin/env bash
# PC tests (C with ASan/UBSan, Rust, Python), as run by the GitHub CI in ubuntu:26.04.
# Needs gcc >= 14 (-std=gnu23), python3, libmbedtls 3.6, libcjson, cargo, and IDF_PATH
# pointing at ESP-IDF 5.5 sources for the cJSON and mbedTLS headers (ESP-IDF 6.1 no
# longer ships cJSON). No device or pool connection is used.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
: "${IDF_PATH:?IDF_PATH must point to ESP-IDF 5.5 sources}"

for test in tools/test_*.py; do
    echo "::group::${test}"
    python3 "${test}"
    echo "::endgroup::"
done
python3 -m unittest tools/tests/test_stability_gate.py
