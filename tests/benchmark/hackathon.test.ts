import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type DataHarness } from '../helpers/harness.js';

const harnesses: DataHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe('Hackathon benchmark Level 1 reduction', () => {
  it('preserves chronological log and structured diagnostic facts without a production answer', async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const fixture = (name: string): URL =>
      new URL(`../fixtures/hackathon/${name}`, import.meta.url);
    await Promise.all([
      copyFile(fixture('deployment-output.txt'), join(harness.root, 'deployment-output.txt')),
      copyFile(fixture('diagnostics.json'), join(harness.root, 'diagnostics.json')),
    ]);

    const logs = await harness.application.services.dataCruncher.ripgrep(
      'deployment-output.txt',
      {
        pattern:
          'stage=(checkout|test|build).*status=success|source map upload returned 403|stage=push status=success|revision_create status=success|server_started|probe type=readiness|running_state=degraded|stage=readiness status=failure',
        maxResults: 20,
      },
      new AbortController().signal,
    );
    expect(logs.matches.map((match) => match.lineNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const chronologicalEvidence = logs.matches.map((match) => match.line).join('\n');
    expect(chronologicalEvidence).toContain('stage=checkout status=success');
    expect(chronologicalEvidence).toContain('stage=test status=success');
    expect(chronologicalEvidence).toContain('stage=build status=success');
    expect(chronologicalEvidence).toContain('source map upload returned 403');
    expect(chronologicalEvidence).toContain('continue_on_error=true');
    expect(chronologicalEvidence).toContain('"port":3000');
    expect(chronologicalEvidence.match(/port=8080 result=connection_refused/gu)).toHaveLength(3);
    expect(chronologicalEvidence).toContain('running_state=degraded ready_replicas=0');
    expect(chronologicalEvidence).toContain('stage=readiness status=failure');

    const diagnostics = await harness.application.services.dataCruncher.queryJson(
      'diagnostics.json',
      {
        filter:
          '{pipeline, listener: [.observations[] | select(.kind == "listener") | {address, port}], probe: [.observations[] | select(.kind == "probe") | {transport, port, attempts, failures, lastResult}], warnings}',
      },
      new AbortController().signal,
    );
    const reduced = JSON.parse(diagnostics.output) as {
      pipeline: Record<string, string>;
      listener: Array<{ address: string; port: number }>;
      probe: Array<{
        transport: string;
        port: number;
        attempts: number;
        failures: number;
        lastResult: string;
      }>;
      warnings: Array<{ component: string; status: number; pipelinePolicy: string }>;
    };
    expect(reduced.pipeline).toMatchObject({
      checkout: 'succeeded',
      test: 'succeeded',
      imageBuild: 'succeeded',
      imagePush: 'succeeded',
      revisionProvisioning: 'succeeded',
      readiness: 'failed',
    });
    expect(reduced.listener).toEqual([{ address: '0.0.0.0', port: 3000 }]);
    expect(reduced.probe).toEqual([
      {
        transport: 'tcp',
        port: 8080,
        attempts: 3,
        failures: 3,
        lastResult: 'connection_refused',
      },
    ]);
    expect(reduced.warnings).toEqual([
      { component: 'source-map-upload', status: 403, pipelinePolicy: 'continue-on-error' },
    ]);

    const production = (
      await Promise.all([
        readFile(new URL('../../src/domain/data-cruncher.ts', import.meta.url), 'utf8'),
        readFile(new URL('../../src/tools/definitions.ts', import.meta.url), 'utf8'),
        readFile(new URL('../../src/tools/guidance.ts', import.meta.url), 'utf8'),
      ])
    ).join('\n');
    expect(production).not.toContain('checkout-api');
    expect(production).not.toContain('PORT_BINDING_DRIFT');
  });
});
