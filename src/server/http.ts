import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import { createMcpServer } from '../mcp/server.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createAuthenticator, type Principal } from './auth.js';
import { registerErrorHandler } from './errors.js';
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit.js';
import { registerAssetRoutes } from './routes/assets.js';
import type { HttpServer } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface HttpServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
}

const readinessCacheMs = 3000;

interface ReadinessResult {
  readonly ready: boolean;
  readonly body: Record<string, unknown>;
}

/** Aborts in-flight work when the client disconnects before the response is sent. */
const requestSignal = (reply: FastifyReply): AbortSignal => {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
};

export const createHttpServer = ({
  config,
  logger,
  services,
  registry,
}: HttpServerDeps): HttpServer => {
  const startedAt = Date.now();
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (request) => {
      const requestId = request.headers['x-request-id'];
      return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200
        ? requestId
        : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1_000_000,
    trustProxy: config.http.trustProxy,
  });
  const authenticator = createAuthenticator(config);
  // Two independent budgets. The per-principal budget is a fair-use quota for a valid caller; the
  // per-address budget bounds abuse from callers that cannot authenticate. Keeping them separate
  // means a well-behaved client is never throttled by the stricter abuse budget.
  const principalLimiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max,
    config.http.rateLimit.windowMs,
  );
  const preAuthLimiter = new FixedWindowRateLimiter(
    config.http.preAuthRateLimitMax,
    config.http.rateLimit.windowMs,
  );
  // Meaningful only when TRUST_PROXY names the fronting proxy; otherwise every caller behind an
  // ingress shares one bucket, so the default is a single shared budget rather than a false
  // per-client one.
  const addressKey = (request: FastifyRequest): string => request.ip || 'unknown';

  const rateLimitError = (reply: FastifyReply, decision: RateLimitDecision): AppError => {
    void reply.header(
      'retry-after',
      String(Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000))),
    );
    return new AppError('rate_limited', 'Too many requests; slow down and retry', undefined, true);
  };

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  registerErrorHandler(app, config);

  app.get('/health', () => ({
    status: 'ok' as const,
    service: config.service.name,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  // `/ready` is public so orchestrators can probe it, and each check touches disk and the asset
  // store. The result is cached and concurrent probes share one evaluation so an unauthenticated
  // flood cannot amplify into storage calls or scratch-space churn.
  let readinessCache: { readonly at: number; readonly value: ReadinessResult } | undefined;
  let readinessInFlight: Promise<ReadinessResult> | undefined;

  const evaluateReadiness = async (): Promise<ReadinessResult> => {
    try {
      await services.runtime.check();
      await services.assets.check();
      return {
        ready: true,
        body: {
          status: 'ready',
          checks: {
            executables: services.runtime.executableVersions ?? {},
            assetStore: services.assets.kind,
            temporaryStorage: 'ok',
          },
        },
      };
    } catch (error) {
      logger.error({ err: error, event: 'readiness.failed' }, 'readiness check failed');
      return { ready: false, body: { status: 'not_ready' } };
    }
  };

  const readiness = (): Promise<ReadinessResult> => {
    if (readinessCache && Date.now() - readinessCache.at < readinessCacheMs) {
      return Promise.resolve(readinessCache.value);
    }
    readinessInFlight ??= evaluateReadiness()
      .then((value) => {
        readinessCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        readinessInFlight = undefined;
      });
    return readinessInFlight;
  };

  app.get('/ready', async (_request, reply) => {
    if (!services.runtime.isAccepting) {
      return reply.code(503).send({ status: 'draining', state: services.runtime.lifecycleState });
    }
    const result = await readiness();
    return reply.code(result.ready ? 200 : 503).send(result.body);
  });

  app.get('/version', async () => {
    const versions = await services.runtime
      .executables()
      .then((executables) => ({ jq: executables.jq.version, ripgrep: executables.ripgrep.version }))
      .catch(() => undefined);
    return {
      service: config.service.name,
      version: config.service.version,
      gitSha: config.service.gitSha,
      node: process.version,
      environment: config.env,
      capabilities: {
        transports: ['stdio', 'streamable-http', 'http-openapi'],
        authMode: config.auth.mode,
        tools: registry.list().map((tool) => tool.name),
        assetStore: config.assets.store.kind,
        localPaths: config.data.localPathsEnabled,
        executables: versions ?? { jq: 'unavailable', ripgrep: 'unavailable' },
      },
    };
  });

  const openApi = buildOpenApiDocument(config, registry);
  app.get('/openapi.json', () => openApi);

  void app.register(async (protectedApp) => {
    /**
     * Authentication only reads a header, so it runs at `onRequest` — before body parsing. That
     * ordering matters: a valid caller is charged solely to its own principal budget, while
     * traffic that cannot authenticate is charged to the per-address abuse budget and rejected
     * without the server reading a body. Checking the address budget before knowing whether the
     * credential is valid would let one noisy neighbour lock out everyone sharing an address.
     *
     * Every route in this scope is therefore both authenticated and rate limited by this single
     * hook. Static analysis that only recognises rate-limiting middleware packages reports these
     * routes as unlimited; the behaviour is covered by tests instead. Do not remove either
     * `consume` call.
     */
    const authenticateAndLimit = async (request: FastifyRequest, reply: FastifyReply) => {
      let principal: Principal;
      try {
        principal = await authenticator.authenticate(request);
      } catch (error) {
        const abuse = preAuthLimiter.consume(addressKey(request));
        if (!abuse.allowed) throw rateLimitError(reply, abuse);
        throw error;
      }
      request.principal = principal;
      const decision = principalLimiter.consume(principal.id);
      void reply.header('x-ratelimit-remaining', String(decision.remaining));
      if (!decision.allowed) throw rateLimitError(reply, decision);
    };
    protectedApp.addHook('onRequest', authenticateAndLimit);

    protectedApp.get('/tools', () => ({
      tools: registry.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        summary: tool.summary,
        description: tool.description,
        kind: tool.kind,
        inputSchema: tool.inputJsonSchema,
        outputSchema: tool.outputJsonSchema,
      })),
    }));

    protectedApp.post<{ Params: { toolName: string }; Body: unknown }>(
      '/tools/:toolName',
      async (request, reply) => {
        const tool = registry.get(request.params.toolName);
        const principal = request.principal?.id ?? 'anonymous';
        const invokedAt = Date.now();
        request.log.info({ event: 'tool.invoke', tool: tool.name, kind: tool.kind });
        const result = await tool.invoke(request.body ?? {}, services, {
          requestId: request.id,
          principal,
          signal: requestSignal(reply),
        });
        request.log.info({
          event: 'tool.result',
          tool: tool.name,
          durationMs: Date.now() - invokedAt,
          queued: services.runtime.toolQueue.queued,
        });
        return { tool: tool.name, requestId: request.id, result };
      },
    );

    const handleMcp = async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const transport = new StreamableHTTPServerTransport();
      const server = createMcpServer(config, registry, services, {
        requestId: request.id,
        principal: request.principal?.id ?? 'anonymous',
        signal: requestSignal(reply),
      });
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([transport.close(), server.close()]);
      };
      reply.raw.on('close', () => {
        void close();
      });
      // The SDK's Node transport is structurally compatible, but its optional callbacks conflict
      // with exactOptionalPropertyTypes in the SDK's own Transport declaration.
      try {
        await server.connect(transport as unknown as Transport);
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        await close();
        if (!reply.sent) throw error;
        request.log.error({ err: error, event: 'mcp.request.error' }, 'MCP request failed');
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        } else {
          reply.raw.destroy();
        }
      }
    };

    protectedApp.get<{ Body: unknown }>('/mcp', handleMcp);
    protectedApp.post<{ Body: unknown }>('/mcp', handleMcp);
    protectedApp.delete<{ Body: unknown }>('/mcp', handleMcp);

    await protectedApp.register((assetApp) => registerAssetRoutes(assetApp, { config, services }));
  });

  return app;
};
