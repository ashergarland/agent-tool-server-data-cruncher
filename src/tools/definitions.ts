import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
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

export const queryJsonJqTool = defineTool({
  name: 'query_json_jq',
  title: 'Query JSON with jq',
  summary: 'Apply a jq filter to a local JSON file.',
  description:
    'Runs jq against a JSON file inside the configured data root and returns only the filtered output.',
  kind: 'read',
  inputSchema: z.object({
    filePath: z.string().min(1).max(4096),
    filter: z.string().min(1).max(10_000),
  }),
  outputSchema: z.object({ output: z.string() }),
  handler: async (input, services) => ({
    output: await services.dataCruncher.queryJson(input.filePath, input.filter),
  }),
});

const ripgrepMatchSchema = z.object({
  lineNumber: z.number().int().positive(),
  line: z.string(),
});

export const ripgrepSearchTool = defineTool({
  name: 'ripgrep_search',
  title: 'Search a file with ripgrep',
  summary: 'Find regular-expression matches in a local text file.',
  description:
    'Runs ripgrep against a file inside the configured data root and returns matching lines with one-based line numbers.',
  kind: 'read',
  inputSchema: z.object({
    filePath: z.string().min(1).max(4096),
    pattern: z.string().min(1).max(10_000),
    maxResults: z.number().int().min(1).max(1000).default(100),
  }),
  outputSchema: z.object({
    matches: z.array(ripgrepMatchSchema),
    matchCount: z.number().int().nonnegative(),
  }),
  handler: async (input, services) => {
    const matches = await services.dataCruncher.ripgrep(
      input.filePath,
      input.pattern,
      input.maxResults,
    );
    return { matches: [...matches], matchCount: matches.length };
  },
});

export const toolDefinitions = [
  queryJsonJqTool,
  ripgrepSearchTool,
] as const satisfies readonly ToolDefinition[];
