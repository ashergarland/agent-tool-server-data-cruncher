# Threat model

Scope: the Data Cruncher tool server, its two child processes (`jq`, ripgrep), local file access,
hosted asset storage, and the three transports that expose the same registry.

## Assets worth protecting

1. Application secrets in the server process (API keys, Azure credentials, connection strings).
2. Files outside the configured data roots on the host.
3. Other principals' uploaded assets.
4. Service availability (CPU, memory, disk, process slots).
5. Caller data confidentiality: file contents, filters, patterns and results.

## Trust boundaries

| Boundary                  | Assumption                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Network client → server   | Untrusted. Authenticated by API key, rate limited before and after authentication.   |
| Server → child process    | Children are trusted binaries but process untrusted input and untrusted expressions. |
| Server → local filesystem | Only paths contained by configured roots, opened as regular files.                   |
| Server → asset storage    | Private container, managed identity, per-principal key prefix.                       |
| Deployment operator       | Trusted. Controls configuration, roots, quotas and limits.                           |

## Threats and mitigations

### Secret exfiltration and file reads through jq

A caller controls the jq program, and jq gives programs two ways to reach outside their input.
`env`/`$ENV` expose the process environment, and the module system (`import "x" as $v {search:
"/dir"};`, `include "x";`) reads files chosen by the program text — the `search` metadata overrides
`HOME` and the default search path, so a filter alone could read any `.json` or `.jq` file the
process can open, bypassing every data-root and asset check.

Mitigation: children never inherit the parent environment. `buildChildEnvironment` constructs an
allowlist from scratch containing only `PATH` (restricted to the directories of the resolved
binaries), `LANG`/`LC_ALL`, and an isolated `HOME`/`TMPDIR`. `RIPGREP_CONFIG_PATH`, `JQ_*`,
`NODE_OPTIONS`, proxy variables and every credential are absent by construction. `HOME` points at an
empty scratch directory so `~/.jq` modules cannot be loaded. jq has no flag that disables module
loading, so `assertNoModuleDirectives` rejects `import`/`include` directives before execution; the
scan skips comments and string literals so fields and variables with those names still work. Tests
assert that a sentinel secret in the parent process is invisible to `env`, `$ENV` and to a real
child, and that a module directive cannot return the contents of a file outside the data root.

Platform note: on Windows, libuv copies a fixed list of operating-system variables (`USERNAME`,
`USERPROFILE`, `HOMEDRIVE` and similar) into every child regardless of the environment supplied.
None of them is an application secret, and the supported production platform is Linux, where the
allowlist is exact.

### Command and argument injection

Mitigation: `execFile`/`spawn` without a shell, executables resolved to absolute paths at startup
and verified by a version probe, `--` before caller-controlled positional input, and patterns passed
through `--regexp` so a leading dash cannot become a flag. No caller value is ever concatenated into
a command line.

### Path traversal, symlink escape and check/use races

Mitigation: paths are resolved with `realpath`, required to be contained by a configured root
(equality with the root itself is rejected), opened with `O_NOFOLLOW` where available, and verified
through the open handle (regular file, size, matching device and inode). The **file handle** is what
gets streamed to the child, so the validated file is the file that is read. Local paths are disabled
by default in production and hosted roots are expected to be mounted read only.

Residual risk: on platforms without `O_NOFOLLOW` the window between `realpath` and `open` is only
narrowed, not eliminated. Keep data roots off world-writable directories.

### Path disclosure

Mitigation: no caller-controlled path reaches the child's argument vector, because input arrives on
stdin. jq runtime and parse errors never echo stderr, since it can contain fragments of the data.
Compile-error and pattern-error messages, which describe caller-supplied expressions, are sanitised:
absolute paths are replaced, control characters removed, and the text is truncated.

### Resource exhaustion

Mitigation: maximum input size, subprocess wall-clock timeout, captured-output cap, per-line and
per-match caps, a bounded line splitter that discards oversized lines instead of buffering them,
bounded stderr, a bounded concurrency queue with a typed retryable `busy` error, cancellation on
client disconnect, and `SIGTERM` then `SIGKILL` for children that ignore termination. Ripgrep runs
single threaded, and searches stop as soon as enough matches are collected.

### Cross-principal asset access

Mitigation: opaque random asset ids, storage keys prefixed by a hash of the principal, ownership
checked on every read, delete and materialisation, and "not yours" reported identically to "does not
exist" to avoid an existence oracle. Per-principal count and byte quotas, a TTL enforced by the
server and by a storage lifecycle rule, materialisation to unpredictable temporary filenames, and
removal in a `finally` block. Containers are private; no SAS token or public URL is ever issued.

### Credential attacks

Mitigation: API keys must be at least 32 characters. Authentication compares fixed-width HMAC
digests with `timingSafeEqual`, so neither key length nor an early mismatch is observable. A
pre-authentication limit bounds unauthenticated abuse by address; an authenticated limit bounds each
principal. Authentication can only be disabled outside production.

### Data leakage through logs

Mitigation: logs carry request ids, tool names, durations, byte counts and queue depth only. File
contents, filters, patterns, matches, jq output, credentials, storage paths, temporary paths and raw
child stderr are never logged. Authorization and API key headers are redacted by the logger.

### Malformed or hostile input

Mitigation: UTF-16/32 byte order marks and binary content are rejected before execution, a UTF-8 BOM
is skipped, ripgrep line text that is not valid UTF-8 is decoded from the reported bytes, control
characters are replaced, and every returned line is clipped and flagged.

## Non-goals

Sandboxing beyond process isolation (no seccomp or gVisor), multi-tenant isolation stronger than
per-principal namespacing, protection against a malicious deployment operator, and protection of
data that the operator deliberately places inside a configured data root.

## Reporting

See [SECURITY.md](../SECURITY.md).
