#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
OPEN62541_ROOT="${OPEN62541_PREFIX:-${ROOT_DIR}/.build/open62541}"
OUTPUT="${OPCUA_TEST_SERVER_BINARY:-${ROOT_DIR}/build/open62541-test-server}"
LIBRARY="${OPEN62541_ROOT}/lib/libopen62541.a"

if [[ ! -f "${LIBRARY}" ]]; then
  echo "open62541 static library not found: ${LIBRARY}" >&2
  echo "Run npm run build:open62541 first." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT}")"
"${CC:-cc}" -std=c99 -O2 -Wall -Wextra \
  -I"${OPEN62541_ROOT}/include" \
  "${ROOT_DIR}/test/fixture/open62541_server.c" \
  "${LIBRARY}" -lssl -lcrypto -lpthread -lm -ldl \
  -o "${OUTPUT}"

echo "Built ${OUTPUT}"
