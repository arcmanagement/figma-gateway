# typed: strict
# frozen_string_literal: true

# Installs the Figma Gateway CLI, local Plugin builder, and resident daemon.
class FigmaGateway < Formula
  desc "Local CLI gateway for Figma Desktop development plugins"
  homepage "https://github.com/arcmanagement/figma-gateway"
  url "https://github.com/arcmanagement/figma-gateway/releases/download/v1.1.1/figma-gateway-1.1.1.tgz"
  sha256 "a13461e347e001e9ce6831ab6fe40362cb410403073d0bfe08ad3c6350c8259d"
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
