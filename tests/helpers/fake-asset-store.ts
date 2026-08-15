import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badRequest, upstreamError } from '../../src/errors.js';
import type {
  AssetMetadata,
  AssetStore,
  AssetUpload,
  MaterializedAsset,
} from '../../src/services/assets/index.js';

interface Entry {
  readonly metadata: AssetMetadata;
  readonly principal: string;
  readonly body: Buffer;
}

/** In-memory store used by transport tests so no filesystem or Azure dependency is required. */
export class FakeAssetStore implements AssetStore {
  public readonly kind = 'filesystem' as const;
  public failNext: 'check' | 'put' | 'materialize' | undefined;
  public checkCalls = 0;

  private readonly entries = new Map<string, Entry>();
  private readonly directories: string[] = [];

  public constructor(private readonly ttlSeconds = 3600) {}

  public check(): Promise<void> {
    this.checkCalls += 1;
    if (this.failNext === 'check') throw upstreamError('asset store unavailable');
    return Promise.resolve();
  }

  public async put(upload: AssetUpload): Promise<AssetMetadata> {
    if (this.failNext === 'put') throw upstreamError('asset store unavailable');
    const chunks: Buffer[] = [];
    for await (const chunk of upload.body) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const createdAt = new Date();
    const metadata: AssetMetadata = {
      assetId: randomBytes(16).toString('hex'),
      filename: upload.filename,
      contentType: upload.contentType ?? 'application/octet-stream',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    this.entries.set(metadata.assetId, { metadata, principal: upload.principal, body });
    return metadata;
  }

  public head(assetId: string, principal: string): Promise<AssetMetadata> {
    return Promise.resolve(this.entry(assetId, principal).metadata);
  }

  public list(principal: string): Promise<readonly AssetMetadata[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .filter((entry) => entry.principal === principal)
        .map((entry) => entry.metadata),
    );
  }

  public remove(assetId: string, principal: string): Promise<void> {
    this.entry(assetId, principal);
    this.entries.delete(assetId);
    return Promise.resolve();
  }

  public async materialize(assetId: string, principal: string): Promise<MaterializedAsset> {
    if (this.failNext === 'materialize') throw upstreamError('asset store unavailable');
    const entry = this.entry(assetId, principal);
    const directory = await mkdtemp(join(tmpdir(), 'dc-fake-asset-'));
    this.directories.push(directory);
    const path = join(directory, randomBytes(8).toString('hex'));
    await writeFile(path, entry.body);
    return {
      metadata: entry.metadata,
      path,
      dispose: async () => {
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  public sweep(): Promise<number> {
    return Promise.resolve(0);
  }

  public async close(): Promise<void> {
    await Promise.all(this.directories.map((dir) => rm(dir, { recursive: true, force: true })));
  }

  private entry(assetId: string, principal: string): Entry {
    const entry = this.entries.get(assetId);
    if (!entry || entry.principal !== principal) {
      throw badRequest('Asset does not exist or has expired');
    }
    return entry;
  }
}
