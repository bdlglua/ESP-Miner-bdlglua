#!/usr/bin/env bash
set -euo pipefail

# OpenAPI Generator CLI 7.17.0, matching the original openapitools.json.
# This avoids installing the vulnerable npm wrapper and its FTP/proxy-agent chain.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION='7.17.0'
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/axeos-openapi-generator"
JAR="$CACHE/openapi-generator-cli-$VERSION.jar"
URL="https://repo.maven.apache.org/maven2/org/openapitools/openapi-generator-cli/$VERSION/openapi-generator-cli-$VERSION.jar"

if ! command -v java >/dev/null 2>&1; then
  echo 'OpenAPI Generator requires Java (JRE 11+).' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo 'OpenAPI Generator requires curl for the first download.' >&2
  exit 1
fi
if [[ ! -s "$JAR" ]]; then
  mkdir -p "$CACHE"
  echo "Downloading OpenAPI Generator CLI $VERSION from Maven Central..."
  curl --fail --location --retry 3 --connect-timeout 10 --max-time 300 \
    "$URL" --output "$JAR.download"
  test -s "$JAR.download"
  mv -- "$JAR.download" "$JAR"
fi

# The specification is tracked by ESP-IDF CMake in main/http_server/openapi.yaml.
test -s ../openapi.yaml || { echo 'Missing ../openapi.yaml' >&2; exit 1; }
rm -rf ./src/app/generated
java -jar "$JAR" generate \
  --generator-name typescript-angular \
  --input-spec ../openapi.yaml \
  --output ./src/app/generated \
  --additional-properties=stringEnums=true,enumPropertyNaming=original,fileNaming=kebab-case

test -f ./src/app/generated/index.ts || {
  echo 'OpenAPI generation did not produce src/app/generated/index.ts' >&2
  exit 1
}
