import type { AppConfig } from '../config/index.js';
import { DataCruncherService } from './data-cruncher.js';

export interface Services {
  readonly dataCruncher: DataCruncherService;
}

export const createServices = (config: AppConfig): Services => ({
  dataCruncher: new DataCruncherService(config.data.root),
});
