# Contributing

Use Node.js 22 or newer. jq 1.7+ and ripgrep 14+ must be available on `PATH` for domain and package
tests.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run metadata:validate
npm run package:smoke
```

Keep the capability narrow. Tool schemas, routing, jq/ripgrep policy, and domain parsing belong
here. Application assembly, transports, auth, lifecycle, generic process/filesystem safety,
metadata validation, and release mechanics belong to Agent Tool Platform.

Two security properties are load bearing:

1. Children receive Platform's constructed allowlist environment and lifecycle scratch; never pass
   `process.env` or a filtered copy to jq or ripgrep.
2. Caller paths are confined and opened through `RootBoundary.openFile`; stream the returned
   descriptor to stdin and never pass or reopen the path in a child.

Keep regression coverage for `env`/`$ENV`, jq module directives, traversal/symlink escapes,
descriptor replacement races, output/time/queue bounds, representative large files, and the
Hackathon benchmark fixture.

Before contributing, run the full validation sequence in the README. Never commit credentials,
tenant/subscription identifiers, private data, generated secrets, local `.env` files, or operator
deployment state.
