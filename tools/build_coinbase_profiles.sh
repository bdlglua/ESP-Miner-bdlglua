#!/usr/bin/env bash
# Build isolated diagnostic images. Never flashes, edits root sdkconfig, or
# replaces build/esp-miner.bin / build/www.bin. Run after sourcing ESP-IDF.
set -euo pipefail
coinbase_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$coinbase_repo"
command -v idf.py >/dev/null || { echo "Source ESP-IDF export.sh first" >&2; exit 1; }
rustup run axeos-esp rustc --version

# Fetch/build core once; CMake can then build the crate offline. The reader itself
# has no third-party dependencies. The global/default Rust toolchain is unchanged.
cargo +axeos-esp build --manifest-path components/stratum/rust/Cargo.toml \
    --target xtensa-esp32s3-espidf --release --locked -Zbuild-std=core

coinbase_lab="$coinbase_repo/build/coinbase-lab"
coinbase_profiles="$coinbase_repo/build/coinbase-profiles"
mkdir -p "$coinbase_lab" "$coinbase_profiles"
for coinbase_backend in c rust; do
    python3 - "$coinbase_backend" "$coinbase_lab/sdkconfig" <<'PY'
from pathlib import Path
import sys
backend, destination = sys.argv[1:]
options = ('CONFIG_COINBASE_RUST', 'CONFIG_COINBASE_PROFILE', 'CONFIG_MINING_WORK_PROFILE')
lines = [line for line in Path('sdkconfig').read_text().splitlines()
         if not any(line.startswith(option + '=') or line.startswith('# ' + option + ' ')
                    for option in options)]
lines += ['CONFIG_COINBASE_PROFILE=y', 'CONFIG_MINING_WORK_PROFILE=y',
          'CONFIG_COINBASE_RUST=y' if backend == 'rust' else '# CONFIG_COINBASE_RUST is not set']
Path(destination).write_text('\n'.join(lines) + '\n')
PY
    if [[ "$coinbase_backend" == c ]]; then
        coinbase_version=v2.13.2-ppc-cprof
    else
        coinbase_version=v2.13.2-ppc-rprof
    fi
    idf.py -B "$coinbase_lab" -D "SDKCONFIG=$coinbase_lab/sdkconfig" \
        -D "PROJECT_VER=$coinbase_version" app
    for coinbase_extension in bin elf map; do
        cp -- "$coinbase_lab/esp-miner.$coinbase_extension" \
            "$coinbase_profiles/coinbase-$coinbase_backend-profile.$coinbase_extension"
    done
    cp -- "$coinbase_lab/sdkconfig" "$coinbase_profiles/sdkconfig-$coinbase_backend"
done
sha256sum "$coinbase_profiles"/*.bin > "$coinbase_profiles/SHA256SUMS"
echo "Diagnostic images: $coinbase_profiles (nothing flashed)"
