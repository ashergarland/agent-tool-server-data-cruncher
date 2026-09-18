# Deployment profiles

The canonical public declaration is
[`../capability-profiles.json`](../capability-profiles.json). It uses Agent Tool Platform
deployment contract v1 at revision `98ec8162fb11d5c04aee9e6f7b3625a472a0180d`.

## Local filesystem profile

Data Cruncher declares only `local-package`:

| Dimension | Value           | Consequence                                                    |
| --------- | --------------- | -------------------------------------------------------------- |
| execution | `local`         | The invoking machine runs the process.                         |
| delivery  | `package`       | npm supplies the built artifact.                               |
| access    | `local-process` | The caller owns the stdio pipe.                                |
| workload  | `filesystem`    | One explicitly selected local root supplies caller-owned data. |
| provider  | `none`          | No external provider prerequisite exists.                      |
| mutation  | `read-only`     | Source files and external state are not changed.               |

The filesystem workload declaration identifies:

- the root-relative path interface documented in the README;
- authorization limited to regular files beneath the selected root;
- per-invocation open/close behavior and session-scoped scratch cleanup;
- deterministic not-ready state when the root or jq/ripgrep toolchain is unavailable.

No cloud infrastructure, HTTP listener, container, external secret, provider configuration, or
operator deployment instance is required or promised.

## Add another profile only when operational

A future hosted capability needs a real workload ingestion or mounted-data path, authentication,
artifact publication, provider prerequisites, readiness proof, and operator contract. It must be a
separate truthful profile; it must not weaken or overload the local profile.

Public profile declarations describe supported shapes only. Environment selection, immutable
declaration/source pins, private parameter references, secret references, rollback intent, and
operator-specific desired state belong in private operator Git. Secret values and observed
deployment evidence belong in their provider systems.

The full contract is maintained in
[Agent Tool Platform](https://github.com/ashergarland/agent-tool-platform/blob/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/docs/deployment-contracts.md).
