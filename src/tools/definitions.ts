import { badRequest } from '@agent-tool-platform/runtime/errors';
import { defineTool, type AnyToolDefinition } from '@agent-tool-platform/runtime/tools';
import { z } from 'zod';
import { matchCountCeiling, outputBytesCeiling } from '../config/index.js';
import type { DataCruncherServices } from '../services/index.js';

export const dataReferenceSchema = z.strictObject({
  kind: z.literal('local_path'),
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe('Path relative to the configured local data root. Absolute paths are refused.'),
});

const legacyFilePath = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('Deprecated: use source with kind="local_path".');

const sourceField = dataReferenceSchema.optional().describe('The local file to reduce.');

const requireExactlyOneSource = <T extends { source?: unknown; filePath?: unknown }>(
  input: T,
  context: z.RefinementCtx,
): void => {
  if ((input.source === undefined) === (input.filePath === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['source'],
      message: 'Provide exactly one of source or the deprecated filePath',
    });
  }
};

const pathOf = (input: {
  source?: z.infer<typeof dataReferenceSchema> | undefined;
  filePath?: string | undefined;
}): string => {
  if (input.source) return input.source.path;
  if (input.filePath) return input.filePath;
  throw badRequest('Provide exactly one of source or the deprecated filePath');
};

const warningSchema = z
  .array(z.string())
  .describe('Bounded guidance about clamping or truncation.');

const queryJsonJqInputSchema = z
  .strictObject({
    source: sourceField,
    filePath: legacyFilePath,
    filter: z
      .string()
      .min(1)
      .max(100_000)
      .describe('jq filter expression, for example .items[0].id'),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(outputBytesCeiling)
      .optional()
      .describe('Requested result byte budget, clamped to the deployment ceiling.'),
  })
  .superRefine(requireExactlyOneSource);

const queryJsonJqOutputSchema = z.strictObject({
  output: z.string().describe('Compact jq output containing only the requested reduction.'),
  returnedBytes: z.number().int().nonnegative(),
  scannedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: warningSchema,
});

export type QueryJsonJqInput = z.infer<typeof queryJsonJqInputSchema>;
export type QueryJsonJqOutput = z.infer<typeof queryJsonJqOutputSchema>;

export const queryJsonJqTool = defineTool<
  DataCruncherServices,
  typeof queryJsonJqInputSchema,
  typeof queryJsonJqOutputSchema
>({
  name: 'query_json_jq',
  title: 'Query JSON with jq',
  summary: 'Apply a jq filter to a large JSON or JSONL file and return only the filtered result.',
  description:
    'Runs jq against one confined local JSON or JSONL file and returns bounded compact output without loading the full input into model context.',
  kind: 'read',
  routing: {
    useWhen: [
      'projecting a few fields from a large JSON document',
      'filtering, counting, or grouping records in one JSON or JSONL file',
      'reducing structured deployment diagnostics before reasoning about a failure',
    ],
    doNotUseWhen: [
      'the input is unstructured log text, in which case use ripgrep_search',
      'the complete file is small or exact full content is required, in which case use raw or full-file access',
      'the request needs cross-file analytics, joins, plotting, dataframes, arbitrary commands, or semantic inference; use a specialized analytics capability',
    ],
    scope: 'one UTF-8 JSON or JSONL file beneath the configured local data root',
    changesState: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: queryJsonJqInputSchema,
  outputSchema: queryJsonJqOutputSchema,
  handler: (input, services, context) =>
    services.dataCruncher.queryJson(
      pathOf(input),
      { filter: input.filter, maxOutputBytes: input.maxOutputBytes },
      context.signal,
    ),
});

const ripgrepSearchInputSchema = z
  .strictObject({
    source: sourceField,
    filePath: legacyFilePath,
    pattern: z.string().min(1).max(100_000).describe('Regular expression in ripgrep syntax.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(matchCountCeiling)
      .default(100)
      .describe('Requested match count, clamped to the deployment ceiling.'),
  })
  .superRefine(requireExactlyOneSource);

const ripgrepSearchOutputSchema = z.strictObject({
  matches: z.array(
    z.strictObject({
      lineNumber: z.number().int().nonnegative(),
      line: z.string(),
      lineTruncated: z.boolean(),
    }),
  ),
  matchCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  scannedBytes: z.number().int().nonnegative(),
  warnings: warningSchema,
});

export type RipgrepSearchInput = z.infer<typeof ripgrepSearchInputSchema>;
export type RipgrepSearchOutput = z.infer<typeof ripgrepSearchOutputSchema>;

export const ripgrepSearchTool = defineTool<
  DataCruncherServices,
  typeof ripgrepSearchInputSchema,
  typeof ripgrepSearchOutputSchema
>({
  name: 'ripgrep_search',
  title: 'Search a text file with ripgrep',
  summary: 'Find regular-expression matches in a large log or text file.',
  description:
    'Runs ripgrep against one confined local log or text file and returns bounded matching lines in source order with one-based line numbers.',
  kind: 'read',
  routing: {
    useWhen: [
      'finding narrow error, listener, port, readiness, or lifecycle evidence in a large log',
      'preserving the source chronology of matching deployment or runtime observations',
      'locating regular-expression matches without placing the full text file in model context',
    ],
    doNotUseWhen: [
      'structured JSON projection is required, in which case use query_json_jq',
      'the complete file is small or exact surrounding content is required, in which case use raw or full-file access',
      'the request needs cross-file analytics, arbitrary commands, semantic log clustering, or general ETL; use a specialized capability',
    ],
    nextSteps: ['query_json_jq'],
    scope: 'one UTF-8 log or text file beneath the configured local data root',
    changesState: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ripgrepSearchInputSchema,
  outputSchema: ripgrepSearchOutputSchema,
  handler: (input, services, context) =>
    services.dataCruncher.ripgrep(
      pathOf(input),
      { pattern: input.pattern, maxResults: input.maxResults },
      context.signal,
    ),
});

export const capabilityTools: readonly AnyToolDefinition<DataCruncherServices>[] = [
  queryJsonJqTool,
  ripgrepSearchTool,
];
