import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { AssetLimits } from './index.js';
import {
  assertAssetId,
  assertWithinQuota,
  assetNotFound,
  expiryFrom,
  guessContentType,
  isExpired,
  meterStream,
  newAssetId,
  ownerKey,
  sanitizeFilename,
} from './common.js';
import type { AssetMetadata, AssetStore, AssetUpload, MaterializedAsset } from './types.js';

const metadataSchema = z.object({
  assetId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export interface FilesystemAssetStoreOptions {
  readonly root: string;
  readonly limits: AssetLimits;
  readonly materializeDir: () => Promise<string>;
}

/** Development and self-hosted store. Assets live under a per-principal directory. */
export class FilesystemAssetStore implements AssetStore {
  public readonly kind = 'filesystem' as const;

  public constructor(private readonly options: FilesystemAssetStoreOptions) {}

  public async check(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const probe = join(this.options.root, `.check-${randomBytes(4).toString('hex')}`);
    await writeFile(probe, 'ok', { mode: 0o600 });
    await rm(probe, { force: true });
  }

  public async put(upload: AssetUpload): Promise<AssetMetadata> {
    const owner = ownerKey(upload.principal);
    const directory = join(this.options.root, owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertWithinQuota(await this.usage(upload.principal), this.options.limits);

    const assetId = newAssetId();
    const staging = join(directory, `.staging-${assetId}`);
    const metered = meterStream(upload.body, this.options.limits.maxBytes);
    try {
      await pipeline(metered.stream, createWriteStream(staging, { mode: 0o600 }));
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }

    const createdAt = new Date();
    const metadata: AssetMetadata = {
      assetId,
      filename: sanitizeFilename(upload.filename),
      contentType: guessContentType(sanitizeFilename(upload.filename), upload.contentType),
      sizeBytes: metered.sizeBytes(),
      sha256: metered.digest(),
      createdAt: createdAt.toISOString(),
      expiresAt: expiryFrom(createdAt, this.options.limits.ttlSeconds),
    };
    await rename(staging, join(directory, `${assetId}.bin`));
    await writeFile(join(directory, `${assetId}.json`), JSON.stringify(metadata), { mode: 0o600 });
    return metadata;
  }

  public async head(assetId: string, principal: string): Promise<AssetMetadata> {
    const metadata = await this.read(assertAssetId(assetId), principal);
    if (!metadata || isExpired(metadata)) {
      if (metadata) await this.remove(assetId, principal).catch(() => undefined);
      return assetNotFound();
    }
    return metadata;
  }

  public async list(principal: string): Promise<readonly AssetMetadata[]> {
    const directory = join(this.options.root, ownerKey(principal));
    const entries = await readdir(directory).catch(() => [] as string[]);
    const assets = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.read(entry.replace(/\.json$/, ''), principal)),
    );
    return assets.filter(
      (metadata): metadata is AssetMetadata => metadata !== undefined && !isExpired(metadata),
    );
  }

  public async remove(assetId: string, principal: string): Promise<void> {
    const directory = join(this.options.root, ownerKey(principal));
    const id = assertAssetId(assetId);
    await Promise.all([
      rm(join(directory, `${id}.bin`), { force: true }),
      rm(join(directory, `${id}.json`), { force: true }),
    ]);
  }

  public async materialize(assetId: string, principal: string): Promise<MaterializedAsset> {
    const metadata = await this.head(assetId, principal);
    const source = join(this.options.root, ownerKey(principal), `${metadata.assetId}.bin`);
    if (!(await stat(source).catch(() => undefined))?.isFile()) return assetNotFound();

    const target = join(await this.options.materializeDir(), randomBytes(16).toString('hex'));
    await pipeline(createReadStream(source), createWriteStream(target, { mode: 0o600 }));
    return {
      metadata,
      path: target,
      dispose: async () => {
        await rm(target, { force: true });
      },
    };
  }

  public async sweep(): Promise<number> {
    const owners = await readdir(this.options.root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const directory = join(this.options.root, owner.name);
      const entries = await readdir(directory).catch(() => [] as string[]);
      for (const entry of entries.filter((name) => name.endsWith('.json'))) {
        const metadata = await this.readFile(join(directory, entry));
        if (!metadata || !isExpired(metadata)) continue;
        await Promise.all([
          rm(join(directory, `${metadata.assetId}.bin`), { force: true }),
          rm(join(directory, entry), { force: true }),
        ]);
        removed += 1;
      }
    }
    return removed;
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private async usage(principal: string): Promise<{ count: number; bytes: number }> {
    const assets = await this.list(principal);
    return {
      count: assets.length,
      bytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
    };
  }

  private read(assetId: string, principal: string): Promise<AssetMetadata | undefined> {
    return this.readFile(join(this.options.root, ownerKey(principal), `${assetId}.json`));
  }

  private async readFile(path: string): Promise<AssetMetadata | undefined> {
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) return undefined;
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }
}
