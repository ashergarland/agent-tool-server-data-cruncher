# Agent Tool Server Data Cruncher

A context-reduction tool server. It runs `jq` and ripgrep on the server and returns only the small
result an agent asked for, so giant JSON, JSONL and log files never enter model context.

It deliberately does one narrow job. There is no plotting, no dataframes, no general ETL, no
arbitrary command execution and no shell.

## Tools

Both tools are read-only and reachable from every transport through one validated registry.

### `query_json_jq`

Applies a jq filter to a JSON or JSONL file.

| Field            | Required | Description                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------------- |
| `source`         | yes\*    | `{ "kind": "local_path", "path": "…" }` or `{ "kind": "asset", "assetId": "…" }` |
| `filePath`       | no       | Deprecated alias for a local path                                                |
| `filter`         | yes      | jq filter expression                                                             |
| `maxOutputBytes` | no       | Byte budget for the result; the server caps it                                   |

Returns `output`, `returnedBytes`, `truncated` and `warnings`. Output stops at a byte budget that
defaults well below the hard maximum. Truncation always happens on a value boundary and is
reported; when a single value cannot be truncated safely the call fails with `output_limit`.

### `ripgrep_search`

Searches a text or log file with a regular expression.

| Field        | Required | Description                             |
| ------------ | -------- | --------------------------------------- |
| `source`     | yes\*    | Same data reference as above            |
| `filePath`   | no       | Deprecated alias for a local path       |
| `pattern`    | yes      | ripgrep regular expression              |
| `maxResults` | no       | Maximum matches to return (default 100) |

Returns `matches` (one-based `lineNumber`, `line`, `lineTruncated`), `matchCount`, `truncated`,
`scannedBytes` and `warnings`.

\* Provide exactly one of `source` or the deprecated `filePath`.

### When to use them

- jq for precise fields, projections, counts, grouping and filtering in large JSON or JSONL.
- ripgrep for regular-expression search in logs and large text files.
- Always ask for a narrow filter or pattern and a small result limit.
- Call this server **before** attaching or pasting a large file into native model context.
- Do not use it for images, arbitrary code execution, multi-file analytics, plotting or dataframes,
  or when the complete small input is already in context.

## Data references

| Kind         | Use                | Notes                                                                    |
| ------------ | ------------------ | ------------------------------------------------------------------------ |
| `local_path` | Local deployments  | Must resolve inside a configured root; disabled by default in production |
| `asset`      | Hosted deployments | Upload the bytes first, then reference the returned opaque id            |

Base64 payloads, data URLs, arbitrary or Blob/SAS URLs and caller-selected storage paths are
rejected by design.

## Transports and endpoints

| Method            | Path                | Auth     | Purpose                                               |
| ----------------- | ------------------- | -------- | ----------------------------------------------------- |
| `GET`             | `/health`           | Public   | Liveness                                              |
| `GET`             | `/ready`            | Public   | Readiness (config, jq/rg, scratch space, asset store) |
| `GET`             | `/version`          | Public   | Build metadata and tool versions                      |
| `GET`             | `/openapi.json`     | Public   | Generated OpenAPI 3.1                                 |
| `GET`             | `/tools`            | Required | Tool catalogue with JSON Schemas                      |
| `POST`            | `/tools/{toolName}` | Required | Invoke a tool                                         |
| `GET/POST/DELETE` | `/mcp`              | Required | Stateless Streamable HTTP MCP                         |
| `POST`            | `/assets`           | Required | Stream an upload, receive an asset id                 |
| `GET`             | `/assets`           | Required | List your unexpired assets                            |
| `GET`             | `/assets/{assetId}` | Required | Asset metadata (never the bytes)                      |
| `DELETE`          | `/assets/{assetId}` | Required | Delete your asset                                     |

stdio MCP is available through `npm run mcp:stdio`.

## Requirements

- Node.js 22
- `jq` 1.7 or newer
- ripgrep 14 or newer

The container image includes both and fails the build if either is older. `/version` reports the
versions actually in use.

## Install and run locally

This server is not published to npm. Clone and build it:

```bash
git clone https://github.com/ashergarland/agent-tool-server-data-cruncher.git
cd agent-tool-server-data-cruncher
npm ci
cp .env.example .env
npm run dev
```

Point `DATA_ROOT` (or `DATA_ROOTS`) at the directory holding the files agents may query. In
production, `AUTH_MODE=api-key` with at least one 32-character key is required, and local paths
must be enabled explicitly with absolute roots.

Query a local file:

```bash
curl -s -X POST http://localhost:8080/tools/query_json_jq \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"source":{"kind":"local_path","path":"orders.json"},"filter":".orders | length"}'
```

### stdio MCP client

