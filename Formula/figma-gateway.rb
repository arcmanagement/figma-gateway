# typed: strict
# frozen_string_literal: true

# Installs the Figma Gateway CLI, local Plugin builder, and resident daemon.
class FigmaGateway < Formula
  desc "Local CLI gateway for Figma Desktop development plugins"
  homepage "https://github.com/arcmanagement/figma-gateway"
  url "https://github.com/arcmanagement/figma-gateway/releases/download/v1.0.0/figma-gateway-1.0.0.tgz"
  sha256 "5233efd3384643cecc6573c40d7fe8cce2d99b1aa67001fc3d52ecde251a4292"
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

  post_install_steps do
    run "figma-gateway", args: ["setup"], base: :bin, print_stdout: true
  end

  def caveats
    manifest = Pathname.new(Dir.home)/"Library/Application Support/Figma Gateway/plugin/manifest.json"
    <<~EOS
      Import this development plugin once in Figma Desktop:
        Plugins > Development > Import plugin from manifest...
        #{manifest}

      Figma Gateway is already registered as a login service.
    EOS
  end

  test do
    assert_match "figma-gateway", shell_output("#{bin}/figma-gateway --help")
  end
end
