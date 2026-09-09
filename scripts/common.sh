#!/usr/bin/env bash
# Shared settings loaded by the shell helpers. Override values through environment variables.
#
# Optional
#   FIGMA_VARIANT          REST credential profile identifier. Default: local
#   FIGMA_EXPORT_PORT      Export server port. Default: 8473
#   FIGMA_PAT_KEYCHAIN_ITEM  Keychain item containing a personal access token
#                            Default: figma_pat_<variant>
#   FIGMA_MAIN_BRIDGE_PORT     Legacy bridge compatibility port. Default: 1994
#   FIGMA_VARIANT_BRIDGE_PORT  Shared plugin gateway port. Default: 1995
#   FIGMA_GATEWAY_PORT         Shared gateway port. Defaults to FIGMA_VARIANT_BRIDGE_PORT
#   The plugin name is Figma Gateway and the instance is always shared.
#   FIGMA_GATEWAY_SECRET              Secret shared by the plugin and local gateway
#   FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM  Keychain item containing the shared secret
#   FIGMA_GATEWAY_SERVER              Gateway server entrypoint
#   FIGMA_TOKEN_KIND                  oauth / pat / plan
#   FIGMA_TOKEN_KEYCHAIN_ITEM         Keychain item containing the REST credential
#
# config.local.sh is loaded from this directory when present and must remain untracked.

FIGMA_COMMON_SOURCE="${BASH_SOURCE[0]:-$0}"
FIGMA_GATEWAY_DIR="$(cd -- "$(dirname -- "$FIGMA_COMMON_SOURCE")" && pwd)"
FIGMA_CONFIG_FILE="${FIGMA_CONFIG_FILE:-$FIGMA_GATEWAY_DIR/config.local.sh}"

# shellcheck source=/dev/null
[[ -f "$FIGMA_CONFIG_FILE" ]] && source "$FIGMA_CONFIG_FILE"

FIGMA_VARIANT="${FIGMA_VARIANT:-local}"
if [[ ! "$FIGMA_VARIANT" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: FIGMA_VARIANT must start with a lowercase letter and contain only lowercase letters, digits, or hyphens: $FIGMA_VARIANT" >&2
  return 1 2>/dev/null || exit 1
fi

FIGMA_APP="/Applications/Figma.app"
FIGMA_APP_BUNDLE_ID="com.figma.Desktop"
FIGMA_EXPORT_PORT="${FIGMA_EXPORT_PORT:-8473}"
FIGMA_PAT_KEYCHAIN_ITEM="${FIGMA_PAT_KEYCHAIN_ITEM:-figma_pat_${FIGMA_VARIANT}}"
FIGMA_TOKEN_KIND="${FIGMA_TOKEN_KIND:-oauth}"
FIGMA_TOKEN_KEYCHAIN_ITEM="${FIGMA_TOKEN_KEYCHAIN_ITEM:-figma_token_${FIGMA_VARIANT}_${FIGMA_TOKEN_KIND}}"
FIGMA_MAIN_BRIDGE_PORT="${FIGMA_MAIN_BRIDGE_PORT:-1994}"
FIGMA_VARIANT_BRIDGE_PORT="${FIGMA_VARIANT_BRIDGE_PORT:-1995}"
FIGMA_GATEWAY_PORT="${FIGMA_GATEWAY_PORT:-$FIGMA_VARIANT_BRIDGE_PORT}"
FIGMA_GATEWAY_PLUGIN_NAME="Figma Gateway"
FIGMA_GATEWAY_PLUGIN_INSTANCE="shared"
FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM="${FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM:-figma_gateway}"
FIGMA_GATEWAY_SECRET="${FIGMA_GATEWAY_SECRET:-}"
if [[ -z "$FIGMA_GATEWAY_SECRET" ]] && command -v security >/dev/null 2>&1; then
  FIGMA_GATEWAY_SECRET="$(security find-generic-password -w -s "$FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM" 2>/dev/null || true)"
fi
# Read the legacy per-profile item during migration. New installations share figma_gateway.
if [[ -z "$FIGMA_GATEWAY_SECRET" ]] && [[ "$FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM" == "figma_gateway" ]] && command -v security >/dev/null 2>&1; then
  FIGMA_LEGACY_GATEWAY_SECRET_KEYCHAIN_ITEM="figma_gateway_${FIGMA_VARIANT}"
  FIGMA_GATEWAY_SECRET="$(security find-generic-password -w -s "$FIGMA_LEGACY_GATEWAY_SECRET_KEYCHAIN_ITEM" 2>/dev/null || true)"
  if [[ -n "$FIGMA_GATEWAY_SECRET" ]]; then
    FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM="$FIGMA_LEGACY_GATEWAY_SECRET_KEYCHAIN_ITEM"
  fi
  unset FIGMA_LEGACY_GATEWAY_SECRET_KEYCHAIN_ITEM
fi
FIGMA_GATEWAY_SERVER="${FIGMA_GATEWAY_SERVER:-$(cd "$FIGMA_GATEWAY_DIR/.." && pwd)/dist/server/index.js}"

export FIGMA_VARIANT FIGMA_APP FIGMA_APP_BUNDLE_ID
export FIGMA_EXPORT_PORT FIGMA_PAT_KEYCHAIN_ITEM
export FIGMA_TOKEN_KIND FIGMA_TOKEN_KEYCHAIN_ITEM
export FIGMA_MAIN_BRIDGE_PORT FIGMA_VARIANT_BRIDGE_PORT FIGMA_GATEWAY_PORT
export FIGMA_GATEWAY_PLUGIN_NAME FIGMA_GATEWAY_PLUGIN_INSTANCE
export FIGMA_GATEWAY_SECRET FIGMA_GATEWAY_SERVER
export FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM
