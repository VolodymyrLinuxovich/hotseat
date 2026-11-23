#!/usr/bin/env bash
# Compiles native/hotseat_core.cpp to native/hotseat_core.wasm with the WASI SDK.
# The .wasm is checked in, so only run this after changing the C++.
#
# Get the SDK once (macOS arm64):
#   gh release download -R WebAssembly/wasi-sdk wasi-sdk-34 -p 'wasi-sdk-34.0-arm64-macos.tar.gz' -D .tools
#   tar xzf .tools/wasi-sdk-34.0-arm64-macos.tar.gz -C .tools
# or point WASI_SDK at an existing install.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WASI_SDK="${WASI_SDK:-$ROOT/.tools/wasi-sdk-34.0-arm64-macos}"
CXX="$WASI_SDK/bin/clang++"

if [ ! -x "$CXX" ]; then
  echo "No WASI SDK at $WASI_SDK. See the comment at the top of native/build.sh." >&2
  exit 1
fi

# -ffp-contract=off keeps the compiler from fusing multiply-adds, which would break parity
# with the JS fallback. No entry point: this is a library, Node calls the exports directly.
"$CXX" \
  --target=wasm32-wasip1 \
  --sysroot="$WASI_SDK/share/wasi-sysroot" \
  -std=c++17 -O2 -fno-exceptions -fno-rtti -ffp-contract=off \
  -nostartfiles \
  -Wl,--no-entry \
  -Wl,--strip-all \
  -Wl,--export=hc_ability \
  -Wl,--export=hc_bootstrap \
  -Wl,--export=hc_align \
  -Wl,--export=hc_xorshift \
  -Wl,--export=malloc \
  -Wl,--export=free \
  -o "$HERE/hotseat_core.wasm" \
  "$HERE/hotseat_core.cpp"

echo "Built native/hotseat_core.wasm ($(wc -c < "$HERE/hotseat_core.wasm" | tr -d ' ') bytes)"

# The optional native benchmark uses the system compiler.
if [ "${1:-}" = "--bench" ]; then
  clang++ -std=c++17 -O2 -fno-exceptions -ffp-contract=off -o "$HERE/bench" "$HERE/bench.cpp" "$HERE/hotseat_core.cpp"
  "$HERE/bench"
fi
