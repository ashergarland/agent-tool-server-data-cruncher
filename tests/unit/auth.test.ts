import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createAuthenticator } from '../../src/server/auth.js';
import { apiKey, testConfig } from '../helpers/harness.js';

const request = (headers: Record<string, string>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

describe('api key authentication', () => {
  const authenticator = createAuthenticator(testConfig());

  it('accepts bearer tokens and x-api-key headers', async () => {
    const principal = await authenticator.authenticate(request({ 'x-api-key': apiKey }));
    expect(principal.kind).toBe('api-key');
    expect(principal.id).toMatch(/^key:[0-9a-f]{16}$/);
    expect(principal.id).not.toContain(apiKey);
    await expect(
      authenticator.authenticate(request({ authorization: `Bearer ${apiKey}` })),
    ).resolves.toEqual(principal);
  });

  it('rejects missing, malformed and incorrect credentials of any length', async () => {
    await expect(authenticator.authenticate(request({}))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      authenticator.authenticate(request({ authorization: 'Basic abc' })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    for (const wrong of ['', 'x', apiKey.slice(0, -1), `${apiKey}x`, 'y'.repeat(4096)]) {
      await expect(
        authenticator.authenticate(request({ 'x-api-key': wrong })),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    }
  });

  it('maps each configured key to a distinct stable principal', async () => {
    const second = 'another-api-key-that-is-at-least-32-characters';
    const multi = createAuthenticator(testConfig({ API_KEYS: `${apiKey},${second}` }));
    const reordered = createAuthenticator(testConfig({ API_KEYS: `${second},${apiKey}` }));

    const first = await multi.authenticate(request({ 'x-api-key': apiKey }));
    const other = await multi.authenticate(request({ 'x-api-key': second }));
    expect(first.id).not.toBe(other.id);
    await expect(reordered.authenticate(request({ 'x-api-key': second }))).resolves.toEqual(other);
  });

  it('returns an anonymous principal when authentication is disabled', async () => {
    const disabled = createAuthenticator(testConfig({ AUTH_MODE: 'disabled' }));
    await expect(disabled.authenticate(request({}))).resolves.toEqual({
      id: 'anonymous',
      kind: 'anonymous',
    });
  });
});
