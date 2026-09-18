import { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import type { CapabilityContext } from '@agent-tool-platform/runtime/capability';
import { RootBoundary } from '@agent-tool-platform/runtime/fs';
import type { ScratchWorkspace } from '@agent-tool-platform/runtime/lifecycle';
import type { DataCruncherConfig } from '../config/index.js';
import { DataCruncherService } from '../domain/data-cruncher.js';
import { DataToolchain } from '../domain/toolchain.js';

export interface DataCruncherServices {
  readonly dataCruncher: DataCruncherService;
  readonly workspace: RootBoundary;
  readonly queue: BoundedQueue;
  readonly toolchain: DataToolchain;
  readonly scratch: ScratchWorkspace;
}

export const createDataCruncherServices = async (
  context: CapabilityContext<DataCruncherConfig>,
): Promise<DataCruncherServices> => {
  const { config } = context;
  const scratch = await context.createScratchWorkspace({
    prefix: 'data-cruncher-',
    ...(config.execution.tempDir === undefined
      ? {}
      : { parentDirectory: config.execution.tempDir }),
  });
  const workspace = new RootBoundary({
    root: config.data.root,
    requireRegularFile: true,
    maxFileBytes: config.execution.limits.maxFileBytes,
  });
  const queue = new BoundedQueue(
    config.execution.limits.toolConcurrency,
    config.execution.limits.toolQueueLimit,
    'data reduction work',
  );
  const toolchain = new DataToolchain(config, scratch.path);
  const dataCruncher = new DataCruncherService(
    config.execution.limits,
    workspace,
    queue,
    toolchain,
  );
  return { dataCruncher, workspace, queue, toolchain, scratch };
};
