import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import type { BoundedProcessResult } from '@agent-tool-platform/runtime/process';
import { afterEach, describe, expect, it } from 'vitest';
import { DataCruncherService, type DataProcessRunner } from '../../src/domain/data-cruncher.js';
import { assertNoModuleDirectives } from '../../src/domain/jq-filter.js';
import { createHarness, type DataHarness } from '../helpers/harness.js';

const harnesses: DataHarness[] = [];
const makeHarness = async (env: NodeJS.ProcessEnv = {}): Promise<DataHarness> => {
  const harness = await createHarness({ env });
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

const signal = (): AbortSignal => new AbortController().signal;

const completedProcess = (stdout: string, stdinBytes: number): BoundedProcessResult => ({
  code: 0,
  terminationSignal: null,
  stdout,
  stderr: '',
  stdoutBytes: Buffer.byteLength(stdout),
  stdinBytes,
  timedOut: false,
  aborted: false,
  outputLimitReached: false,
  stoppedEarly: false,
  durationMs: 1,
});

describe('jq structured reduction', () => {
  it('projects JSON and preserves JSONL inputs semantics', async () => {
    const harness = await makeHarness();
    await writeFile(
      join(harness.root, 'records.json'),
      JSON.stringify({
        items: [
          { id: 1, state: 'ok' },
          { id: 2, state: 'failed' },
        ],
      }),
      'utf8',
    );
    await writeFile(join(harness.root, 'records.jsonl'), '{"id":1}\n{"id":2}\n', 'utf8');

    const projected = await harness.application.services.dataCruncher.queryJson(
      'records.json',
      { filter: '[.items[] | select(.state == "failed") | .id]' },
      signal(),
    );
    expect(JSON.parse(projected.output)).toEqual([2]);
    expect(projected.scannedBytes).toBeGreaterThan(0);
    expect(projected.truncated).toBe(false);

    const streamed = await harness.application.services.dataCruncher.queryJson(
      'records.jsonl',
      { filter: 'inputs | .id' },
      signal(),
    );
    expect(streamed.output).toBe('2');
  });

  it('protects filters beginning with a dash and skips a UTF-8 BOM', async () => {
    const harness = await makeHarness();
    await writeFile(
      join(harness.root, 'bom.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    );

    const result = await harness.application.services.dataCruncher.queryJson(
      'bom.json',
      { filter: '-1' },
      signal(),
    );
    expect(result.output).toBe('-1');
    expect(result.warnings).toContain('A UTF-8 byte order mark was skipped.');
  });

  it('rejects invalid filters, malformed JSON, binary input, and module directives', async () => {
    const harness = await makeHarness();
    await writeFile(join(harness.root, 'valid.json'), '{}', 'utf8');
    await writeFile(join(harness.root, 'invalid.json'), '{"broken":', 'utf8');
    await writeFile(join(harness.root, 'binary.json'), Buffer.from([0x7b, 0x00, 0x7d]));

    await expect(
      harness.application.services.dataCruncher.queryJson('valid.json', { filter: '.[' }, signal()),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.application.services.dataCruncher.queryJson(
        'invalid.json',
        { filter: '.' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.application.services.dataCruncher.queryJson('binary.json', { filter: '.' }, signal()),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.application.services.dataCruncher.queryJson(
        'valid.json',
        { filter: 'import "../outside" as $outside; $outside' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.application.services.dataCruncher.queryJson('valid.json', { filter: '' }, signal()),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.application.services.dataCruncher.queryJson(
        'valid.json',
        { filter: '.', maxOutputBytes: 100 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });

    expect(() => assertNoModuleDirectives('{"import": .value, note: "include x"}')).not.toThrow();
  });

  it('truncates only at complete jq result boundaries', async () => {
    const harness = await makeHarness({
      MAX_OUTPUT_BYTES: '4096',
      DEFAULT_OUTPUT_BYTES: '1024',
    });
    await writeFile(
      join(harness.root, 'many.json'),
      JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ index, state: 'ready' }))),
      'utf8',
    );

    const result = await harness.application.services.dataCruncher.queryJson(
      'many.json',
      { filter: '.[]', maxOutputBytes: 1024 },
      signal(),
    );
    expect(result.truncated).toBe(true);
    expect(result.returnedBytes).toBeLessThanOrEqual(1024);
    for (const line of result.output.split('\n')) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('rejects a single jq value that cannot be safely truncated', async () => {
    const harness = await makeHarness({
      MAX_OUTPUT_BYTES: '4096',
      DEFAULT_OUTPUT_BYTES: '1024',
    });
    await writeFile(
      join(harness.root, 'large-value.json'),
      JSON.stringify('x'.repeat(5000)),
      'utf8',
    );

    await expect(
      harness.application.services.dataCruncher.queryJson(
        'large-value.json',
        { filter: '.', maxOutputBytes: 1024 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});

describe('ripgrep bounded log search', () => {
  it('returns matching lines in source order with one-based line numbers', async () => {
    const harness = await makeHarness();
    await writeFile(
      join(harness.root, 'runtime.log'),
      'boot\nlistener address=0.0.0.0 port=3000\nnoise\nreadiness port=8080 refused\n',
      'utf8',
    );

    const result = await harness.application.services.dataCruncher.ripgrep(
      'runtime.log',
      { pattern: 'listener|readiness', maxResults: 10 },
      signal(),
    );
    expect(result.matches).toEqual([
      {
        lineNumber: 2,
        line: 'listener address=0.0.0.0 port=3000',
        lineTruncated: false,
      },
      {
        lineNumber: 4,
        line: 'readiness port=8080 refused',
        lineTruncated: false,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('bounds match count, line length, and process output', async () => {
    const harness = await makeHarness({
      MAX_LINE_LENGTH: '64',
      MAX_OUTPUT_BYTES: '1024',
      DEFAULT_OUTPUT_BYTES: '1024',
      MAX_MATCHES: '100',
    });
    const line = `ERROR ${'x'.repeat(500)}`;
    await writeFile(
      join(harness.root, 'bounded.log'),
      Array.from({ length: 50 }, () => line).join('\n'),
      'utf8',
    );

    const result = await harness.application.services.dataCruncher.ripgrep(
      'bounded.log',
      { pattern: 'ERROR', maxResults: 100 },
      signal(),
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((match) => match.line.length <= 64)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/byte limit|Result limit/u);
  });

  it('marks the configured result ceiling and handles no matches', async () => {
    const harness = await makeHarness({ MAX_MATCHES: '2' });
    await writeFile(
      join(harness.root, 'events.log'),
      'ERROR one\nERROR two\nERROR three\n',
      'utf8',
    );

    const limited = await harness.application.services.dataCruncher.ripgrep(
      'events.log',
      { pattern: 'ERROR', maxResults: 50 },
      signal(),
    );
    expect(limited.matchCount).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(limited.warnings.join(' ')).toMatch(/clamped|Result limit/u);

    const empty = await harness.application.services.dataCruncher.ripgrep(
      'events.log',
      { pattern: 'NOTICE', maxResults: 10 },
      signal(),
    );
    expect(empty).toMatchObject({ matches: [], matchCount: 0, truncated: false });
  });

  it('returns a deterministic sanitized invalid-pattern error', async () => {
    const harness = await makeHarness();
    await writeFile(join(harness.root, 'events.log'), 'ERROR one\n', 'utf8');

    const request = harness.application.services.dataCruncher.ripgrep(
      'events.log',
      { pattern: '[', maxResults: 10 },
      signal(),
    );
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'bad_request', message: 'ripgrep rejected the pattern' });
    expect(JSON.stringify(error)).not.toContain(harness.root);
    await expect(
      harness.application.services.dataCruncher.ripgrep(
        'events.log',
        { pattern: 'ERROR', maxResults: 0 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('process and filesystem security boundaries', () => {
  it('gives jq only a minimal scratch-scoped environment with no ambient secrets', async () => {
    const inherited = {
      DATA_CRUNCHER_PARENT_SECRET: process.env['DATA_CRUNCHER_PARENT_SECRET'],
      API_KEYS: process.env['API_KEYS'],
      AZURE_CLIENT_SECRET: process.env['AZURE_CLIENT_SECRET'],
      NODE_OPTIONS: process.env['NODE_OPTIONS'],
      JQ_LIBRARY_PATH: process.env['JQ_LIBRARY_PATH'],
      RIPGREP_CONFIG_PATH: process.env['RIPGREP_CONFIG_PATH'],
    };
    Object.assign(process.env, {
      DATA_CRUNCHER_PARENT_SECRET: 'must-not-reach-jq',
      API_KEYS: 'must-not-reach-jq',
      AZURE_CLIENT_SECRET: 'must-not-reach-jq',
      NODE_OPTIONS: '--no-warnings',
      JQ_LIBRARY_PATH: resolve('must-not-reach-jq'),
      RIPGREP_CONFIG_PATH: resolve('must-not-reach-jq'),
    });

    try {
      const harness = await makeHarness();
      await writeFile(join(harness.root, 'value.json'), '{}', 'utf8');
      const result = await harness.application.services.dataCruncher.queryJson(
        'value.json',
        {
          filter:
            '{parent: (env | has("DATA_CRUNCHER_PARENT_SECRET")), api: (env | has("API_KEYS")), azure: (env | has("AZURE_CLIENT_SECRET")), node: (env | has("NODE_OPTIONS")), jq: (env | has("JQ_LIBRARY_PATH")), rg: (env | has("RIPGREP_CONFIG_PATH")), dollarParent: ($ENV | has("DATA_CRUNCHER_PARENT_SECRET")), home: env.HOME, tmp: env.TMP, keys: (env | keys)}',
        },
        signal(),
      );
      const exposed = JSON.parse(result.output) as Record<string, unknown>;
      expect(exposed).toMatchObject({
        parent: false,
        api: false,
        azure: false,
        node: false,
        jq: false,
        rg: false,
        dollarParent: false,
        home: harness.application.services.scratch.path,
        tmp: harness.application.services.scratch.path,
      });
      const keys = exposed['keys'] as string[];
      expect(keys).not.toEqual(
        expect.arrayContaining([
          'DATA_CRUNCHER_PARENT_SECRET',
          'API_KEYS',
          'AZURE_CLIENT_SECRET',
          'NODE_OPTIONS',
          'JQ_LIBRARY_PATH',
          'RIPGREP_CONFIG_PATH',
        ]),
      );

      const tooling = await harness.application.services.toolchain.tooling();
      const allowed = [
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'TEMP',
        'TMP',
        'TMPDIR',
        ...(process.platform === 'win32'
          ? ['SystemRoot', 'windir'].filter((key) => process.env[key])
          : []),
      ].sort();
      expect(Object.keys(tooling.environment).sort()).toEqual(allowed);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects absolute paths, traversal, directories, oversized files, and symlink escapes', async () => {
    const harness = await makeHarness({ MAX_FILE_BYTES: '1024' });
    await writeFile(join(harness.root, 'valid.json'), '{}', 'utf8');
    await writeFile(join(harness.root, 'too-large.json'), 'x'.repeat(2048), 'utf8');
    const outside = join(harness.base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.json'), '{"secret":true}', 'utf8');
    const link = join(harness.root, 'outside-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const query = (path: string) =>
      harness.application.services.dataCruncher.queryJson(path, { filter: '.' }, signal());
    await expect(query(resolve(harness.root, 'valid.json'))).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(query('../outside/secret.json')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(query('.')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(query('too-large.json')).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(query('outside-link/secret.json')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('streams the opened object even when its addressed path is replaced', async () => {
    const harness = await makeHarness();
    const addressed = join(harness.root, 'race.json');
    const archived = join(harness.root, 'original.json');
    const original = '{"value":"original"}\n';
    await writeFile(addressed, original, 'utf8');

    const runner: DataProcessRunner = {
      async run(name, args, stdin) {
        void name;
        void args;
        await rename(addressed, archived);
        await writeFile(addressed, '{"value":"replacement"}\n', 'utf8');
        const chunks: Buffer[] = [];
        for await (const chunk of stdin) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Expected a buffer');
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks).toString('utf8');
        return completedProcess(content, Buffer.byteLength(content));
      },
    };
    const service = new DataCruncherService(
      harness.application.config.execution.limits,
      harness.application.services.workspace,
      new BoundedQueue(1, 0, 'race proof'),
      runner,
    );
    const result = await service.queryJson('race.json', { filter: '.' }, signal());
    expect(JSON.parse(result.output)).toEqual({ value: 'original' });
  });

  it('streams a representative multi-megabyte input while returning bounded evidence', async () => {
    const harness = await makeHarness({ MAX_FILE_BYTES: String(16 * 1024 * 1024) });
    const middle = 'ordinary runtime event\n'.repeat(220_000);
    const content = `listener port=3000\n${middle}readiness port=8080 refused\n`;
    await writeFile(join(harness.root, 'large.log'), content, 'utf8');

    const result = await harness.application.services.dataCruncher.ripgrep(
      'large.log',
      { pattern: 'listener|readiness', maxResults: 10 },
      signal(),
    );
    expect(result.scannedBytes).toBe(Buffer.byteLength(content));
    expect(result.scannedBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(result.matches.map((match) => match.line)).toEqual([
      'listener port=3000',
      'readiness port=8080 refused',
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
  });

  it('enforces queue admission, timeout, cancellation, and executable failures', async () => {
    const harness = await makeHarness({
      SUBPROCESS_TIMEOUT_MS: '100',
      TOOL_CONCURRENCY: '1',
      TOOL_QUEUE_LIMIT: '0',
    });
    await writeFile(join(harness.root, 'value.json'), '{}', 'utf8');

    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => {
      release = resolveBlocked;
    });
    const running = new Promise<void>((resolveRunning) => {
      entered = resolveRunning;
    });
    const runner: DataProcessRunner = {
      async run() {
        entered();
        await blocked;
        return completedProcess('{}\n', 2);
      },
    };
    const queuedService = new DataCruncherService(
      harness.application.config.execution.limits,
      harness.application.services.workspace,
      new BoundedQueue(1, 0, 'queue proof'),
      runner,
    );
    const first = queuedService.queryJson('value.json', { filter: '.' }, signal());
    await running;
    await expect(
      queuedService.queryJson('value.json', { filter: '.' }, signal()),
    ).rejects.toMatchObject({ code: 'busy' });
    release();
    await first;

    await expect(
      harness.application.services.dataCruncher.queryJson(
        'value.json',
        { filter: 'reduce range(0; 1000000000) as $i (0; . + $i)' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const cancelled = harness.application.services.dataCruncher.queryJson(
      'value.json',
      { filter: 'reduce range(0; 1000000000) as $i (0; . + $i)' },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(cancelled).rejects.toMatchObject({ code: 'busy' });

    const unavailable = await makeHarness({ JQ_PATH: join(harness.root, 'missing-jq') });
    await writeFile(join(unavailable.root, 'value.json'), '{}', 'utf8');
    await expect(
      unavailable.application.services.dataCruncher.queryJson(
        'value.json',
        { filter: '.' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('reports truthful readiness without exposing paths', async () => {
    const harness = await makeHarness();
    const report = await harness.application.readiness();
    expect(report.ready).toBe(true);
    expect(report.checks.map((check) => check.name).sort()).toEqual([
      'data_capacity',
      'data_root',
      'data_tooling',
      'registry',
    ]);
    expect(JSON.stringify(report)).not.toContain(harness.root);
    expect(JSON.stringify(report)).not.toContain(harness.application.services.scratch.path);
  });
});
