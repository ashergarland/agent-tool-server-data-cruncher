# Contributing

Use Node.js 22 and install with `npm ci`. `jq` and ripgrep must be on `PATH` to run the tests.

Keep process execution out of transports and every exposed tool in the shared typed registry. Child
processes must keep receiving a constructed allowlist environment and must keep receiving their
input on stdin rather than as a path argument; both properties are covered by tests and documented
in `docs/threat-model.md`.

Tests must cover validation, path containment, execution limits, asset isolation, command failures
and the generated transport surfaces. Use temporary fixtures and fake asset stores; tests must never
require Azure or network access.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, deployment outputs, credentials, tenant/subscription identifiers, uploaded assets, data
fixtures containing secrets, or generated secrets.
