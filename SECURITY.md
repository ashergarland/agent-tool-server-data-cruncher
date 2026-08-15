# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

[docs/threat-model.md](docs/threat-model.md) documents the trust boundaries, the subprocess
isolation rules and the residual risks.

Deployments must enable authentication, store credentials in a secret manager, use least-privilege
provider roles, keep local filesystem access disabled unless it is needed, mount data roots read
only, keep asset containers private with managed identity, and review dependency and container
findings before release.

Two properties are load bearing and must not be weakened:

1. Child processes receive a constructed allowlist environment, and jq filters may not use module
   directives. `jq` can read its environment and can load files named by the program itself, so
   either gap would hand callers application secrets or files outside the requested input.
2. Callers never supply a path to a child process. Input is validated, opened, and streamed to the
   child through stdin.
