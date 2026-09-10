# Release process

Figma Gateway is published from a clean public repository. Do not push the
private repository history, existing tags, pull requests, releases, or ignored
local files into the public repository.

## Required repository secrets

- `RELEASE_PROHIBITED_TERMS`: a comma- or newline-separated publication
  denylist containing known customer, project, private-host, and historical
  identifiers. The release fails when this value is missing.

Set the repository variable `PUBLIC_HISTORY_ROOT` to the full 40-character ID
of the reviewed initial public commit. The release fails when another Git root
is reachable or when the value is missing.

## Create the public history

1. Export only the reviewed working tree into a new empty directory. Do not
   copy `.git`, `plugin/dist`, `dist`, `.tmp`, local configuration, archives,
   screenshots, or editor state.
2. Initialize a new Git repository with `main` as its initial branch.
3. Run the source, history, secret, type, test, audit, build, and archive checks.
4. Create one reviewed initial commit. Add only the new public remote.
5. Push `main` only after the repository visibility and organization ownership
   have been verified.

The release workflow scans every reachable commit. It intentionally fails on
the private repository because that history is not a publication source.

## Publish a release

1. Verify that the public `main` commit is descended from the approved public root.
2. Update `package.json` and `npm-shrinkwrap.json` to the intended version.
3. Create the matching `v<version>` tag locally, without pushing it yet. The
   signed build refuses a dirty worktree or a HEAD without this exact tag.
4. On the trusted Apple Silicon maintainer Mac, build the Developer ID signed
   and notarized arm64 and x64 macOS archives:

   ```bash
   VERSION=<version> \
   SIGN_IDENTITY="A0F2E0F22F8EA30B783A8DCBB2397B852C780062" \
   NOTARY_PROFILE="abg-notary" \
   npm run dist:macos
   ```

5. Push the verified tag.
6. Wait for both Windows installer jobs and the draft release job to finish.
7. Upload the locally signed artifacts and generated Cask to the draft release:

   ```bash
   gh release upload "v<version>" \
     artifacts/macos/figma-gateway-<version>-macos-arm64.zip \
     artifacts/macos/figma-gateway-<version>-macos-arm64.zip.sha256.txt \
     artifacts/macos/figma-gateway-<version>-macos-x64.zip \
     artifacts/macos/figma-gateway-<version>-macos-x64.zip.sha256.txt \
     artifacts/macos/FigmaGatewayCask.rb
   ```

8. Run the `Publish verified release` workflow for the tag. This is the supported
   publication path: it regenerates and exactly compares the Formula and Cask,
   verifies every required asset and both macOS checksums, rejects AppleDouble
   metadata, and checks both apps for the ArcManagement Developer ID signature,
   stapled notarization ticket, and Gatekeeper acceptance. It commits the verified
   Formula and Cask to `main` before publishing the draft. Do not publish from the
   GitHub UI; no release-event workflow updates Homebrew metadata.
9. Test the Cask on a clean macOS account and both Windows installers on their
   matching architectures.

The GitHub Release publishes unsigned x64 and ARM64 Windows installers. WinGet
distribution is outside the current scope because releases do not have the
required code-signing certificate.

## Update the Homebrew Formula

The public `arcmanagement/figma-gateway` repository is also the Homebrew tap;
do not create a separate `arcmanagement/homebrew-tap` repository. The release
workflow generates `Formula/figma-gateway.rb` from the exact release archive
and attaches it to the draft release. The trusted Mac build generates
`FigmaGatewayCask.rb` from the notarized archives. Publishing the release commits
both files back to public `main`. Confirm that the metadata workflow succeeds,
then run `brew style` and `brew audit --strict` against the committed Formula and
Cask.

Test the exact public repository as a custom-URL tap:

```bash
brew tap arcmanagement/figma-gateway https://github.com/arcmanagement/figma-gateway.git
brew trust --cask arcmanagement/figma-gateway/figma-gateway
brew install --cask arcmanagement/figma-gateway/figma-gateway
```

## Destructive cleanup

Delete the private repository only after the public repository, GitHub release,
Homebrew installation from that same repository, both Windows installers, and
clean-history checks have all been verified. Keep a recoverable private archive
until those checks pass.
