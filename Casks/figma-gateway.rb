# typed: strict
# frozen_string_literal: true

cask "figma-gateway" do
  arch arm: "arm64", intel: "x64"

  version "1.3.0"
  sha256 arm:   "5c12a53f862022028f2f18b41c8981d6c7e79053cd7989a2410bd3ec1daf0600",
         intel: "bd294facc5c2c4d937fc0bb86477a03f45f9c7e280d11eecdaa9878e56104cb7"

  url "https://github.com/arcmanagement/figma-gateway/releases/download/v#{version}/figma-gateway-#{version}-macos-#{arch}.zip"
  name "Figma Gateway"
  desc "Developer ID signed local CLI gateway for Figma Desktop plugins"
  homepage "https://github.com/arcmanagement/figma-gateway"

  depends_on macos: :ventura

  app "Figma Gateway.app"
  binary "#{appdir}/Figma Gateway.app/Contents/MacOS/figma-gateway"
  binary "#{appdir}/Figma Gateway.app/Contents/MacOS/figma-gateway-mcp"

  # The user Keychain and launchd domain are unavailable inside the Cask sandbox.
  postflight_steps do
    run "Figma Gateway.app/Contents/MacOS/figma-gateway",
        args: ["setup"],
        base: :appdir,
        sudo: :if_needed
  end

  uninstall_preflight_steps do
    run "Figma Gateway.app/Contents/MacOS/figma-gateway",
        args:         ["daemon", "uninstall", "--confirm"],
        base:         :appdir,
        must_succeed: false,
        sudo:         :if_needed
  end

  zap trash: [
    "~/Library/Application Support/Figma Gateway",
    "~/Library/LaunchAgents/jp.co.arcm.FigmaGateway.plist",
    "~/Library/Logs/figma-gateway.log",
  ]

  caveats <<~EOS
    Import both development plugin manifests once in Figma Desktop:
      Plugins > Development > Import plugin from manifest...
      ~/Library/Application Support/Figma Gateway/plugin/manifest.json
      ~/Library/Application Support/Figma Gateway/plugin/dev/manifest.json
  EOS
end
