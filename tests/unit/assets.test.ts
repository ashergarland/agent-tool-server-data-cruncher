import { mkdtemp, readdir, rm, writeFile as writeFileFs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AzureBlobAssetStore } from '../../src/services/assets/azure-blob-store.js';
import { FilesystemAssetStore } from '../../src/services/assets/filesystem-store.js';
import { DisabledAssetStore } from '../../src/services/assets/index.js';
import { ownerKey, sanitizeFilename } from '../../src/services/assets/common.js';
import type { AssetLimits, AssetStore } from '../../src/services/assets/index.js';

const limits: AssetLimits = {
  maxBytes: 4096,
  ttlSeconds: 3600,
  quotaBytes: 8192,
  quotaCount: 3,
};

const body = (contents: string): Readable => Readable.from([Buffer.from(contents)]);

let root: string;
let materialized: string;
let store: FilesystemAssetStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dc-assets-'));
  materialized = await mkdtemp(join(tmpdir(), 'dc-materialized-'));
  store = new FilesystemAssetStore({
    root,
    limits,
    materializeDir: () => Promise.resolve(materialized),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(materialized, { recursive: true, force: true });
});

const upload = (principal: string, contents = '{"a":1}', filename = 'data.json') =>
  store.put({ principal, filename, contentType: 'application/json', body: body(contents) });

