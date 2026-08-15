/**
 * Routing guidance shared by tool descriptions, MCP server instructions and the OpenAPI document.
 * Agents pick tools from this text, so it states the narrow job of this server and the cases where
 * it must not be used.
 */

export const serverPurpose =
  'Data Cruncher keeps large JSON, JSONL and log files out of model context by running jq and ripgrep server-side and returning only the small result an agent asked for.';

export const jqRouting = [
  'Use this tool for precise field access, projections, counts, grouping and filtering inside large JSON or JSONL.',
  'Ask the caller for a narrow jq filter and keep the result small; request only the fields that are needed.',
  'Do not use it for images, arbitrary code execution, multi-file analytics, plotting or dataframes.',
  'Do not use it when the complete input is small and already present in context.',
].join(' ');

export const ripgrepRouting = [
  'Use this tool for regular-expression search in logs and other large text files.',
  'Ask the caller for a narrow pattern and a small result limit rather than broad patterns.',
  'Do not use it for images, arbitrary code execution, multi-file analytics or structured JSON projection; use query_json_jq for JSON.',
  'Do not use it when the complete input is small and already present in context.',
].join(' ');

export const serverInstructions = [
  serverPurpose,
  '',
  'Routing:',
  '- query_json_jq: precise fields, projections, counts, grouping and filtering in large JSON or JSONL.',
  '- ripgrep_search: regular-expression search in logs and large text files.',
  '- Always ask for a narrow filter or pattern and a small result limit.',
  '- Call Data Cruncher before attaching or pasting a large file into native model context.',
  '',
  'Do not use these tools for images, arbitrary code execution, shell commands, multi-file analytics,',
  'plotting, dataframes or general ETL, and skip them when the complete small input is already in context.',
  '',
  'Inputs are referenced by { "kind": "local_path", "path": "..." } on local deployments or',
  '{ "kind": "asset", "assetId": "..." } after uploading to POST /assets on hosted deployments.',
  'Results are bounded: check "truncated" and "warnings" and narrow the request instead of retrying blindly.',
].join('\n');
