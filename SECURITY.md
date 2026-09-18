# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

[`docs/threat-model.md`](docs/threat-model.md) documents the local filesystem, child process, and
resource boundaries.

Two properties must not be weakened:

1. jq and ripgrep receive an environment constructed from an allowlist, with lifecycle scratch for
   `HOME` and temporary state. jq module directives remain refused.
2. Caller paths never reach a child process. Platform confines and opens the file, and Data Cruncher
   streams that descriptor through stdin.

Operators should expose only the intended read-only data root, use reviewed jq/ripgrep binaries,
keep limits bounded, and review dependency findings before release. This repository does not
declare a hosted or multi-tenant deployment profile.
