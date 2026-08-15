import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const bool = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

const mebibyte = 1024 * 1024;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-data-cruncher'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),

  DATA_ROOT: z.string().min(1).default('.'),
  DATA_ROOTS: csv.default([]),
  LOCAL_PATHS_ENABLED: bool.optional(),

  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(4096 * mebibyte)
    .default(64 * mebibyte),
  MAX_FILTER_LENGTH: z.coerce.number().int().min(1).max(100_000).default(4096),
  MAX_PATTERN_LENGTH: z.coerce.number().int().min(1).max(100_000).default(1024),
  SUBPROCESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
  MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * mebibyte)
    .default(mebibyte),
  DEFAULT_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * mebibyte)
    .default(128 * 1024),
  MAX_MATCHES: z.coerce.number().int().min(1).max(10_000).default(1000),
  MAX_LINE_LENGTH: z.coerce.number().int().min(16).max(65_536).default(2000),
  TOOL_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  TOOL_QUEUE_LIMIT: z.coerce.number().int().min(0).max(4096).default(32),
  UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  TEMP_DIR: z.string().min(1).default(tmpdir()),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),

  ASSET_STORE: z.enum(['disabled', 'filesystem', 'azure-blob']).default('disabled'),
  ASSET_FS_ROOT: z.string().min(1).optional(),
  AZURE_STORAGE_ACCOUNT: z.string().min(3).max(24).optional(),
  AZURE_STORAGE_CONTAINER: z.string().min(3).max(63).optional(),
  AZURE_CLIENT_ID: z.string().min(1).optional(),
  ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(4096 * mebibyte)
    .optional(),
  ASSET_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
  ASSET_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * mebibyte)
    .default(1024 * mebibyte),
  ASSET_QUOTA_COUNT: z.coerce.number().int().min(1).max(100_000).default(100),

  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  PRE_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(60),
  AUTH_MODE: z.enum(['api-key', 'disabled']).default('api-key'),
  API_KEYS: csv.default([]),
});

export type Env = z.infer<typeof envSchema>;

export interface ExecutionLimits {
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
  readonly uploadConcurrency: number;
  readonly tempDir: string;
}

export type AssetStoreConfig =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'filesystem'; readonly root: string }
  | {
      readonly kind: 'azure-blob';
      readonly account: string;
      readonly container: string;
      readonly clientId: string | undefined;
    };

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
    readonly preAuthRateLimitMax: number;
    readonly shutdownGraceMs: number;
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly data: {
    readonly roots: readonly string[];
    readonly localPathsEnabled: boolean;
  };
  readonly limits: ExecutionLimits;
  readonly assets: {
    readonly store: AssetStoreConfig;
    readonly maxBytes: number;
    readonly ttlSeconds: number;
    readonly quotaBytes: number;
    readonly quotaCount: number;
  };
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

const assetStoreConfig = (env: Env): AssetStoreConfig => {
  if (env.ASSET_STORE === 'filesystem') {
    if (!env.ASSET_FS_ROOT) {
      throw new ConfigurationError('ASSET_STORE=filesystem requires ASSET_FS_ROOT');
    }
    return { kind: 'filesystem', root: env.ASSET_FS_ROOT };
  }
  if (env.ASSET_STORE === 'azure-blob') {
    if (!env.AZURE_STORAGE_ACCOUNT || !env.AZURE_STORAGE_CONTAINER) {
      throw new ConfigurationError(
        'ASSET_STORE=azure-blob requires AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_CONTAINER',
      );
    }
    return {
      kind: 'azure-blob',
      account: env.AZURE_STORAGE_ACCOUNT,
      container: env.AZURE_STORAGE_CONTAINER,
      clientId: env.AZURE_CLIENT_ID,
    };
  }
  return { kind: 'disabled' };
};

export const buildConfig = (env: Env): AppConfig => {
  const isProduction = env.NODE_ENV === 'production';

  if (env.AUTH_MODE === 'disabled' && isProduction) {
    throw new ConfigurationError('AUTH_MODE=disabled is not permitted in production');
  }
  if (env.AUTH_MODE === 'api-key') {
    if (env.API_KEYS.length === 0) {
      throw new ConfigurationError('AUTH_MODE=api-key requires API_KEYS');
    }
    if (env.API_KEYS.some((key) => key.length < 32)) {
      throw new ConfigurationError('Every API key must be at least 32 characters');
    }
  }
  if (env.DEFAULT_OUTPUT_BYTES > env.MAX_OUTPUT_BYTES) {
    throw new ConfigurationError('DEFAULT_OUTPUT_BYTES must not exceed MAX_OUTPUT_BYTES');
  }

  const localPathsEnabled = env.LOCAL_PATHS_ENABLED ?? !isProduction;
  const roots = [...new Set(env.DATA_ROOTS.length > 0 ? env.DATA_ROOTS : [env.DATA_ROOT])];
  if (isProduction && localPathsEnabled && roots.some((root) => !isAbsolute(root))) {
    throw new ConfigurationError('Production data roots must be absolute paths');
  }

  const assetStore = assetStoreConfig(env);
  const assetMaxBytes = env.ASSET_MAX_BYTES ?? env.MAX_FILE_BYTES;
  if (assetMaxBytes > env.MAX_FILE_BYTES) {
    throw new ConfigurationError('ASSET_MAX_BYTES must not exceed MAX_FILE_BYTES');
  }
  if (isProduction && !localPathsEnabled && assetStore.kind === 'disabled') {
    throw new ConfigurationError(
      'Production requires an asset store or explicitly enabled local paths',
    );
  }
  if (isProduction && assetStore.kind === 'filesystem') {
    throw new ConfigurationError(
      'ASSET_STORE=filesystem is a development store; use azure-blob in production',
    );
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    service: {
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      gitSha: env.GIT_SHA,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
      preAuthRateLimitMax: env.PRE_AUTH_RATE_LIMIT_MAX,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    },
    logLevel: env.LOG_LEVEL,
    data: { roots, localPathsEnabled },
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
      uploadConcurrency: env.UPLOAD_CONCURRENCY,
      tempDir: env.TEMP_DIR,
    },
    assets: {
      store: assetStore,
      maxBytes: assetMaxBytes,
      ttlSeconds: env.ASSET_TTL_SECONDS,
      quotaBytes: env.ASSET_QUOTA_BYTES,
      quotaCount: env.ASSET_QUOTA_COUNT,
    },
    auth:
      env.AUTH_MODE === 'disabled'
        ? { mode: 'disabled' }
        : { mode: 'api-key', apiKeys: env.API_KEYS },
  };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data);
};
