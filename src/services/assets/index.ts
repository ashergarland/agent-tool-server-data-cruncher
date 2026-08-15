import { forbidden } from '../../errors.js';
import type { AppConfig } from '../../config/index.js';
import { AzureBlobAssetStore } from './azure-blob-store.js';
import { FilesystemAssetStore } from './filesystem-store.js';
import type { AssetMetadata, AssetStore, MaterializedAsset } from './types.js';

export type { AssetMetadata, AssetStore, AssetUpload, MaterializedAsset } from './types.js';
export { AzureBlobAssetStore } from './azure-blob-store.js';
export { FilesystemAssetStore } from './filesystem-store.js';

export interface AssetLimits {
  readonly maxBytes: number;
  readonly ttlSeconds: number;
  readonly quotaBytes: number;
  readonly quotaCount: number;
}

const unavailable = (): Promise<never> =>
  Promise.reject(forbidden('Asset storage is not enabled on this deployment'));

export class DisabledAssetStore implements AssetStore {
  public readonly kind = 'disabled' as const;

  public check(): Promise<void> {
    return Promise.resolve();
  }
  public put(): Promise<AssetMetadata> {
    return unavailable();
  }
  public head(): Promise<AssetMetadata> {
    return unavailable();
  }
  public list(): Promise<readonly AssetMetadata[]> {
    return unavailable();
  }
  public remove(): Promise<void> {
    return unavailable();
  }
  public materialize(): Promise<MaterializedAsset> {
    return unavailable();
  }
  public sweep(): Promise<number> {
    return Promise.resolve(0);
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

export const createAssetStore = (
  config: AppConfig,
  materializeDir: () => Promise<string>,
): AssetStore => {
  const limits: AssetLimits = {
    maxBytes: config.assets.maxBytes,
    ttlSeconds: config.assets.ttlSeconds,
    quotaBytes: config.assets.quotaBytes,
    quotaCount: config.assets.quotaCount,
  };
  const store = config.assets.store;
  if (store.kind === 'filesystem') {
    return new FilesystemAssetStore({ root: store.root, limits, materializeDir });
  }
  if (store.kind === 'azure-blob') {
    return new AzureBlobAssetStore({
      account: store.account,
      container: store.container,
      clientId: store.clientId,
      limits,
      materializeDir,
    });
  }
  return new DisabledAssetStore();
};
