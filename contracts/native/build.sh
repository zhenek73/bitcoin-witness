#!/usr/bin/env bash
# Builds the native relay contract.
#
# Requires Antelope CDT (https://github.com/AntelopeIO/cdt/releases):
#   curl -sSL -o cdt.deb \
#     https://github.com/AntelopeIO/cdt/releases/download/v4.1.0/cdt_4.1.0-1_amd64.deb
#   sudo apt-get install -y ./cdt.deb
#
# Verified with cdt-cpp 4.1.0 — produces an ~11 KB wasm.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
cdt-cpp -abigen -I include -o build/btcwitness.wasm src/btcwitness.cpp
ls -la build/
