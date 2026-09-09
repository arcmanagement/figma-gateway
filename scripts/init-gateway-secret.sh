#!/usr/bin/env bash
# Create the secret shared by the plugin and local gateway in macOS Keychain.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

SERVICE="${FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM:-figma_gateway}"
if security find-generic-password -s "$SERVICE" >/dev/null 2>&1; then
  echo "Using the existing shared secret: $SERVICE"
  exit 0
fi

GATEWAY_GENERATED_SECRET="$(openssl rand -hex 32)"
security add-generic-password -U -a "$(whoami)" -s "$SERVICE" -w "$GATEWAY_GENERATED_SECRET" >/dev/null
unset GATEWAY_GENERATED_SECRET
echo "Saved the shared secret to Keychain: $SERVICE"
