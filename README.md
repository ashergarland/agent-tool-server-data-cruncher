# Agent Tool Server Data Cruncher

An MCP and HTTP tool server that keeps giant JSON payloads and logs out of an agent's context.
It executes `jq` and Ripgrep locally and returns only the requested results.

## Tools

### `query_json_jq`

Applies a jq filter to a JSON file.

- `filePath`: absolute path or path relative to `DATA_ROOT`
- `filter`: jq filter expression
- Returns compact jq output as text

### `ripgrep_search`

Searches a text file with a Ripgrep regular expression.

- `filePath`: absolute path or path relative to `DATA_ROOT`
- `pattern`: regular expression
- `maxResults`: result limit from 1 to 1000; defaults to 100
- Returns matching lines and their one-based line numbers

Both tools only accept regular files whose resolved paths are inside `DATA_ROOT`. Commands are
executed without a shell, time out after 15 seconds, and cap captured output at 1 MiB.

## Transports

| Method            | Path                | Authentication | Purpose               |
| ----------------- | ------------------- | -------------- | --------------------- |
| `GET`             | `/health`           | Public         | Liveness/readiness    |
| `GET`             | `/version`          | Public         | Build metadata        |
| `GET`             | `/openapi.json`     | Public         | Generated OpenAPI 3.1 |
| `GET`             | `/tools`            | Required       | Tool catalogue        |
| `POST`            | `/tools/{toolName}` | Required       | Invoke a tool         |
| `GET/POST/DELETE` | `/mcp`              | Required       | Streamable HTTP MCP   |

The same typed registry supplies stdio MCP, Streamable HTTP MCP, and HTTP/OpenAPI.

## Requirements

- Node.js 22
- `jq`
- Ripgrep (`rg`)

The runtime container includes both command-line utilities.

## Start locally

```bash
npm ci
cp .env.example .env
npm run dev
```

Set `DATA_ROOT` to the directory containing files that agents may query. In production,
`AUTH_MODE=api-key` and at least one 32-character `API_KEYS` value are required.

Build and run stdio MCP:

```bash
npm run build
DATA_ROOT=/path/to/data npm run mcp:stdio
```

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
```

## License

MIT
