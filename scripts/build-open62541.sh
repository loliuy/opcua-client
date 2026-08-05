#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
VERSION="${OPEN62541_VERSION:-1.4.16}"
BUILD_ROOT="${ROOT_DIR}/.build/open62541-src"
INSTALL_ROOT="${OPEN62541_PREFIX:-${ROOT_DIR}/.build/open62541}"

if [[ ! -d "${BUILD_ROOT}/.git" ]]; then
  rm -rf "${BUILD_ROOT}"
  git clone --depth 1 --branch "v${VERSION}" \
    https://github.com/open62541/open62541.git "${BUILD_ROOT}"
fi

cmake -S "${BUILD_ROOT}" -B "${BUILD_ROOT}/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DUA_ENABLE_ENCRYPTION=OFF \
  -DUA_BUILD_EXAMPLES=OFF \
  -DUA_BUILD_UNIT_TESTS=OFF \
  -DCMAKE_INSTALL_PREFIX="${INSTALL_ROOT}"

cmake --build "${BUILD_ROOT}/build" --parallel "${BUILD_JOBS:-2}"
cmake --install "${BUILD_ROOT}/build"
