import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { toAppError, unauthorized } from '../errors.js';

export interface Principal {
  readonly id: string;
  readonly kind: 'api-key' | 'anonymous';
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

const credential = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
};

class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', kind: 'anonymous' });
  }
}

/**
 * Compares fixed-width keyed digests rather than raw credentials, so neither the key length nor an
 * early byte mismatch is observable through timing.
 */
class ApiKeyAuthenticator implements Authenticator {
  private readonly pepper = randomBytes(32);
  private readonly digests: ReadonlyArray<{ digest: Buffer; principalId: string }>;

  public constructor(apiKeys: readonly string[]) {
    this.digests = apiKeys.map((value) => ({
      digest: this.digest(value),
      // Stable across restarts and key reordering so asset ownership survives both.
      principalId: `key:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`,
    }));
  }

  public authenticate(request: FastifyRequest): Promise<Principal> {
    try {
      return Promise.resolve(this.verify(request));
    } catch (error) {
      return Promise.reject(toAppError(error));
    }
  }

  private verify(request: FastifyRequest): Principal {
    const presented = credential(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');
    const presentedDigest = this.digest(presented);
    let match: string | undefined;
    for (const candidate of this.digests) {
      if (timingSafeEqual(candidate.digest, presentedDigest)) match = candidate.principalId;
    }
    if (!match) throw unauthorized('Invalid API key');
    return { id: match, kind: 'api-key' };
  }

  private digest(value: string): Buffer {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest();
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
