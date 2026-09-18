import { readFile } from 'node:fs/promises';
import { runDeploymentContractConformance } from '@agent-tool-platform/testkit';
import { describe, expect, it } from 'vitest';
import { capability } from '../../src/capability.js';

interface Declaration {
  readonly capability: { readonly id: string; readonly repository: string };
  readonly profiles: readonly [
    {
      readonly id: string;
      readonly dimensions: Record<string, string>;
      readonly requiredSecrets: readonly string[];
      readonly providerPrerequisites: readonly unknown[];
      readonly delivery: {
        readonly publication: { readonly identifier: string };
        readonly entrypoint: { readonly reference: string; readonly interface: string };
      };
      readonly configuration: {
        readonly schema: {
          readonly id: string;
          readonly capabilityId: string;
          readonly path: string;
        };
        readonly bounded: boolean;
      };
      readonly workload?: unknown;
      readonly mutation?: unknown;
    },
  ];
}

const load = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

describe('local filesystem capability profile truthfulness', () => {
  it('passes the published Platform v1 declaration contract', async () => {
    const declaration = await load('../../capability-profiles.json');
    expect(runDeploymentContractConformance({ declaration }).failures).toEqual([]);
  });

  it('matches repository, package, entrypoint, and configuration identities', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const server = (await load('../../server.json')) as {
      readonly name: string;
      readonly repository: { readonly url: string };
    };
    const manifest = (await load('../../package.json')) as {
      readonly name: string;
      readonly version: string;
    };
    const profile = declaration.profiles[0];

    expect(declaration.capability).toEqual({
      id: server.name,
      displayName: capability.manifest.title,
      repository: server.repository.url,
    });
    expect(profile.delivery.publication.identifier).toBe(manifest.name);
    expect(capability.manifest.version).toBe(manifest.version);
    expect(profile.delivery.entrypoint).toEqual({
      reference: 'dist/stdio.js',
      interface: 'stdio',
    });

    const schema = (await load(`../../${profile.configuration.schema.path}`)) as {
      readonly $id: string;
    };
    expect(profile.configuration).toEqual({
      schema: {
        id: schema.$id,
        capabilityId: declaration.capability.id,
        path: 'schemas/local-configuration.schema.json',
      },
      bounded: true,
    });
  });

  it('declares all six local filesystem, read-only dimensions', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles[0];
    expect(profile.id).toBe('local-package');
    expect(profile.dimensions).toEqual({
      execution: 'local',
      delivery: 'package',
      access: 'local-process',
      workload: 'filesystem',
      provider: 'none',
      mutation: 'read-only',
    });
    expect(profile.requiredSecrets).toEqual([]);
    expect(profile.providerPrerequisites).toEqual([]);
    expect(profile.workload).toBeDefined();
    expect(profile).not.toHaveProperty('mutation');
    expect(capability.tools.every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('contains no hosted, container, provider, or external secret promise', async () => {
    const declaration = await load('../../capability-profiles.json');
    const serialized = JSON.stringify(declaration);
    expect(serialized).not.toMatch(
      /subscription|tenant|key.?vault|resource.?group|container.?app|production endpoint/iu,
    );
    expect(serialized).not.toContain('secretValue');
    expect(serialized).not.toContain('"hosted"');
    expect(serialized).not.toContain('"container"');
  });
});
