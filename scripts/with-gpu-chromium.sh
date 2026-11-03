#!/usr/bin/env bash
# Run a command with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH set to a GPU-backed Chromium.
#
# Playwright's bundled headless shell has no GPU on Linux. On Nix hosts, nixpkgs' Chromium
# renders WebGL through ANGLE/Vulkan on the real GPU; headless WebGPU has no adapter there,
# so the scene uses its WebGL 2 backend. `e2e/browser-options.ts` adds the matching flags.
# An explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is kept as is.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi
if [[ -n "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]]; then
  exec "$@"
fi
if ! command -v nix > /dev/null; then
  echo "with-gpu-chromium: nix is unavailable; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH instead" >&2
  exit 1
fi
# Prefer the host's pinned nixpkgs (the devbox flake) so the browser matches its GPU stack.
inputs=()
for flake in "${DOTME_NIXPKGS_FROM:-}" "$HOME/devbox"; do
  if [[ -n "$flake" && -f "$flake/flake.nix" ]]; then
    inputs=(--inputs-from "$flake")
    break
  fi
done
chromium="$(nix shell "${inputs[@]}" nixpkgs#chromium --command sh -c 'readlink -f "$(command -v chromium)"')"
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$chromium" exec "$@"
