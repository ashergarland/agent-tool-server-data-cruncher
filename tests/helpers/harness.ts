import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';
import { createRuntime, type Runtime } from '../../src/runtime/index.js';
import { createHttpServer } from '../../src/server/http.js';
import type { HttpServer } from '../../src/server/types.js';
import { createServices, type Services } from '../../src/services/index.js';
import type { AssetStore } from '../../src/services/assets/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';

export const apiKey = 'test-api-key-that-is-at-least-32-characters';

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
      RATE_LIMIT_MAX: 120,
      ...overrides,
    }),
  );

export interface Harness {
  readonly config: AppConfig;
  readonly runtime: Runtime;
  readonly services: Services;
  readonly dataRoot: string;
  readonly tempDir: string;
  readonly app: HttpServer;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  readonly env?: Record<string, unknown>;
  readonly assetStore?: AssetStore;
  readonly http?: boolean;
}

/** Creates an isolated configuration, runtime and (optionally) HTTP server backed by temp dirs. */
export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dc-data-'));
  const tempDir = await mkdtemp(join(tmpdir(), 'dc-temp-'));
  const config = testConfig({ DATA_ROOT: dataRoot, TEMP_DIR: tempDir, ...options.env });
  const runtime = createRuntime(config);
  const services = createServices(config, {
    runtime,
    ...(options.assetStore ? { assetStore: options.assetStore } : {}),
  });
  const app = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    services,
    registry: createToolRegistry(),
  });

  return {
    config,
    runtime,
    services,
    dataRoot,
    tempDir,
    app,
    dispose: async () => {
      await app.close();
      await runtime.close();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    },
  };
};
