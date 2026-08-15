import { z } from 'zod';
import { matchCountCeiling, outputBytesCeiling } from '../config/index.js';
import { badRequest } from '../errors.js';
import type { DataReference } from '../services/data-cruncher.js';
import type { Services } from '../services/index.js';
import { jqRouting, ripgrepRouting } from './guidance.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
  readonly signal?: AbortSignal | undefined;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

export const dataReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local_path'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe('Path relative to a configured data root, or an absolute path inside one.'),
  }),
  z.object({
    kind: z.literal('asset'),
    assetId: z.string().min(1).max(128).describe('Opaque identifier returned by POST /assets.'),
  }),
]);

const legacyFilePath = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('Deprecated: use source with kind="local_path".');

const sourceField = dataReferenceSchema
  .optional()
  .describe('The file to read: a local path or an uploaded asset.');

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

const referenceOf = (input: {
  source?: DataReference | undefined;
  filePath?: string | undefined;
}): DataReference => {
  if (input.source) return input.source;
  if (input.filePath) return { kind: 'local_path', path: input.filePath };
  throw badRequest('Provide exactly one of source or the deprecated filePath');
};

export const queryJsonJqTool = defineTool({
  name: 'query_json_jq',
  title: 'Query JSON with jq',
  summary: 'Apply a jq filter to a large JSON or JSONL file and return only the filtered result.',
  description: `Runs jq server-side against a JSON or JSONL file and returns only the filtered output, so the full document never enters model context. ${jqRouting} Output is bounded: inspect truncated and warnings and narrow the filter when they are set.`,
  kind: 'read',
  inputSchema: z
    .object({
      source: sourceField,
      filePath: legacyFilePath,
      filter: z
        .string()
        .min(1)
        .max(10_000)
        .describe('jq filter expression, for example .items[0].id'),
      maxOutputBytes: z
        .number()
        .int()
        .min(1024)
        .max(outputBytesCeiling)
        .optional()
        .describe(
          'Byte budget for the returned output. The server clamps this to its configured maximum, which is usually far smaller.',
        ),
    })
    .superRefine(requireExactlyOneSource),
  outputSchema: z.object({
    output: z.string(),
    returnedBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  }),
  handler: (input, services, context) =>
    services.dataCruncher.queryJson(
      referenceOf(input),
      { filter: input.filter, maxOutputBytes: input.maxOutputBytes },
      { principal: context.principal, signal: context.signal },
    ),
});

export const ripgrepSearchTool = defineTool({
  name: 'ripgrep_search',
  title: 'Search a text file with ripgrep',
  summary: 'Find regular-expression matches in a large log or text file.',
  description: `Runs ripgrep server-side against a text or log file and returns matching lines with one-based line numbers, so the full file never enters model context. ${ripgrepRouting} matchCount is the number of returned matches; truncated indicates that more matches exist.`,
  kind: 'read',
  inputSchema: z
    .object({
      source: sourceField,
      filePath: legacyFilePath,
      pattern: z.string().min(1).max(10_000).describe('Regular expression in ripgrep syntax.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(matchCountCeiling)
        .default(100)
        .describe(
          'Maximum matches to return. The server clamps this to its configured maximum, which is usually far smaller.',
        ),
    })
    .superRefine(requireExactlyOneSource),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        lineNumber: z.number().int().nonnegative(),
        line: z.string(),
        lineTruncated: z.boolean(),
      }),
    ),
    matchCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    scannedBytes: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
  handler: (input, services, context) =>
    services.dataCruncher.ripgrep(
      referenceOf(input),
      { pattern: input.pattern, maxResults: input.maxResults },
      { principal: context.principal, signal: context.signal },
    ),
});

export const toolDefinitions = [
  queryJsonJqTool,
  ripgrepSearchTool,
] as const satisfies readonly ToolDefinition[];
