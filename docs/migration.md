# D4 thin-capability migration

The migration changed the integration boundary, not the jq/ripgrep domain engine.

## Preserved capability behavior

- compact jq JSON and JSONL reduction, including `inputs` semantics;
- filters beginning with `-`, UTF-8 BOM handling, and module-directive rejection;
- complete-value jq truncation and typed single-value overflow;
- ripgrep JSON parsing, one-based lines, source chronology, single-threaded bounded search, and
  line clipping;
- minimum jq/ripgrep versions and capability-owned exit-code interpretation;
- deterministic invalid input, tooling, timeout, cancellation, and busy behavior;
- root-relative local files, representative large-file streaming, and benchmark fixtures;
- strong routing guidance for jq, ripgrep, raw access, and unsupported analytics.

## Replaced with Agent Tool Platform

- application assembly, runtime state, startup, shutdown, and stdio MCP;
- HTTP/MCP publication, authentication, OpenAPI, registry validation, telemetry plumbing, and
  shared errors;
- custom subprocess spawning, child-environment filtering, timeout/cancellation, and cleanup;
- custom path resolution, symlink checking, open/read races, and file-size enforcement;
- custom queue and scratch-directory lifecycle;
- generic conformance, metadata/profile validators, package smoke conventions, and common CI,
  security, and release implementation.

Data Cruncher now composes `defineAgentToolCapability`,
`startStdioAgentToolApplication`, `RootBoundary.openFile`, `ConfinedOpenedFile`,
`createScratchWorkspace`, `BoundedQueue`, `buildChildEnvironment`, and `runBoundedProcess`.

## Removed unsupported deployment claims

The former Fastify host, asset-upload stores, Azure Blob adapter, Docker image, and Bicep deployment
described a hosted data plane. They were removed because the migrated capability's operational
path is local package execution over caller-owned files. The v1 profile truthfully declares all
six local filesystem/read-only dimensions and no provider or secret prerequisite.

## Security proof

The most important historical risk was jq's ability to expose inherited secrets through `env` and
`$ENV`. Tests run real jq with sentinels in the parent environment and prove the child receives
only the Platform-constructed minimal map. Scratch supplies `HOME` and temporary state. Module
directives remain blocked by capability policy.

Platform descriptor confinement is tested both through its reusable conformance suite and through
Data Cruncher: replacing the addressed path after open does not replace the bytes streamed to the
child.

## Out of scope

This migration adds no Agent Kit, Agent Builder, Registry implementation, provider mutation, hosted
deployment, M5, M6, or M7 behavior.
