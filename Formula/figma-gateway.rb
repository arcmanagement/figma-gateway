# typed: strict
# frozen_string_literal: true

# Installs the Figma Gateway CLI, local Plugin builder, and resident daemon.
class FigmaGateway < Formula
  desc "Local CLI gateway for Figma Desktop development plugins"
  homepage "https://github.com/arcmanagement/figma-gateway"
  url "https://github.com/arcmanagement/figma-gateway/releases/download/v1.1.0/figma-gateway-1.1.0.tgz"
  sha256 "2ecbb6173f5f4d7e2d564459ca5594494537d1bfc4f74d4332be87fd301eb2b9"
  license "MIT"

  depends_on "node@22"

  def install
    libexec.install Dir["*"]
    cd libexec do
      system formula_opt_bin("node@22")/"npm", "ci", "--omit=dev", "--ignore-scripts"
    end
    node_path = "#{formula_opt_bin("node@22")}:$PATH"
    (bin/"figma-gateway").write_env_script libexec/"dist/cli/index.js", PATH: node_path
    (bin/"figma-gateway-mcp").write_env_script libexec/"dist/server/index.js", PATH: node_path
  end

  def caveats
    manifest = Pathname.new(Dir.home)/"Library/Application Support/Figma Gateway/plugin/manifest.json"
    dev_manifest = Pathname.new(Dir.home)/"Library/Application Support/Figma Gateway/plugin/dev/manifest.json"
    <<~EOS
      Complete per-user setup once after installation:
        figma-gateway setup

      Import both development plugin manifests once in Figma Desktop:
        Plugins > Development > Import plugin from manifest...
        #{manifest}
        #{dev_manifest}

      Setup registers Figma Gateway as a login service.
    EOS
  end

  test do
    assert_match "figma-gateway", shell_output("#{bin}/figma-gateway --help")
  end
end
