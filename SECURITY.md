# Security

## Supported versions

Security updates are provided for the latest release of Figma Gateway.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
through GitHub Security Advisories for this repository. Include the affected
version, reproduction steps, and the expected impact. Do not include Figma
files, credentials, customer data, or other private material unless it is
necessary to reproduce the issue.

## Local security boundary

Figma Gateway listens only on the loopback interface. The daemon, CLI, and
locally built development plugin authenticate with a secret generated for the
current operating-system user. A built plugin contains that local secret and
must not be uploaded, committed, attached to a release, or shared with another
person.

The `plugin/dist` directory is local state. Official release archives contain
the plugin source and build script, but never a built plugin.
