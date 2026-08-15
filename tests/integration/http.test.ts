import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAssetStore } from '../helpers/fake-asset-store.js';
import { apiKey, createHarness, type Harness } from '../helpers/harness.js';

const harnesses: Harness[] = [];
let assets: FakeAssetStore;
let harness: Harness;

const auth = { 'x-api-key': apiKey };

const build = async (env: Record<string, unknown> = {}): Promise<Harness> => {
  const created = await createHarness({ env, assetStore: assets });
  harnesses.push(created);
  return created;
};

beforeEach(async () => {
  assets = new FakeAssetStore();
  harness = await build();
});

afterEach(async () => {
  await assets.close();
  await Promise.all(harnesses.splice(0).map((entry) => entry.dispose()));
});

describe('public endpoints', () => {
  it('serves liveness, version and request ids', async () => {
    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/version',
      headers: { 'x-request-id': 'caller-id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    const body = response.json<{
      capabilities: { transports: string[]; executables: Record<string, string> };
    }>();
    expect(body.capabilities.transports).toContain('streamable-http');
    expect(body.capabilities.executables.jq).toMatch(/^\d+\./);
    expect(body.capabilities.executables.ripgrep).toMatch(/^\d+\./);
  });

  it('reports readiness separately from liveness', async () => {
    const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { assetStore: 'filesystem' } });

    harness.runtime.beginDraining();
    const draining = await harness.app.inject({ method: 'GET', url: '/ready' });
    expect(draining.statusCode).toBe(503);
    expect(draining.json<{ status: string }>().status).toBe('draining');
  });

  it('reports a failing dependency without leaking details', async () => {
    assets.failNext = 'check';
    const failing = await build();
    const response = await failing.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready' });
    assets.failNext = undefined;
  });

  it('caches readiness so unauthenticated probes cannot amplify into storage calls', async () => {
    const probed = await build();
    assets.checkCalls = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await probed.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    }
    expect(assets.checkCalls).toBe(1);
  });

  it('publishes the generated OpenAPI document', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/tools/query_json_jq']).toBeDefined();
    expect(response.json().paths['/assets']).toBeDefined();
  });
});

