import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
 * Principal identifiers are the one derivation that leaves the process: they appear in logs and
 * namespace each principal's assets, so they must survive restarts and key reordering while
 * resisting an offline attack if one leaks. scrypt is memory-hard, deterministic under a fixed
 * salt, and is computed once per configured key at startup rather than per request.
 */
const principalIdSalt = 'agent-tool-server-data-cruncher/principal-id/v1';
const principalIdBytes = 16;
const scryptParameters = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

// Memoised because the derivation is pure and deliberately expensive. This retains no credential
// that the process does not already hold: the same strings live in config.auth.apiKeys for the
// lifetime of the process.
const principalIds = new Map<string, string>();

const derivePrincipalId = (apiKey: string): string => {
  const cached = principalIds.get(apiKey);
  if (cached !== undefined) return cached;
  const derived = `key:${scryptSync(apiKey, principalIdSalt, principalIdBytes, scryptParameters).toString('hex')}`;
  principalIds.set(apiKey, derived);
  return derived;
};

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
      principalId: derivePrincipalId(value),
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

  /**
   * Verification runs on every request, including unauthenticated ones, so it must stay cheap: a
   * memory-hard KDF here would let anyone force ~100ms of CPU and 32 MiB per request. A keyed MAC
   * is the right primitive for a high-entropy machine credential — the pepper is 32 random bytes
   * that never leave memory, so the digest cannot be attacked offline without process memory,
   * which already holds the plaintext keys. Do not "upgrade" this to scrypt or bcrypt.
   */
  private digest(value: string): Buffer {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest();
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
