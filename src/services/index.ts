import type { AppConfig } from '../config/index.js';
import { createRuntime, type Runtime } from '../runtime/index.js';
import { createAssetStore, type AssetStore } from './assets/index.js';
import { DataCruncherService } from './data-cruncher.js';

export type {
  DataReference,
  JsonQueryResult,
  RipgrepMatch,
  RipgrepResult,
} from './data-cruncher.js';
export { DataCruncherService } from './data-cruncher.js';

export interface Services {
  readonly runtime: Runtime;
  readonly assets: AssetStore;
  readonly dataCruncher: DataCruncherService;
}

export interface CreateServicesOptions {
  readonly runtime?: Runtime;
  readonly assetStore?: AssetStore;
}

export const createServices = (
  config: AppConfig,
  options: CreateServicesOptions = {},
): Services => {
  const runtime = options.runtime ?? createRuntime(config);
  const assets =
    options.assetStore ??
    createAssetStore(config, async () => (await runtime.workspace()).materializeDir);
  return { runtime, assets, dataCruncher: new DataCruncherService(config, runtime, assets) };
};
