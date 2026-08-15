import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import { createRuntime, type Runtime } from './runtime/index.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly runtime: Runtime;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
}

export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const runtime = createRuntime(config);
  const services = createServices(config, { runtime });
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry });
  return { config, logger, runtime, services, registry, http };
};
