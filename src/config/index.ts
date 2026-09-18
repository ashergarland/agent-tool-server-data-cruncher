import { z } from 'zod';
import {
  ConfigurationError,
  defineCapabilityConfig,
  loadCapabilityConfig,
  type PlatformConfig,
} from '@agent-tool-platform/runtime/config';
import { capabilityManifest } from '../manifest.js';

const mebibyte = 1024 * 1024;

export const outputBytesCeiling = 64 * mebibyte;
export const matchCountCeiling = 10_000;
export const fileBytesCeiling = 4096 * mebibyte;

export const dataCruncherEnvSchema = z.object({
  DATA_ROOT: z.string().min(1).optional(),
  JQ_PATH: z.string().min(1).optional(),
  RIPGREP_PATH: z.string().min(1).optional(),
  TEMP_DIR: z.string().min(1).optional(),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(fileBytesCeiling)
    .default(64 * mebibyte),
  MAX_FILTER_LENGTH: z.coerce.number().int().min(1).max(100_000).default(4096),
  MAX_PATTERN_LENGTH: z.coerce.number().int().min(1).max(100_000).default(1024),
  SUBPROCESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
  MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(outputBytesCeiling).default(mebibyte),
  DEFAULT_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(outputBytesCeiling)
    .default(128 * 1024),
  MAX_MATCHES: z.coerce.number().int().min(1).max(matchCountCeiling).default(1000),
  MAX_LINE_LENGTH: z.coerce.number().int().min(16).max(65_536).default(2000),
  TOOL_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  TOOL_QUEUE_LIMIT: z.coerce.number().int().min(0).max(4096).default(32),
});

export type DataCruncherEnv = z.infer<typeof dataCruncherEnvSchema>;

export interface DataCruncherLimits {
  readonly maxFileBytes: number;
  readonly maxFilterLength: number;
  readonly maxPatternLength: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly defaultOutputBytes: number;
  readonly maxMatches: number;
  readonly maxLineLength: number;
  readonly toolConcurrency: number;
  readonly toolQueueLimit: number;
}

export interface DataCruncherConfig extends PlatformConfig {
  readonly data: {
    readonly root: string | undefined;
  };
  readonly execution: {
    readonly jqPath: string | undefined;
    readonly ripgrepPath: string | undefined;
    readonly tempDir: string | undefined;
    readonly limits: DataCruncherLimits;
  };
}

export const dataCruncherConfigSpec = defineCapabilityConfig<
  typeof dataCruncherEnvSchema,
  DataCruncherConfig
>({
  schema: dataCruncherEnvSchema,
  build: ({ base, env }) => ({
    ...base,
    data: { root: env.DATA_ROOT },
    execution: {
      jqPath: env.JQ_PATH,
      ripgrepPath: env.RIPGREP_PATH,
      tempDir: env.TEMP_DIR,
      limits: {
        maxFileBytes: env.MAX_FILE_BYTES,
        maxFilterLength: env.MAX_FILTER_LENGTH,
        maxPatternLength: env.MAX_PATTERN_LENGTH,
        timeoutMs: env.SUBPROCESS_TIMEOUT_MS,
        maxOutputBytes: env.MAX_OUTPUT_BYTES,
        defaultOutputBytes: env.DEFAULT_OUTPUT_BYTES,
        maxMatches: env.MAX_MATCHES,
        maxLineLength: env.MAX_LINE_LENGTH,
        toolConcurrency: env.TOOL_CONCURRENCY,
        toolQueueLimit: env.TOOL_QUEUE_LIMIT,
      },
    },
  }),
  validate: (config) => {
    if (config.execution.limits.defaultOutputBytes > config.execution.limits.maxOutputBytes) {
      throw new ConfigurationError('DEFAULT_OUTPUT_BYTES must not exceed MAX_OUTPUT_BYTES');
    }
  },
});

export const dataCruncherConfigDefaults = {
  serviceName: capabilityManifest.name,
  serviceVersion: capabilityManifest.version,
};

export const loadDataCruncherConfig = (
  source: NodeJS.ProcessEnv = process.env,
): DataCruncherConfig =>
  loadCapabilityConfig({
    defaults: dataCruncherConfigDefaults,
    spec: dataCruncherConfigSpec,
    source,
  });
