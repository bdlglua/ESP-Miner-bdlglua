#!/usr/bin/env bash
# Rebuild tools/ngp from the Angular source archive: the preprocessor is compiled
# with TypeScript 7 and its Rust analyzer (ng-analyze) as a Node N-API module.
#   curl -LO https://github.com/angular/angular/archive/refs/tags/v22.3.0.zip
#   tools/ngp/rebuild.sh v22.3.0.zip
set -euo pipefail
zip=${1:?usage: rebuild.sh angular-<version>.zip}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

unzip -q "$zip" -d "$work"
repo=$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)
pre=$repo/packages/compiler-cli/preprocessor
version=$(node -p "require('$repo/package.json').version")

# Local modifications of Angular (tools/ngp/patches/*.patch, applied in order).
for patch in "$here"/patches/*.patch; do
  [ -e "$patch" ] || continue
  (cd "$repo" && git apply --whitespace=nowarn "$patch")
  echo "applied $(basename "$patch")"
done

# Same TypeScript 7 and @angular/compiler versions as the application.
(cd "$work" && echo '{"private":true,"type":"module"}' > package.json &&
  npm install --no-audit --no-fund --ignore-scripts typescript@7.0.2 "@angular/compiler@$version" \
    magic-string@^1.4.5 @types/node@^22 tslib >/dev/null)
cat > "$pre/tsconfig.ts7.json" <<EOF
{
  "extends": "../../tsconfig-build.json",
  "compilerOptions": {"rootDir": "../..", "outDir": "$work/out", "types": ["node"], "declaration": false,
                      "sourceMap": false, "inlineSources": false, "importHelpers": false},
  "files": ["main.ts", "ngp.ts", "api.ts"],
  "include": ["src/**/*.ts"],
  "exclude": ["**/*_spec.ts", "test/**", "language-service/**"]
}
EOF
node "$work/node_modules/typescript/bin/tsc" -p "$pre/tsconfig.ts7.json"
cargo build --release --locked --manifest-path "$repo/Cargo.toml" -p ng-analyze --features napi --lib \
  --target-dir "$work/target"

find "$here" -name '*.js' -delete
(cd "$work/out/compiler-cli/preprocessor" && find . -name '*.js' -exec install -D -m 644 {} "$here/{}" \;)
install -m 755 "$work/target/release/libng_analyze.so" "$here/ng_analyze.node"
cp "$repo/LICENSE" "$here/LICENSE"
echo "tools/ngp rebuilt from Angular $version ($(node "$work/node_modules/typescript/bin/tsc" --version))"
