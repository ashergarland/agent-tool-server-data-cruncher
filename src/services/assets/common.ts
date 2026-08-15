import { createHash, randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { badRequest, forbidden, payloadTooLarge } from '../../errors.js';
import type { AssetMetadata } from './types.js';

export const newAssetId = (): string => randomBytes(16).toString('hex');

/** Opaque, path-safe owner key. The raw principal never appears in storage keys. */
export const ownerKey = (principal: string): string =>
  createHash('sha256').update(`asset-owner:${principal}`).digest('hex').slice(0, 32);

export const sanitizeFilename = (filename: string): string => {
  const base = basename(filename.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 128);
  return trimmed.length > 0 ? trimmed : 'upload.bin';
};

export const sanitizeContentType = (contentType: string | undefined): string => {
  const value = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
    ? value
    : 'application/octet-stream';
};

export const guessContentType = (filename: string, provided: string | undefined): string => {
  const sanitized = sanitizeContentType(provided);
  if (sanitized !== 'application/octet-stream') return sanitized;
  const extension = extname(filename).toLowerCase();
  if (extension === '.json') return 'application/json';
  if (extension === '.jsonl' || extension === '.ndjson') return 'application/x-ndjson';
  if (extension === '.log' || extension === '.txt' || extension === '.csv') return 'text/plain';
  return sanitized;
};

export const expiryFrom = (createdAt: Date, ttlSeconds: number): string =>
  new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString();

export const isExpired = (metadata: AssetMetadata, now = Date.now()): boolean =>
  Date.parse(metadata.expiresAt) <= now;

export const assetNotFound = (): never => {
  // Deliberately indistinguishable from "owned by somebody else" to avoid an existence oracle.
  throw badRequest('Asset does not exist or has expired');
};

export const assertAssetId = (assetId: string): string => {
  if (!/^[0-9a-f]{32}$/.test(assetId)) assetNotFound();
  return assetId;
};

export interface MeteredStream {
  readonly stream: Readable;
  sizeBytes(): number;
  digest(): string;
}

/**
 * Streams the body while hashing it and failing fast once a byte limit is exceeded.
 *
 * `maxBytes` is the per-upload ceiling; `remainingQuotaBytes` is what is left of the principal's
 * storage quota. Enforcing both here makes the quota a real ceiling rather than an admission
 * threshold, because the check happens as bytes arrive rather than before the stream starts.
 */
export const meterStream = (
  source: Readable,
  maxBytes: number,
  remainingQuotaBytes = Number.POSITIVE_INFINITY,
): MeteredStream => {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(payloadTooLarge('Upload exceeds the maximum asset size', { maxBytes }));
        return;
      }
      if (size > remainingQuotaBytes) {
        callback(
          forbidden('Upload would exceed the asset storage quota', {
            remainingQuotaBytes: Math.max(0, remainingQuotaBytes),
          }),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  source.on('error', (error) => meter.destroy(error));
  source.pipe(meter);
  return {
    stream: meter,
    sizeBytes: () => size,
    digest: () => hash.digest('hex'),
  };
};

export interface QuotaUsage {
  readonly count: number;
  readonly bytes: number;
}

/** Rejects a principal that is already at quota and returns the bytes still available to it. */
export const assertWithinQuota = (
  usage: QuotaUsage,
  limits: { readonly quotaCount: number; readonly quotaBytes: number },
): number => {
  if (usage.count >= limits.quotaCount) {
    throw forbidden('Asset count quota reached; delete assets before uploading more', {
      quotaCount: limits.quotaCount,
    });
  }
  if (usage.bytes >= limits.quotaBytes) {
    throw forbidden('Asset storage quota reached; delete assets before uploading more', {
      quotaBytes: limits.quotaBytes,
    });
  }
  return limits.quotaBytes - usage.bytes;
};
