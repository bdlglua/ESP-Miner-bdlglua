#!/usr/bin/env bash
# Three isolated diagnostic images; no flashing or root sdkconfig/binary changes.
set -euo pipefail
protocol_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$protocol_repo"
command -v idf.py >/dev/null || { echo "Source ESP-IDF export.sh first" >&2; exit 1; }
cargo +axeos-esp build --manifest-path components/stratum/rust/Cargo.toml \
    --features protocol-bench --target xtensa-esp32s3-espidf --release --locked -Zbuild-std=core
protocol_lab="${BM1370_LAB_DIR:-$protocol_repo/build/bm1370-lab}"
protocol_outputs="${BM1370_OUTPUT_DIR:-$protocol_repo/build/bm1370-profiles}"
mkdir -p "$protocol_lab" "$protocol_outputs"
protocol_modes=("$@")
if [[ ${#protocol_modes[@]} == 0 ]]; then protocol_modes=(c shadow rust); fi
for protocol_mode in "${protocol_modes[@]}"; do
    case "$protocol_mode" in c|shadow|rust|dual|bench|jobs|jobs-test|release) ;; *) echo "Expected c, shadow, rust, dual, bench, jobs, jobs-test or release" >&2; exit 2;; esac
    python3 - "$protocol_mode" "$protocol_lab/sdkconfig" <<'PY'
import sys
from pathlib import Path
mode, destination = sys.argv[1:]
options = ('CONFIG_COINBASE_RUST', 'CONFIG_COINBASE_PROFILE', 'CONFIG_MINING_WORK_PROFILE',
           'CONFIG_BM1370_PROTOCOL_RUST', 'CONFIG_BM1370_PROTOCOL_SHADOW', 'CONFIG_BM1370_PROTOCOL_BENCHMARK',
           'CONFIG_BM1370_FIXED_JOBS', 'CONFIG_BM1370_JOBSTORE_TEST')
lines = [line for line in Path('sdkconfig').read_text().splitlines()
         if not any(line.startswith(option + '=') or line.startswith('# ' + option + ' ')
                    for option in options)]
lines += ['CONFIG_COINBASE_RUST=y' if mode == 'dual' else '# CONFIG_COINBASE_RUST is not set',
          '# CONFIG_COINBASE_PROFILE is not set',
          '# CONFIG_MINING_WORK_PROFILE is not set' if mode == 'release' else 'CONFIG_MINING_WORK_PROFILE=y',
          'CONFIG_BM1370_PROTOCOL_RUST=y' if mode != 'c' else '# CONFIG_BM1370_PROTOCOL_RUST is not set',
          'CONFIG_BM1370_PROTOCOL_SHADOW=y' if mode == 'shadow' else '# CONFIG_BM1370_PROTOCOL_SHADOW is not set',
          'CONFIG_BM1370_PROTOCOL_BENCHMARK=y' if mode == 'bench' else '# CONFIG_BM1370_PROTOCOL_BENCHMARK is not set',
          'CONFIG_BM1370_FIXED_JOBS=y' if mode in ('jobs', 'jobs-test', 'release') else '# CONFIG_BM1370_FIXED_JOBS is not set',
          'CONFIG_BM1370_JOBSTORE_TEST=y' if mode == 'jobs-test' else '# CONFIG_BM1370_JOBSTORE_TEST is not set']
Path(destination).write_text('\n'.join(lines) + '\n')
PY
    protocol_version="${BM1370_FIRMWARE_VERSION:-v2.13.2-ppc-proto-$protocol_mode}"
    protocol_target=app
    if [[ "$protocol_mode" == release ]]; then
        protocol_target=build
        protocol_version="${BM1370_FIRMWARE_VERSION:-v2.13.2-multi-rust3-fix7}"
        if [[ -n "${AXEOS_WEB_VERSION:-}" && "$AXEOS_WEB_VERSION" != "$protocol_version" ]]; then
            echo "Firmware and Web UI versions must match for release" >&2; exit 2
        fi
        export AXEOS_WEB_VERSION="$protocol_version"
        # CMake cannot track environment changes as file dependencies.
        if [[ ! -f main/http_server/axe-os/dist/axe-os/version.txt ]] || \
           [[ "$(cat main/http_server/axe-os/dist/axe-os/version.txt)" != "$protocol_version" ]]; then
            python3 -c 'from pathlib import Path; import sys; Path(sys.argv[1]).unlink(missing_ok=True)' "$protocol_lab/web_ui_build.stamp"
        fi
    fi
    idf.py -B "$protocol_lab" -D "SDKCONFIG=$protocol_lab/sdkconfig" \
        -D "PROJECT_VER=$protocol_version" "$protocol_target"
    for protocol_extension in bin elf map; do
        cp -- "$protocol_lab/esp-miner.$protocol_extension" "$protocol_outputs/bm1370-$protocol_mode.$protocol_extension"
    done
    cp -- "$protocol_lab/sdkconfig" "$protocol_outputs/sdkconfig-$protocol_mode"
    if [[ "$protocol_mode" == release ]]; then
        cp -- "$protocol_lab/www.bin" "$protocol_outputs/www.bin"
    fi
done
sha256sum "$protocol_outputs"/*.bin > "$protocol_outputs/SHA256SUMS"
echo "Diagnostic images: $protocol_outputs (nothing flashed)"
