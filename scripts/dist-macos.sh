#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
NODE_VERSION="22.23.2"
NODE_SHA256_ARM64="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
NODE_SHA256_X64="58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"
DIST_DIR="$ROOT/artifacts/macos"
MACOS_ARCHES="${MACOS_ARCHES:-arm64 x64}"

if [[ -z "$VERSION" ]]; then
  echo "VERSION is required" >&2
  exit 1
fi
if [[ "$VERSION" != "$(node -p 'require("./package.json").version')" ]]; then
  echo "VERSION must match package.json" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "The macOS release must be built from a clean worktree" >&2
  exit 1
fi
if [[ "$(git describe --tags --exact-match HEAD 2>/dev/null || true)" != "v$VERSION" ]]; then
  echo "HEAD must have the exact release tag v$VERSION" >&2
  exit 1
fi
if [[ -z "$SIGN_IDENTITY" || -z "$NOTARY_PROFILE" ]]; then
  echo "SIGN_IDENTITY and NOTARY_PROFILE are required for public macOS artifacts" >&2
  exit 1
fi
if ! security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  echo "Developer ID Application identity is unavailable: $SIGN_IDENTITY" >&2
  exit 1
fi
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "notarytool Keychain profile is unavailable: $NOTARY_PROFILE" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
if [[ -d "$ROOT/dist" ]]; then
  find "$ROOT/dist" -mindepth 1 -depth -delete
  rmdir "$ROOT/dist"
fi
npm run build:server

work_dir="$(mktemp -d -t figma-gateway-macos.XXXXXX)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

package_archive="$(npm pack --json --pack-destination "$work_dir" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input)[0].filename));
')"

for arch in $MACOS_ARCHES; do
  app="$work_dir/$arch/Figma Gateway.app"
  contents="$app/Contents"
  macos="$contents/MacOS"
  resources="$contents/Resources"
  application="$resources/app"
  runtime="$resources/runtime"
  node_archive="node-v$NODE_VERSION-darwin-$arch.tar.gz"
  case "$arch" in
    arm64)
      node_sha="$NODE_SHA256_ARM64"
      swift_arch="arm64"
      ;;
    x64)
      node_sha="$NODE_SHA256_X64"
      swift_arch="x86_64"
      ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  output="$DIST_DIR/figma-gateway-$VERSION-macos-$arch.zip"

  mkdir -p "$macos" "$application" "$runtime"
  sed "s/__VERSION__/$VERSION/g" packaging/macos/Info.plist.template >"$contents/Info.plist"
  tar -xzf "$work_dir/$package_archive" -C "$application" --strip-components=1
  npm ci --omit=dev --ignore-scripts --os=darwin --cpu="$arch" --prefix "$application"

  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/$node_archive" \
    --output "$work_dir/$node_archive"
  printf '%s  %s\n' "$node_sha" "$work_dir/$node_archive" | shasum -a 256 -c -
  tar -xzf "$work_dir/$node_archive" -C "$runtime" --strip-components=1

  launcher="$work_dir/$arch/figma-gateway-launcher"
  xcrun swiftc -O -target "$swift_arch-apple-macos13.0" \
    packaging/macos/FigmaGatewayLauncher.swift \
    -o "$launcher"

  codesign --force --options runtime --timestamp \
    --entitlements packaging/macos/Node.entitlements \
    --sign "$SIGN_IDENTITY" \
    "$runtime/bin/node"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    "$application/node_modules/@esbuild/darwin-$arch/bin/esbuild"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$launcher"
  for executable in FigmaGateway figma-gateway figma-gateway-mcp; do
    cp "$launcher" "$macos/$executable"
  done
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"

  codesign --verify --deep --strict --verbose=2 "$app"
  ditto -c -k --norsrc --keepParent "$app" "$output"
  if zipinfo -1 "$output" | grep -Eq '(^|/)\._|^__MACOSX/'; then
    echo "macOS archive contains AppleDouble metadata: $output" >&2
    exit 1
  fi
  xcrun notarytool submit "$output" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=4 "$app"

  rm -f "$output"
  ditto -c -k --norsrc --keepParent "$app" "$output"
  if zipinfo -1 "$output" | grep -Eq '(^|/)\._|^__MACOSX/'; then
    echo "macOS archive contains AppleDouble metadata: $output" >&2
    exit 1
  fi
  (
    cd "$DIST_DIR"
    shasum -a 256 "$(basename "$output")" >"$(basename "$output").sha256.txt"
  )
done

for required_arch in arm64 x64; do
  if [[ ! -f "$DIST_DIR/figma-gateway-$VERSION-macos-$required_arch.zip" ]]; then
    echo "Missing signed macOS archive: $required_arch" >&2
    exit 1
  fi
done

node scripts/render-release-metadata.mjs cask \
  "$DIST_DIR/figma-gateway-$VERSION-macos-arm64.zip" \
  "$DIST_DIR/figma-gateway-$VERSION-macos-x64.zip" \
  "$DIST_DIR/FigmaGatewayCask.rb"

echo "Signed and notarized macOS artifacts are ready in $DIST_DIR"
