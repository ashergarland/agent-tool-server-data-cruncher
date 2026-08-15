import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../../config/index.js';
import { badRequest, payloadTooLarge } from '../../errors.js';
import type { Services } from '../../services/index.js';

const assetIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Unknown asset');

export interface AssetRouteOptions {
  readonly config: AppConfig;
  readonly services: Services;
  readonly routeOptions: RouteShorthandOptions;
}

const principalOf = (request: FastifyRequest): string => request.principal?.id ?? 'anonymous';

const declaredLength = (request: FastifyRequest): number | undefined => {
  const raw = request.headers['content-length'];
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};

const filenameOf = (request: FastifyRequest): string => {
  const header = request.headers['x-filename'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().length > 0 ? value : 'upload.bin';
};

/**
 * Streaming asset endpoints. File bytes never travel inside normal JSON tool requests, and no
 * storage or temporary path is ever returned to the caller.
 */
export const registerAssetRoutes = (
  app: FastifyInstance,
  { config, services, routeOptions }: AssetRouteOptions,
): Promise<void> => {
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  app.post('/assets', routeOptions, async (request: FastifyRequest, reply: FastifyReply) => {
    const size = declaredLength(request);
    if (size !== undefined && size > config.assets.maxBytes) {
      throw payloadTooLarge('Upload exceeds the maximum asset size', {
        maxBytes: config.assets.maxBytes,
      });
    }
    const metadata = await services.runtime.uploadQueue.run(() =>
      services.assets.put({
        principal: principalOf(request),
        filename: filenameOf(request),
        contentType: request.headers['content-type'],
        body: request.body as Readable,
      }),
    );
    request.log.info({ event: 'asset.upload', sizeBytes: metadata.sizeBytes });
    return reply.code(201).send({ asset: metadata });
  });

  app.get('/assets', routeOptions, async (request: FastifyRequest) => ({
    assets: await services.assets.list(principalOf(request)),
  }));

  app.get<{ Params: { assetId: string } }>('/assets/:assetId', routeOptions, async (request) => ({
    asset: await services.assets.head(parseAssetId(request.params.assetId), principalOf(request)),
  }));

  app.delete<{ Params: { assetId: string } }>(
    '/assets/:assetId',
    routeOptions,
    async (request, reply) => {
      await services.assets.remove(parseAssetId(request.params.assetId), principalOf(request));
      request.log.info({ event: 'asset.delete' });
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
};

const parseAssetId = (value: string): string => {
  const parsed = assetIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest('Asset does not exist or has expired');
  return parsed.data;
};