describe('authentication and limits', () => {
  it('authenticates protected routes', async () => {
    expect((await harness.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': 'not-the-configured-key-but-long-enough' },
        })
      ).statusCode,
    ).toBe(401);

    const response = await harness.app.inject({ method: 'GET', url: '/tools', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toHaveLength(2);
  });

  it('supports development-only disabled authentication', async () => {
    const open = await build({ AUTH_MODE: 'disabled' });
    expect((await open.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(200);
  });

  it('applies a pre-authentication abuse limit to failed credentials only', async () => {
    const limited = await build({ PRE_AUTH_RATE_LIMIT_MAX: 2 });
    expect((await limited.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect((await limited.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect((await limited.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(429);
  });

  it('does not spend the pre-authentication budget on valid credentials', async () => {
    // The abuse budget is deliberately far smaller than the per-principal budget, so an
    // authenticated client must never be throttled by it.
    const limited = await build({ PRE_AUTH_RATE_LIMIT_MAX: 2, RATE_LIMIT_MAX: 20 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (await limited.app.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode,
      ).toBe(200);
    }
  });

  it('keeps a valid principal working while another address is blocked', async () => {
    const limited = await build({ PRE_AUTH_RATE_LIMIT_MAX: 1, RATE_LIMIT_MAX: 20 });
    expect((await limited.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect((await limited.app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(429);
    expect(
      (await limited.app.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode,
    ).toBe(200);
  });

  it('rate limits authenticated principals', async () => {
    const limited = await build({ RATE_LIMIT_MAX: 1 });
    expect(
      (await limited.app.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode,
    ).toBe(200);
    const blocked = await limited.app.inject({ method: 'GET', url: '/tools', headers: auth });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { retryable: boolean } }>().error.retryable).toBe(true);
  });
});

describe('tool invocation', () => {
  it('invokes tools with a data reference and maps validation failures', async () => {
    await writeFile(join(harness.dataRoot, 'data.json'), JSON.stringify({ status: 'ok' }));

    const success = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: auth,
      payload: { source: { kind: 'local_path', path: 'data.json' }, filter: '.status' },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json().result).toMatchObject({ output: '"ok"', truncated: false });

    const legacy = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: auth,
      payload: { filePath: 'data.json', filter: '.status' },
    });
    expect(legacy.json().result.output).toBe('"ok"');

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: auth,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details.issues.length).toBeGreaterThan(0);
  });

  it('returns a safe envelope without paths or stderr', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: auth,
      payload: { source: { kind: 'local_path', path: 'missing.json' }, filter: '.' },
    });
    expect(response.statusCode).toBe(400);
    const { error } = response.json<{ error: Record<string, unknown> }>();
    expect(error).toMatchObject({ code: 'bad_request', retryable: false });
    expect(JSON.stringify(error)).not.toContain(harness.dataRoot);
  });

  it('reports unknown tools', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/tools/nope',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('maps framework failures to client errors', async () => {
    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{"filter": ',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe('bad_request');

    const oversized = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ filter: 'x'.repeat(2_000_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json<{ error: { code: string } }>().error.code).toBe('payload_too_large');
  });
});

describe('assets', () => {
  interface AssetBody {
    asset: { assetId: string; filename: string; sizeBytes: number };
  }

  const upload = (app: Harness['app'], payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/assets',
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'x-filename': 'orders.json',
        ...headers,
      },
      payload,
    });

  it('accepts a streamed upload and uses it as a tool input', async () => {
    const created = await upload(harness.app, JSON.stringify({ total: 42 }));
    expect(created.statusCode).toBe(201);
    const { asset } = created.json<AssetBody>();
    expect(asset).toMatchObject({ filename: 'orders.json', sizeBytes: 12 });
    expect(JSON.stringify(asset)).not.toContain(harness.tempDir);

    const result = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: auth,
      payload: { source: { kind: 'asset', assetId: asset.assetId }, filter: '.total' },
    });
    expect(result.json().result.output).toBe('42');
  });

  it('lists, inspects and deletes assets for the owning principal only', async () => {
    const second = 'second-api-key-that-is-at-least-32-characters';
    const multi = await build({ API_KEYS: `${apiKey},${second}` });
    const { asset } = (await upload(multi.app, '{}')).json<AssetBody>();

    const listed = await multi.app.inject({ method: 'GET', url: '/assets', headers: auth });
    expect(listed.json().assets).toHaveLength(1);

    const inspected = await multi.app.inject({
      method: 'GET',
      url: `/assets/${asset.assetId}`,
      headers: auth,
    });
    expect(inspected.json().asset.assetId).toBe(asset.assetId);

    const foreign = await multi.app.inject({
      method: 'GET',
      url: `/assets/${asset.assetId}`,
      headers: { 'x-api-key': second },
    });
    expect(foreign.statusCode).toBe(400);
    expect(
      (
        await multi.app.inject({ method: 'GET', url: '/assets', headers: { 'x-api-key': second } })
      ).json().assets,
    ).toEqual([]);

    const deleted = await multi.app.inject({
      method: 'DELETE',
      url: `/assets/${asset.assetId}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await multi.app.inject({ method: 'GET', url: '/assets', headers: auth })).json().assets,
    ).toEqual([]);
  });

  it('requires authentication and rejects oversized or unknown assets', async () => {
    const anonymous = await harness.app.inject({
      method: 'POST',
      url: '/assets',
      headers: { 'content-type': 'application/octet-stream' },
      payload: '{}',
    });
    expect(anonymous.statusCode).toBe(401);

    const bounded = await build({ ASSET_MAX_BYTES: 1024 });
    const tooLarge = await upload(bounded.app, 'x'.repeat(2048));
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('payload_too_large');

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/assets/not-a-valid-id',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('surfaces storage failures as safe errors', async () => {
    assets.failNext = 'put';
    const response = await upload(harness.app, '{}');
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('upstream_error');
    assets.failNext = undefined;
  });

  it('refuses assets when no store is configured', async () => {
    const disabled = await createHarness();
    harnesses.push(disabled);
    const response = await disabled.app.inject({
      method: 'POST',
      url: '/assets',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('capacity', () => {
  it('returns a retryable busy error when the queue is saturated', async () => {
    const saturated = await build({ TOOL_CONCURRENCY: 1, TOOL_QUEUE_LIMIT: 0 });
    await writeFile(
      join(saturated.dataRoot, 'big.json'),
      JSON.stringify(Array.from({ length: 20_000 }, (_, index) => ({ index }))),
    );
    const payload = {
      source: { kind: 'local_path', path: 'big.json' },
      filter: '[.[].index] | add',
    };

    const [first, second] = await Promise.all([
      saturated.app.inject({ method: 'POST', url: '/tools/query_json_jq', headers: auth, payload }),
      saturated.app.inject({ method: 'POST', url: '/tools/query_json_jq', headers: auth, payload }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 503]);
    const busy = [first, second].find((response) => response.statusCode === 503);
    expect(busy?.json().error).toMatchObject({ code: 'busy', retryable: true });
  });
});
