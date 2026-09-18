import {
  defineAgentToolCapability,
  type CapabilityContext,
} from '@agent-tool-platform/runtime/capability';
import { readinessNotReady, readinessReady } from '@agent-tool-platform/runtime/lifecycle';
import { approximateTokens, jsonByteLength } from '@agent-tool-platform/runtime/telemetry';
import type { InvocationMeasurement } from '@agent-tool-platform/runtime/telemetry';
import {
  dataCruncherConfigSpec,
  type DataCruncherConfig,
  type dataCruncherEnvSchema,
} from './config/index.js';
import { capabilityManifest } from './manifest.js';
import { createDataCruncherServices, type DataCruncherServices } from './services/index.js';
import { capabilityTools } from './tools/definitions.js';
import { capabilityInstructions } from './tools/guidance.js';

interface MeasurableResult {
  readonly scannedBytes?: unknown;
  readonly truncated?: unknown;
}

export const estimateDataCruncherInvocation = (
  output: unknown,
): InvocationMeasurement | undefined => {
  if (typeof output !== 'object' || output === null) return undefined;
  const result = output as MeasurableResult;
  if (
    typeof result.scannedBytes !== 'number' ||
    !Number.isFinite(result.scannedBytes) ||
    result.scannedBytes < 0
  ) {
    return undefined;
  }
  const sourceBytes = Math.floor(result.scannedBytes);
  const outputBytes = jsonByteLength(output);
  const rawEquivalentTokens = approximateTokens(sourceBytes);
  const resultTokens = approximateTokens(outputBytes);
  return {
    sourceBytes,
    outputBytes,
    rawEquivalentTokens,
    resultTokens,
    estimatedTokensAvoided: Math.max(0, rawEquivalentTokens - resultTokens),
    truncated: result.truncated === true,
    fallback: false,
  };
};

export const capability = defineAgentToolCapability<
  DataCruncherServices,
  DataCruncherConfig,
  typeof dataCruncherEnvSchema
>({
  manifest: capabilityManifest,
  instructions: capabilityInstructions,
  config: dataCruncherConfigSpec,
  tools: capabilityTools,

  createServices(context: CapabilityContext<DataCruncherConfig>) {
    return createDataCruncherServices(context);
  },

  readiness: [
    async ({ services }) => {
      const status = await services.workspace.status();
      return status.usable
        ? readinessReady('data_root')
        : readinessNotReady('data_root', status.reason ?? 'data_root_unusable');
    },
    async ({ services }) => {
      try {
        const tooling = await services.toolchain.tooling();
        return readinessReady(
          'data_tooling',
          `jq ${tooling.jq.version}; ripgrep ${tooling.ripgrep.version}`,
        );
      } catch {
        return readinessNotReady('data_tooling', 'jq_or_ripgrep_unavailable');
      }
    },
    ({ services }) => {
      const stats = services.queue.stats;
      const accepting =
        !stats.closed && (stats.active < stats.concurrency || stats.queued < stats.queueLimit);
      return accepting
        ? readinessReady('data_capacity')
        : readinessNotReady('data_capacity', 'data_queue_saturated');
    },
  ],

  lifecycle: {
    async stop({ services }) {
      await services.queue.drain();
    },
  },

  telemetry: {
    estimateInvocation: ({ output }) => estimateDataCruncherInvocation(output),
  },
});
