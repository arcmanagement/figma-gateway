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

## Publish v1.0.0

1. Verify that the public `main` commit is the intended clean initial commit.
2. Create and push the matching `v1.0.0` tag.
3. Wait for both Windows installer jobs and the release job to finish.
4. Test the macOS package on a clean user account and both Windows installers
   on their matching architectures.

The GitHub Release publishes unsigned x64 and ARM64 Windows installers. WinGet
distribution is outside the v1.0.0 scope because this release does not have the
required code-signing certificate.

## Update the Homebrew Formula

The public `arcmanagement/figma-gateway` repository is also the Homebrew tap;
do not create a separate `arcmanagement/homebrew-tap` repository. The release
workflow generates `Formula/figma-gateway.rb` from the exact release archive,
attaches it to the release, and commits it back to public `main`. Confirm that
the Formula update job succeeds, then run `brew style` and `brew audit
--strict` against the committed Formula.

Test the exact public repository as a custom-URL tap:

```bash
brew tap arcmanagement/figma-gateway https://github.com/arcmanagement/figma-gateway.git
brew install arcmanagement/figma-gateway/figma-gateway
```

## Destructive cleanup

Delete the private repository only after the public repository, GitHub release,
Homebrew installation from that same repository, both Windows installers, and
clean-history checks have all been verified. Keep a recoverable private archive
until those checks pass.
