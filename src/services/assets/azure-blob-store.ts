import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { upstreamError } from '../../errors.js';
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
import type { AssetLimits } from './index.js';
import type { AssetMetadata, AssetStore, AssetUpload, MaterializedAsset } from './types.js';

/** Minimal structural view of the Azure SDK surface this store uses. */
interface BlobClientLike {
  download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  getProperties(): Promise<{ metadata?: Record<string, string>; contentLength?: number }>;
  setMetadata(metadata: Record<string, string>): Promise<unknown>;
  deleteIfExists(): Promise<unknown>;
  uploadStream(
    stream: Readable,
    bufferSize?: number,
    maxConcurrency?: number,
    options?: { metadata?: Record<string, string>; blobHTTPHeaders?: { blobContentType: string } },
  ): Promise<unknown>;
}

interface ContainerClientLike {
  exists(): Promise<boolean>;
  getBlockBlobClient(name: string): BlobClientLike;
  listBlobsFlat(options?: {
    prefix?: string;
    includeMetadata?: boolean;
  }): AsyncIterable<{ name: string; metadata?: Record<string, string> }>;
}

export interface AzureBlobAssetStoreOptions {
  readonly account: string;
  readonly container: string;
  readonly clientId: string | undefined;
  readonly limits: AssetLimits;
  readonly materializeDir: () => Promise<string>;
  /** Injected in tests; production resolves the real SDK through managed identity. */
  readonly containerClientFactory?: () => Promise<ContainerClientLike>;
}

const uploadBufferBytes = 4 * 1024 * 1024;
const uploadConcurrency = 2;

/**
 * Hosted store backed by a private Azure Blob container. Authentication always uses managed
 * identity (or the local developer credential); account keys, SAS and public URLs are never used.
 */
export class AzureBlobAssetStore implements AssetStore {
  public readonly kind = 'azure-blob' as const;
  private clientPromise: Promise<ContainerClientLike> | undefined;

  public constructor(private readonly options: AzureBlobAssetStoreOptions) {}

  public async check(): Promise<void> {
    const container = await this.client();
    if (!(await container.exists())) {
      throw upstreamError('The configured asset container is not reachable');
    }
  }

  public async put(upload: AssetUpload): Promise<AssetMetadata> {
    const remainingQuotaBytes = assertWithinQuota(
      await this.usage(upload.principal),
      this.options.limits,
    );
    const container = await this.client();
    const assetId = newAssetId();
    const filename = sanitizeFilename(upload.filename);
    const createdAt = new Date();
    const expiresAt = expiryFrom(createdAt, this.options.limits.ttlSeconds);
    const contentType = guessContentType(filename, upload.contentType);
    const blob = container.getBlockBlobClient(this.blobName(upload.principal, assetId));
    const metered = meterStream(upload.body, this.options.limits.maxBytes, remainingQuotaBytes);

    try {
      await blob.uploadStream(metered.stream, uploadBufferBytes, uploadConcurrency, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      const metadata: AssetMetadata = {
        assetId,
        filename,
        contentType,
        sizeBytes: metered.sizeBytes(),
        sha256: metered.digest(),
        createdAt: createdAt.toISOString(),
        expiresAt,
      };
      // Size and checksum are only known once the body has finished streaming.
      await blob.setMetadata(this.toBlobMetadata(metadata));
      return metadata;
    } catch (error) {
      await blob.deleteIfExists().catch(() => undefined);
      throw error;
    }
  }

  public async head(assetId: string, principal: string): Promise<AssetMetadata> {
    const container = await this.client();
    const blob = container.getBlockBlobClient(this.blobName(principal, assertAssetId(assetId)));
    const properties = await blob.getProperties().catch(() => undefined);
    if (!properties) return assetNotFound();
    const metadata = this.fromBlobMetadata(properties.metadata, properties.contentLength);
    if (!metadata || isExpired(metadata)) {
      await blob.deleteIfExists().catch(() => undefined);
      return assetNotFound();
    }
    return metadata;
  }

  public async list(principal: string): Promise<readonly AssetMetadata[]> {
    const container = await this.client();
    const assets: AssetMetadata[] = [];
    for await (const blob of container.listBlobsFlat({
      prefix: `${ownerKey(principal)}/`,
      includeMetadata: true,
    })) {
      const metadata = this.fromBlobMetadata(blob.metadata, undefined);
      if (metadata && !isExpired(metadata)) assets.push(metadata);
    }
    return assets;
  }

  public async remove(assetId: string, principal: string): Promise<void> {
    const container = await this.client();
    await container
      .getBlockBlobClient(this.blobName(principal, assertAssetId(assetId)))
      .deleteIfExists();
  }

  public async materialize(assetId: string, principal: string): Promise<MaterializedAsset> {
    const metadata = await this.head(assetId, principal);
    const container = await this.client();
    const blob = container.getBlockBlobClient(this.blobName(principal, metadata.assetId));
    const download = await blob.download().catch(() => undefined);
    if (!download?.readableStreamBody) return assetNotFound();

    const target = join(await this.options.materializeDir(), randomBytes(16).toString('hex'));
    const metered = meterStream(
      download.readableStreamBody as unknown as Readable,
      this.options.limits.maxBytes,
    );
    try {
      await pipeline(metered.stream, createWriteStream(target, { mode: 0o600 }));
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return {
      metadata,
      path: target,
      dispose: async () => {
        await rm(target, { force: true });
      },
    };
  }

  /** Expiry is enforced on read; bulk deletion is handled by the storage lifecycle policy. */
  public async sweep(): Promise<number> {
    return Promise.resolve(0);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private blobName(principal: string, assetId: string): string {
    return `${ownerKey(principal)}/${assetId}`;
  }

  private toBlobMetadata(metadata: AssetMetadata): Record<string, string> {
    return {
      assetid: metadata.assetId,
      filename: metadata.filename,
      contenttype: metadata.contentType,
      sizebytes: String(metadata.sizeBytes),
      sha256: metadata.sha256,
      createdat: metadata.createdAt,
      expiresat: metadata.expiresAt,
    };
  }

  private fromBlobMetadata(
    raw: Record<string, string> | undefined,
    contentLength: number | undefined,
  ): AssetMetadata | undefined {
    if (!raw?.assetid || !raw.expiresat) return undefined;
    return {
      assetId: raw.assetid,
      filename: raw.filename ?? 'upload.bin',
      contentType: raw.contenttype ?? 'application/octet-stream',
      sizeBytes: Number.parseInt(raw.sizebytes ?? '', 10) || contentLength || 0,
      sha256: raw.sha256 ?? '',
      createdAt: raw.createdat ?? raw.expiresat,
      expiresAt: raw.expiresat,
    };
  }

  private async usage(principal: string): Promise<{ count: number; bytes: number }> {
    const assets = await this.list(principal);
    return {
      count: assets.length,
      bytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
    };
  }

  private client(): Promise<ContainerClientLike> {
    this.clientPromise ??= this.options.containerClientFactory
      ? this.options.containerClientFactory()
      : this.createSdkClient();
    return this.clientPromise;
  }

  private async createSdkClient(): Promise<ContainerClientLike> {
    const [{ BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([
      import('@azure/storage-blob'),
      import('@azure/identity'),
    ]);
    const credential = new DefaultAzureCredential(
      this.options.clientId ? { managedIdentityClientId: this.options.clientId } : {},
    );
    const service = new BlobServiceClient(
      `https://${this.options.account}.blob.core.windows.net`,
      credential,
    );
    return service.getContainerClient(this.options.container);
  }
}
