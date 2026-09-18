import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { capability } from '../../src/capability.js';
import type { DataCruncherConfig } from '../../src/config/index.js';
import type { DataCruncherServices } from '../../src/services/index.js';

export type DataCruncherApplication = AgentToolApplication<
  DataCruncherConfig,
  DataCruncherServices
>;

export interface DataHarness {
  readonly application: DataCruncherApplication;
  readonly root: string;
  readonly scratchParent: string;
  readonly base: string;
  cleanup(): Promise<void>;
}

export interface CreateHarnessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly start?: boolean;
}

export const createHarness = async (options: CreateHarnessOptions = {}): Promise<DataHarness> => {
  const base = await mkdtemp(join(tmpdir(), 'data-cruncher-test-'));
  const root = join(base, 'data');
  const scratchParent = join(base, 'scratch');
  await Promise.all([mkdir(root, { recursive: true }), mkdir(scratchParent, { recursive: true })]);

  const application = await createAgentToolApplication(capability, {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      DATA_ROOT: root,
      TEMP_DIR: scratchParent,
      ...options.env,
    },
    readinessCacheMs: 0,
    drainTimeoutMs: 5000,
  });
  if (options.start !== false) await application.start();

  return {
    application,
    root,
    scratchParent,
    base,
    async cleanup() {
      await application.shutdown();
      await rm(base, { recursive: true, force: true });
    },
  };
};