describe('filesystem asset store', () => {
  it('stores metadata, checksum and sanitised names', async () => {
    const metadata = await upload('key:1', '{"a":1}', '../../etc/pa ss wd.json');
    expect(metadata.filename).toBe('pa_ss_wd.json');
    expect(metadata.sizeBytes).toBe(7);
    expect(metadata.sha256).toHaveLength(64);
    expect(Date.parse(metadata.expiresAt)).toBeGreaterThan(Date.now());
    expect(await store.head(metadata.assetId, 'key:1')).toEqual(metadata);
  });

  it('isolates principals', async () => {
    const metadata = await upload('key:1');
    await expect(store.head(metadata.assetId, 'key:2')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(store.materialize(metadata.assetId, 'key:2')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await store.list('key:2')).toEqual([]);
    expect(await store.list('key:1')).toHaveLength(1);
  });

  it('rejects uploads beyond the size limit without leaving partial files', async () => {
    await expect(
      store.put({
        principal: 'key:1',
        filename: 'big.json',
        contentType: 'application/json',
        body: body('x'.repeat(limits.maxBytes + 1)),
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(await store.list('key:1')).toEqual([]);
    expect(await readdir(join(root, ownerKey('key:1')))).toEqual([]);
  });

  it('enforces the per-principal count quota', async () => {
    for (let index = 0; index < limits.quotaCount; index += 1) await upload('key:1');
    await expect(upload('key:1')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('expires assets and sweeps them', async () => {
    const shortLived = new FilesystemAssetStore({
      root,
      limits: { ...limits, ttlSeconds: 60 },
      materializeDir: () => Promise.resolve(materialized),
    });
    const metadata = await shortLived.put({
      principal: 'key:1',
      filename: 'data.json',
      contentType: 'application/json',
      body: body('{}'),
    });

    const expired = new Date(Date.now() - 1000).toISOString();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(root, ownerKey('key:1'), `${metadata.assetId}.json`),
      JSON.stringify({ ...metadata, expiresAt: expired }),
    );

    await expect(shortLived.head(metadata.assetId, 'key:1')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await shortLived.sweep()).toBeGreaterThanOrEqual(0);
    expect(await shortLived.list('key:1')).toEqual([]);
  });

  it('materialises to a temporary file and removes it on dispose', async () => {
    const metadata = await upload('key:1');
    const asset = await store.materialize(metadata.assetId, 'key:1');
    expect(asset.path.startsWith(materialized)).toBe(true);
    expect(await readdir(materialized)).toHaveLength(1);
    await asset.dispose();
    expect(await readdir(materialized)).toHaveLength(0);
  });

  it('enforces the byte quota as a ceiling, not an admission threshold', async () => {
    // Sitting just under the quota must not permit a further full-size upload.
    const bounded = new FilesystemAssetStore({
      root,
      limits: { ...limits, quotaBytes: 3000, maxBytes: 4096 },
      materializeDir: () => Promise.resolve(materialized),
    });
    await bounded.put({
      principal: 'key:1',
      filename: 'a.json',
      contentType: 'application/json',
      body: body('x'.repeat(2900)),
    });

    await expect(
      bounded.put({
        principal: 'key:1',
        filename: 'b.json',
        contentType: 'application/json',
        body: body('y'.repeat(1000)),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const stored = await bounded.list('key:1');
    expect(stored.reduce((total, asset) => total + asset.sizeBytes, 0)).toBeLessThanOrEqual(3000);
    expect(await readdir(join(root, ownerKey('key:1')))).toHaveLength(2); // .bin + .json only
  });

  it('treats a corrupt metadata sidecar as a missing asset', async () => {
    const good = await upload('key:1');
    const directory = join(root, ownerKey('key:1'));
    // put() publishes the .bin before the sidecar, and writeFile is not atomic.
    await writeFileFs(join(directory, `${'0'.repeat(32)}.json`), '{"assetId": "trunca');

    await expect(store.list('key:1')).resolves.toHaveLength(1);
    await expect(store.head(good.assetId, 'key:1')).resolves.toMatchObject({
      assetId: good.assetId,
    });
    await expect(store.head('0'.repeat(32), 'key:1')).rejects.toMatchObject({
      code: 'bad_request',
    });
    // A corrupt sidecar must not block further uploads for the principal.
    await expect(upload('key:1')).resolves.toMatchObject({ filename: 'data.json' });
    await expect(store.sweep()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('deletes assets on request', async () => {
    const metadata = await upload('key:1');
    await store.remove(metadata.assetId, 'key:1');
    await expect(store.head(metadata.assetId, 'key:1')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects malformed asset identifiers', async () => {
    await expect(store.head('../../etc/passwd', 'key:1')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});

describe('disabled asset store', () => {
  it('refuses every operation', async () => {
    const disabled: AssetStore = new DisabledAssetStore();
    await expect(disabled.put({} as never)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(disabled.head('a', 'key:1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(disabled.check()).resolves.toBeUndefined();
  });
});

interface FakeBlob {
  metadata: Record<string, string>;
  body: Buffer;
}

const azureStore = (blobs: Map<string, FakeBlob>) =>
  new AzureBlobAssetStore({
    account: 'account',
    container: 'assets',
    clientId: undefined,
    limits,
    materializeDir: () => Promise.resolve(materialized),
    containerClientFactory: () =>
      Promise.resolve({
        exists: () => Promise.resolve(true),
        listBlobsFlat: ({ prefix = '' } = {}) =>
          (async function* () {
            for (const [name, blob] of blobs) {
              if (name.startsWith(prefix)) yield { name, metadata: blob.metadata };
            }
          })(),
        getBlockBlobClient: (name: string) => ({
          uploadStream: async (stream: Readable) => {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            blobs.set(name, { metadata: {}, body: Buffer.concat(chunks) });
          },
          setMetadata: (metadata: Record<string, string>) => {
            const blob = blobs.get(name);
            if (blob) blobs.set(name, { ...blob, metadata });
            return Promise.resolve(undefined);
          },
          getProperties: () => {
            const blob = blobs.get(name);
            return blob
              ? Promise.resolve({ metadata: blob.metadata, contentLength: blob.body.length })
              : Promise.reject(new Error('not found'));
          },
          download: () => {
            const blob = blobs.get(name);
            return blob
              ? Promise.resolve({ readableStreamBody: Readable.from([blob.body]) })
              : Promise.reject(new Error('not found'));
          },
          deleteIfExists: () => {
            blobs.delete(name);
            return Promise.resolve(undefined);
          },
        }),
      }),
  });

describe('azure blob asset store', () => {
  it('round-trips an asset without exposing storage paths', async () => {
    const blobs = new Map<string, FakeBlob>();
    const store = azureStore(blobs);
    const metadata = await store.put({
      principal: 'key:1',
      filename: 'orders.json',
      contentType: 'application/json',
      body: body('{"total":42}'),
    });

    expect(JSON.stringify(metadata)).not.toContain(ownerKey('key:1'));
    expect(await store.head(metadata.assetId, 'key:1')).toMatchObject({
      assetId: metadata.assetId,
      sizeBytes: 12,
    });
    const asset = await store.materialize(metadata.assetId, 'key:1');
    expect(asset.path.startsWith(materialized)).toBe(true);
    await asset.dispose();
    await store.remove(metadata.assetId, 'key:1');
    expect(blobs.size).toBe(0);
  });

  it('keeps principals isolated and removes failed uploads', async () => {
    const blobs = new Map<string, FakeBlob>();
    const store = azureStore(blobs);
    const metadata = await store.put({
      principal: 'key:1',
      filename: 'orders.json',
      contentType: 'application/json',
      body: body('{}'),
    });
    await expect(store.head(metadata.assetId, 'key:2')).rejects.toMatchObject({
      code: 'bad_request',
    });

    await expect(
      store.put({
        principal: 'key:1',
        filename: 'big.json',
        contentType: 'application/json',
        body: body('x'.repeat(limits.maxBytes + 1)),
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(blobs.size).toBe(1);
  });

  it('reports an unreachable container', async () => {
    const store = new AzureBlobAssetStore({
      account: 'account',
      container: 'assets',
      clientId: undefined,
      limits,
      materializeDir: () => Promise.resolve(materialized),
      containerClientFactory: () =>
        Promise.resolve({
          exists: () => Promise.resolve(false),
          listBlobsFlat: () => (async function* () {})(),
          getBlockBlobClient: () => ({}) as never,
        }),
    });
    await expect(store.check()).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('filename sanitisation', () => {
  it('strips directories, traversal and unusual characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\temp\\report 2024.json')).toBe('report_2024.json');
    expect(sanitizeFilename('...')).toBe('upload.bin');
  });
});
