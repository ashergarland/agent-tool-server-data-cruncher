# Threat model

Scope: the local Data Cruncher capability, the caller-selected filesystem root, and its two child
processes (`jq` and ripgrep).

## Assets worth protecting

1. Application secrets in the parent process.
2. Files outside the configured data root.
3. The identity of the file opened after confinement checks.
4. Service availability: memory, CPU, process slots, and temporary storage.
5. Caller data: source content, filters, patterns, and results.

## Trust boundaries

| Boundary                 | Assumption                                                               |
| ------------------------ | ------------------------------------------------------------------------ |
| MCP caller to capability | Input is untrusted and validated by the Platform registry.               |
| Capability to child      | Reviewed binaries process untrusted expressions and source content.      |
| Capability to filesystem | Only one selected root is authorized; every requested path is untrusted. |
| Local operator           | Controls the root, binaries, limits, and operating-system permissions.   |

## Threats and mitigations

### Secret exfiltration through jq

jq exposes its process environment through `env` and `$ENV`. Passing the parent environment could
therefore expose API keys, provider credentials, proxy credentials, and future secrets.

Agent Tool Platform `buildChildEnvironment` constructs an allowlist from scratch. It includes only
a restricted executable `PATH`, locale values, lifecycle-scratch `HOME`/temporary values, and on
Windows the OS-root values needed by binaries. It does not inherit application credentials,
`NODE_OPTIONS`, proxy variables, `JQ_*`, or `RIPGREP_CONFIG_PATH`.

The real-jq regression test sets parent credential sentinels, reads both `env` and `$ENV`, and
proves none reaches jq. It also checks the pre-spawn map contains only the intended keys and that
`HOME`/temporary state points to lifecycle scratch.

On Windows, libuv may add a fixed set of operating-system identity variables such as `USERNAME` and
`USERPROFILE` after spawn. They are not application secrets. The supplied environment map remains
the explicit allowlist.

### jq module reads

jq's `import` and `include` directives can select files independently of input stdin, and jq has no
switch that disables module loading. Data Cruncher's capability-owned scanner rejects module
directives before execution while permitting those words in strings, comments, and object fields.
Scratch-scoped `HOME` also prevents loading an operator's normal jq home state.

### Command and argument injection

Platform resolves reviewed executable paths and uses no-shell process spawning. Data Cruncher owns
only fixed jq/ripgrep argument construction. jq receives `--` before a caller filter, ripgrep
receives a pattern through `--regexp`, and no arbitrary-command tool exists.

### Traversal, symlink escape, and replacement races

Platform `RootBoundary.openFile` requires a relative path, enforces lexical and canonical
containment, rejects final and intermediate symlink escapes, requires a regular file, checks the
size snapshot, and verifies opened-descriptor/path identity.

The returned `ConfinedOpenedFile` supplies both the bounded preview and input stream from the same
descriptor. If the addressed path is renamed and replaced after open, the child still reads the
original opened object. Tests prove traversal, absolute paths, directories, size overflow, symlink
escape, and replacement-race stability.

### Path and content disclosure

Caller paths are not present in jq/ripgrep arguments; bytes arrive through stdin. Public readiness
contains fixed contributor names and tool versions, never root or scratch paths. Compile/pattern
errors use bounded sanitized stderr where safe; input/runtime failures do not echo source data.
Telemetry records aggregate byte/token estimates and truncation only.

### Resource exhaustion

Platform supplies a bounded process runner with wall-clock timeout, cancellation, captured stdout
and stderr ceilings, stdin accounting, and child cleanup. Data Cruncher adds file, filter, pattern,
result, match, line, concurrency, and queue limits. ripgrep runs with one thread and an explicit
match limit. jq truncation retains only complete result boundaries.

Inputs are descriptor-streamed rather than buffered. Bounded child output is parsed only after
capture; the capture ceiling bounds parser memory. Tests cover representative multi-megabyte input,
output boundaries, queue saturation, timeout, and cancellation.

### Malformed input

UTF-16/32 byte-order marks and NUL-containing binary previews are rejected. A UTF-8 BOM is skipped.
ripgrep byte payloads are decoded, control characters are sanitized, and lines are clipped with an
explicit flag. jq and ripgrep failures map to deterministic typed errors.

## Non-goals

- A hostile local operator or malicious replacement of configured jq/ripgrep binaries.
- OS-level sandboxing such as seccomp or gVisor.
- Hosted multi-tenant isolation; no hosted profile or hosted data plane is declared.
- Protection for data the operator deliberately places beneath `DATA_ROOT`.
- General analytics, cross-file correlation, arbitrary commands, or semantic inference.

## Reporting

See [`../SECURITY.md`](../SECURITY.md).
