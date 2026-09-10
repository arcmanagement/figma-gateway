# typed: strict
# frozen_string_literal: true

cask "figma-gateway" do
  arch arm: "arm64", intel: "x64"

  version "1.2.0"
  sha256 arm:   "5ea40f3917926aebc3e473d75d6da89dccca7e1d3c9da2bd83dbd05f0596c708",
         intel: "0bd7c26000615bade5a3ed26505fcffecd66deb5f5f2b5685007af3fb770f6e2"

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
