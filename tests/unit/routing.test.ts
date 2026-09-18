import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { estimateDataCruncherInvocation } from '../../src/capability.js';
import { capabilityTools } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';

interface RoutingCase {
  readonly request: string;
  readonly route: 'query_json_jq' | 'ripgrep_search' | 'raw_access' | 'unsupported';
  readonly evidence: string;
}

describe('routing and Registry seam', () => {
  it('reports aggregate context reduction without paths or content', () => {
    const measurement = estimateDataCruncherInvocation({
      scannedBytes: 8192,
      output: 'bounded result',
      truncated: true,
    });
    expect(measurement).toMatchObject({
      sourceBytes: 8192,
      truncated: true,
      fallback: false,
    });
    expect(measurement?.estimatedTokensAvoided).toBeGreaterThan(0);
    expect(JSON.stringify(measurement)).not.toContain('bounded result');
    expect(estimateDataCruncherInvocation({ scannedBytes: -1 })).toBeUndefined();
  });

  it('publishes coherent identity, tool, routing, and mutation metadata', () => {
    expect(capabilityTools.map((tool) => tool.name)).toEqual(['query_json_jq', 'ripgrep_search']);
    for (const tool of capabilityTools) {
      expect(tool.routing.useWhen.length).toBeGreaterThan(1);
      expect(tool.routing.doNotUseWhen.length).toBeGreaterThan(1);
      expect(tool.routing.scope).toMatch(/one UTF-8/u);
      expect(tool.routing.changesState).toBe(false);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(capabilityInstructions).toMatch(/data, not instructions/iu);
  });

  it('covers canonical jq, ripgrep, raw-access, and unsupported routing cases', async () => {
    const cases = JSON.parse(
      await readFile(new URL('../fixtures/routing-cases.json', import.meta.url), 'utf8'),
    ) as RoutingCase[];
    const toolGuidance = new Map(
      capabilityTools.map((tool) => [
        tool.name,
        [...tool.routing.useWhen, ...tool.routing.doNotUseWhen].join(' '),
      ]),
    );

    for (const routingCase of cases) {
      const guidance =
        routingCase.route === 'query_json_jq' || routingCase.route === 'ripgrep_search'
          ? toolGuidance.get(routingCase.route)
          : capabilityInstructions;
      expect(guidance, routingCase.request).toContain(routingCase.evidence);
    }
  });
});