```bash
npm run build
DATA_ROOT=/path/to/data npm run mcp:stdio
```

Client configuration:

```json
{
  "mcpServers": {
    "data-cruncher": {
      "command": "node",
      "args": ["/absolute/path/to/agent-tool-server-data-cruncher/dist/mcp/stdio.js"],
      "env": { "DATA_ROOT": "/absolute/path/to/data" }
    }
  }
}
```

### Hosted client

```json
{
  "mcpServers": {
    "data-cruncher": {
      "url": "https://<your-deployment>/mcp",
      "headers": { "Authorization": "Bearer <api key>" }
    }
  }
}
```

## Hosted flow with assets

```bash
# 1. upload the bytes (streamed; never inside a JSON tool request)
ASSET=$(curl -s -X POST https://<host>/assets \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -H 'x-filename: orders.json' \
  --data-binary @orders.json | jq -r .asset.assetId)

# 2. query it
curl -s -X POST https://<host>/tools/query_json_jq \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d "{\"source\":{\"kind\":\"asset\",\"assetId\":\"$ASSET\"},\"filter\":\".orders[0].id\"}"

# 3. delete it when finished
curl -s -X DELETE "https://<host>/assets/$ASSET" -H "Authorization: Bearer $API_KEY"
```

Assets are private, owned by the uploading principal, quota-bounded and deleted automatically when
their TTL expires (24 hours by default). Storage containers are private, use managed identity, and
never issue public URLs or SAS tokens. Uploaded bytes are only read to answer your own tool calls,
and neither storage paths nor temporary paths are ever returned.

## Limits and behaviour

| Setting                 | Default | Meaning                                     |
| ----------------------- | ------- | ------------------------------------------- |
| `MAX_FILE_BYTES`        | 64 MiB  | Largest accepted input                      |
| `SUBPROCESS_TIMEOUT_MS` | 15000   | Wall-clock limit for one execution          |
| `DEFAULT_OUTPUT_BYTES`  | 128 KiB | Default jq output budget                    |
| `MAX_OUTPUT_BYTES`      | 1 MiB   | Hard output ceiling                         |
| `MAX_MATCHES`           | 1000    | Ceiling for `maxResults`                    |
| `MAX_LINE_LENGTH`       | 2000    | Returned lines are clipped and flagged      |
| `TOOL_CONCURRENCY`      | 2       | Concurrent jq/ripgrep executions            |
| `TOOL_QUEUE_LIMIT`      | 32      | Queued executions before a retryable `busy` |

Semantics worth knowing:

- jq runs with `--compact-output`; JSONL is handled natively, so `inputs` sees every record.
- ripgrep is line oriented, one file per call, with `--max-count` applied per call.
- Input must be UTF-8. A UTF-8 BOM is skipped; UTF-16/32 and binary input are rejected.
- Errors use one envelope (`code`, `message`, `retryable`, `requestId`) across every transport.
  jq runtime errors never echo stderr because it can contain your data.

`.env.example` documents every setting.

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
docker build -t agent-tool-server-data-cruncher .
az bicep build --file infra/main.bicep
```

Tests use temporary fixtures and fake asset stores; no Azure account or network access is needed.

## Deployment

See [docs/deployment.md](docs/deployment.md) for the Azure Container Apps example, per-fork OIDC
setup and immutable image releases, and [docs/threat-model.md](docs/threat-model.md) for the trust
boundaries, the subprocess isolation rules and the residual risks.

## Troubleshooting

| Symptom                       | Cause and fix                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `/ready` returns 503          | jq or ripgrep missing, temp dir not writable, or asset store unreachable. Check container logs. |
| `forbidden` on a local path   | Local paths are disabled or the path resolves outside every root.                               |
| `busy` with `retryable: true` | Tool queue saturated; retry after a short delay or scale out.                                   |
| `output_limit`                | One jq value exceeded the budget; narrow the filter.                                            |
| `truncated: true`             | Expected: narrow the filter/pattern or raise the limit slightly.                                |
| First hosted call is slow     | Scale-to-zero cold start; set `minReplicas: 1` to avoid it.                                     |

Cost and scale: the deployment scales to zero by default, so idle cost is limited to storage, logs
and the registry. Each replica runs at most `TOOL_CONCURRENCY` jq/ripgrep processes, so size CPU and
memory for the largest input you accept rather than for request count.

## Implemented and not implemented

Implemented: jq querying, ripgrep search, local paths and hosted assets, bounded execution,
API-key authentication with rate limiting, three transports from one registry, Azure deployment.

Not implemented and out of scope: plotting, dataframes, general ETL, arbitrary code or shell
execution, multi-file or cross-file analytics, image handling, and writing to any input file.

## License

MIT
