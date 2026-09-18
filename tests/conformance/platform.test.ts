import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RootBoundary } from '@agent-tool-platform/runtime/fs';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import {
  generateTestApiKey,
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runProcessConformance,
  runRegistryConformance,
  runRootBoundaryConformance,
  runRoutingConformance,
  runScratchWorkspaceConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { dataCruncherConfigSpec } from '../../src/config/index.js';
import { capabilityManifest } from '../../src/manifest.js';
import { capabilityTools } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';
import { createHarness, type DataHarness } from '../helpers/harness.js';

const apiKey = generateTestApiKey();
const harnesses: DataHarness[] = [];
const makeHarness = async (start = true): Promise<DataHarness> => {
  const harness = await createHarness({
    start,
    env: { AUTH_MODE: 'api-key', API_KEYS: apiKey },
  });
  harnesses.push(harness);
  await writeFile(join(harness.root, 'sample.json'), '{"items":[1,2,3]}\n', 'utf8');
  return harness;
};

const readSample = {
  name: 'query_json_jq',
  input: {
    source: { kind: 'local_path', path: 'sample.json' },
    filter: '.items | length',
  },
} as const;

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe('Platform conformance', () => {
  it('satisfies registry and routing contracts', async () => {
    const harness = await makeHarness();
    const registry = createToolRegistry(capabilityTools);
    expect(
      (
        await runRegistryConformance({
          registry,
          services: harness.application.services,
          invalidInputSample: {
            name: 'query_json_jq',
            input: { source: { kind: 'local_path', path: 'sample.json' }, filter: 42 },
          },
        })
      ).failures,
    ).toEqual([]);
    expect(
      runRoutingConformance({ registry, instructions: capabilityInstructions }).failures,
    ).toEqual([]);
  });

  it('satisfies authentication and composed configuration contracts', async () => {
    expect((await runAuthConformance()).failures).toEqual([]);
    expect(
      (
        await runConfigConformance({
          spec: dataCruncherConfigSpec,
          serviceName: capabilityManifest.name,
          serviceVersion: capabilityManifest.version,
          invalidEnvironments: [
            {
              reason: 'default output cannot exceed the deployment output ceiling',
              env: { DEFAULT_OUTPUT_BYTES: '4096', MAX_OUTPUT_BYTES: '1024' },
            },
          ],
          expect: (config) => config.execution.limits.maxFileBytes > 0,
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies HTTP, MCP, OpenAPI, and transport parity contracts', async () => {
    const harness = await makeHarness();
    const application = harness.application;
    expect(
      (
        await runHttpConformance({
          app: application.http,
          registry: application.registry,
          apiKey,
          readSample: { name: readSample.name, body: readSample.input },
        })
      ).failures,
    ).toEqual([]);
    expect(
      (
        await runMcpConformance({
          createServer: () => application.createStdioServer(),
          registry: application.registry,
          instructions: capabilityInstructions,
          readSample,
        })
      ).failures,
    ).toEqual([]);
    expect(
      runOpenApiConformance({
        document: application.openApiDocument(),
        registry: application.registry,
      }).failures,
    ).toEqual([]);
    expect(
      (
        await runTransportParity({
          app: application.http,
          createMcpServer: () => application.createStdioServer(),
          apiKey,
          samples: [readSample],
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies lifecycle and lifecycle-owned scratch contracts', async () => {
    expect(
      (
        await runLifecycleConformance({
          createApplication: async () => (await makeHarness(false)).application,
        })
      ).failures,
    ).toEqual([]);
    expect(
      (
        await runScratchWorkspaceConformance({
          createApplication: async () => {
            const harness = await makeHarness(false);
            return {
              application: harness.application,
              workspace: harness.application.services.scratch,
            };
          },
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies safe process and descriptor-backed root-boundary contracts', async () => {
    expect((await runProcessConformance()).failures).toEqual([]);
    expect(
      (
        await runRootBoundaryConformance({
          createBoundary: (root) =>
            new RootBoundary({ root, requireRegularFile: true, maxFileBytes: 64 * 1024 * 1024 }),
        })
      ).failures,
    ).toEqual([]);
  });

  it('publishes truthful repository metadata', async () => {
    const load = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    expect(
      runMetadataConformance({
        server: await load('../../server.json'),
        packageManifest: await load('../../package.json'),
        registryEntry: await load('../../examples/central-registry-entry.json'),
      }).failures,
    ).toEqual([]);
  });
});
