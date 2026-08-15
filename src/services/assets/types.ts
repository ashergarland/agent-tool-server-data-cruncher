import type { Readable } from 'node:stream';

export interface AssetMetadata {
  readonly assetId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AssetUpload {
  readonly principal: string;
  readonly filename: string;
  readonly contentType: string | undefined;
  readonly body: Readable;
}

export interface MaterializedAsset {
  readonly metadata: AssetMetadata;
  /** Server-side temporary path. Never returned to callers. */
  readonly path: string;
  dispose(): Promise<void>;
}

export interface AssetStore {
  readonly kind: 'disabled' | 'filesystem' | 'azure-blob';
  /** Verifies configuration and connectivity without touching caller data. */
  check(): Promise<void>;
  put(upload: AssetUpload): Promise<AssetMetadata>;
  head(assetId: string, principal: string): Promise<AssetMetadata>;
  list(principal: string): Promise<readonly AssetMetadata[]>;
  remove(assetId: string, principal: string): Promise<void>;
  materialize(assetId: string, principal: string): Promise<MaterializedAsset>;
  sweep(): Promise<number>;
  close(): Promise<void>;
}
