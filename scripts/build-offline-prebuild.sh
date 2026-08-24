#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

cd "${ROOT_DIR}"
npm run build:open62541
node-gyp rebuild "$@"

PREBUILD_KEY="$(node -p "require('./lib/prebuild').prebuildKey()")"
DESTINATION="${ROOT_DIR}/prebuilds/${PREBUILD_KEY}/opcua_open62541.node"
mkdir -p "$(dirname "${DESTINATION}")"
cp "${ROOT_DIR}/build/Release/opcua_open62541.node" "${DESTINATION}"
echo "Built ${DESTINATION}"
