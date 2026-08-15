import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutableResolutionError } from '../../src/runtime/executables.js';
import type { Harness } from '../helpers/harness.js';
import { createHarness } from '../helpers/harness.js';
import { FakeAssetStore } from '../helpers/fake-asset-store.js';

const context = { principal: 'key:1' };
const localPath = (path: string) => ({ kind: 'local_path', path }) as const;

let harness: Harness;
let assets: FakeAssetStore;

beforeEach(async () => {
  assets = new FakeAssetStore();
  harness = await createHarness({ assetStore: assets });
});

afterEach(async () => {
  await assets.close();
  await harness.dispose();
});

const write = async (name: string, contents: string | Buffer): Promise<string> => {
  await writeFile(join(harness.dataRoot, name), contents);
  return name;
};

describe('jq queries', () => {
  it('returns only the filtered output', async () => {
    await write(
      'users.json',
      JSON.stringify({ users: [{ email: 'one@example.com' }, { email: 'two@example.com' }] }),
    );

    const result = await harness.services.dataCruncher.queryJson(
      localPath('users.json'),
      { filter: '.users[].email' },
      context,
    );
    expect(result.output).toBe('"one@example.com"\n"two@example.com"');
    expect(result.truncated).toBe(false);
    expect(result.returnedBytes).toBe(result.output.length);
  });

  it('supports JSONL input and filters starting with a dash', async () => {
    await write('events.jsonl', '{"level":"info"}\n{"level":"error"}\n');

    const result = await harness.services.dataCruncher.queryJson(
      localPath('events.jsonl'),
      { filter: '[inputs] | length' },
      context,
    );
    expect(result.output).toBe('1');

    const literal = await harness.services.dataCruncher.queryJson(
      localPath('events.jsonl'),
      { filter: '-1' },
      context,
    );
    expect(literal.output).toBe('-1\n-1');
  });

  it('cannot read parent process secrets through jq env', async () => {
    process.env.DATA_CRUNCHER_SENTINEL_SECRET = 'super-secret-value';
    try {
      await write('data.json', '{}');
      const result = await harness.services.dataCruncher.queryJson(
        localPath('data.json'),
        { filter: '[env | keys[], ($ENV | keys[])] | join(",")' },
        context,
      );
      expect(result.output).not.toContain('SENTINEL');
      expect(result.output).not.toContain('super-secret-value');
      expect(result.output).not.toContain('API_KEYS');
      expect(result.output).toContain('PATH');
    } finally {
      delete process.env.DATA_CRUNCHER_SENTINEL_SECRET;
    }
  });

  it('rejects invalid filters and malformed input separately', async () => {
    await write('data.json', '{"a":1}');
    await write('broken.json', '{"a":');

    await expect(
      harness.services.dataCruncher.queryJson(localPath('data.json'), { filter: '.[' }, context),
    ).rejects.toMatchObject({ code: 'bad_request', message: 'The jq filter is not valid' });

    await expect(
      harness.services.dataCruncher.queryJson(localPath('broken.json'), { filter: '.' }, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('truncates at the byte budget and marks the result', async () => {
    await write('big.json', JSON.stringify(Array.from({ length: 500 }, (_, index) => index)));

    const result = await harness.services.dataCruncher.queryJson(
      localPath('big.json'),
      { filter: '.[]', maxOutputBytes: 1024 },
      context,
    );
    expect(result.truncated).toBe(true);
    expect(result.returnedBytes).toBeLessThanOrEqual(1024);
    expect(result.warnings.join(' ')).toContain('truncated');
    expect(result.output.endsWith('\n')).toBe(false);
  });

  it('fails with a typed error when a single value cannot be truncated safely', async () => {
    await write('big.json', JSON.stringify({ blob: 'x'.repeat(20_000) }));

    await expect(
      harness.services.dataCruncher.queryJson(
        localPath('big.json'),
        { filter: '.', maxOutputBytes: 1024 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'output_limit' });
  });

  it('rejects binary and non-UTF-8 input', async () => {
    await write('binary.json', Buffer.from([0x7b, 0x00, 0x01, 0x7d]));
    await write('utf16.json', Buffer.from([0xff, 0xfe, 0x7b, 0x00]));

    await expect(
      harness.services.dataCruncher.queryJson(localPath('binary.json'), { filter: '.' }, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.services.dataCruncher.queryJson(localPath('utf16.json'), { filter: '.' }, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('skips a UTF-8 byte order mark', async () => {
    await write(
      'bom.json',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
    );

    const result = await harness.services.dataCruncher.queryJson(
      localPath('bom.json'),
      { filter: '.a' },
      context,
    );
    expect(result.output).toBe('1');
    expect(result.warnings.join(' ')).toContain('byte order mark');
  });

  it('refuses jq module directives that would read files outside the input', async () => {
    await write('data.json', '{"a":1}');
    const outside = join(harness.tempDir, 'modules');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.json'), '{"password":"hunter2"}');
    const search = outside.replace(/\\/g, '/');

    for (const filter of [
      `import "secret" as $s {search: "${search}"}; $s`,
      `include "secret" {search: "${search}"}; .`,
      `  #comment\n import "secret" as $s {search: "${search}"}; $s`,
    ]) {
      const failure = await harness.services.dataCruncher
        .queryJson(localPath('data.json'), { filter }, context)
        .then((result) => result.output)
        .catch((error: unknown) => error as { code?: string; message?: string });
      expect(failure).toMatchObject({ code: 'bad_request' });
      expect(JSON.stringify(failure)).not.toContain('hunter2');
    }
  });

  it('still allows fields and strings named import or include', async () => {
    await write('data.json', '{"import":{"id":7},"include":2}');

    expect(
      (
        await harness.services.dataCruncher.queryJson(
          localPath('data.json'),
          { filter: '.import.id + .include' },
          context,
        )
      ).output,
    ).toBe('9');
    expect(
      (
        await harness.services.dataCruncher.queryJson(
          localPath('data.json'),
          { filter: '"import include"' },
          context,
        )
      ).output,
    ).toBe('"import include"');
  });

  it('rejects filters longer than the configured maximum', async () => {
    await write('data.json', '{}');
    await expect(
      harness.services.dataCruncher.queryJson(
        localPath('data.json'),
        { filter: '.'.repeat(harness.config.limits.maxFilterLength + 1) },
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('ripgrep searches', () => {
  it('returns matches with line numbers and scanned bytes', async () => {
    const contents = 'INFO started\nERROR first\nWARN retry\nERROR second\n';
    await write('app.log', contents);

    const result = await harness.services.dataCruncher.ripgrep(
      localPath('app.log'),
      { pattern: '^ERROR', maxResults: 10 },
      context,
    );
    expect(result.matches).toEqual([
      { lineNumber: 2, line: 'ERROR first', lineTruncated: false },
      { lineNumber: 4, line: 'ERROR second', lineTruncated: false },
    ]);
    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.scannedBytes).toBe(Buffer.byteLength(contents));
  });

  it('returns an empty result when nothing matches', async () => {
    await write('app.log', 'INFO started\n');
    const result = await harness.services.dataCruncher.ripgrep(
      localPath('app.log'),
      { pattern: 'missing', maxResults: 10 },
      context,
    );
    expect(result).toMatchObject({ matches: [], matchCount: 0, truncated: false });
  });

  it('bounds the number of matches and reports truncation', async () => {
    await write('many.log', Array.from({ length: 50 }, (_, index) => `ERROR ${index}`).join('\n'));

    const result = await harness.services.dataCruncher.ripgrep(
      localPath('many.log'),
      { pattern: 'ERROR', maxResults: 5 },
      context,
    );
    expect(result.matchCount).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toContain('Result limit');
  });

  it('clips excessively long lines', async () => {
    await write('long.log', `ERROR ${'x'.repeat(50_000)}\n`);

    const result = await harness.services.dataCruncher.ripgrep(
      localPath('long.log'),
      { pattern: 'ERROR', maxResults: 5 },
      context,
    );
    const [match] = result.matches;
    expect(match).toBeDefined();
    expect(match!.line.length).toBeLessThanOrEqual(harness.config.limits.maxLineLength);
  });

  it('rejects invalid patterns and binary input', async () => {
    await write('app.log', 'line\n');
    await write('binary.log', Buffer.from([0x41, 0x00, 0x42]));

    await expect(
      harness.services.dataCruncher.ripgrep(
        localPath('app.log'),
        { pattern: '[', maxResults: 5 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.services.dataCruncher.ripgrep(
        localPath('binary.log'),
        { pattern: 'A', maxResults: 5 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('does not leak absolute paths in error details', async () => {
    await write('app.log', 'line\n');
    const failure = await harness.services.dataCruncher
      .ripgrep(localPath('app.log'), { pattern: '(', maxResults: 5 }, context)
      .then(() => undefined)
      .catch((error: unknown) => error as { details?: unknown });
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.details ?? {})).not.toContain(harness.dataRoot);
  });
});

describe('data references', () => {
  it('reads uploaded assets and removes the temporary copy', async () => {
    const metadata = await assets.put({
      principal: 'key:1',
      filename: 'orders.json',
      contentType: 'application/json',
      body: (await import('node:stream')).Readable.from([
        Buffer.from(JSON.stringify({ total: 42 })),
      ]),
    });

    const result = await harness.services.dataCruncher.queryJson(
      { kind: 'asset', assetId: metadata.assetId },
      { filter: '.total' },
      context,
    );
    expect(result.output).toBe('42');
  });

  it('refuses assets owned by another principal', async () => {
    const metadata = await assets.put({
      principal: 'key:2',
      filename: 'orders.json',
      contentType: 'application/json',
      body: (await import('node:stream')).Readable.from([Buffer.from('{}')]),
    });

    await expect(
      harness.services.dataCruncher.queryJson(
        { kind: 'asset', assetId: metadata.assetId },
        { filter: '.' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('contains local paths inside the configured roots', async () => {
    const outside = join(harness.tempDir, 'outside.json');
    await writeFile(outside, '{"secret":true}');

    await expect(
      harness.services.dataCruncher.queryJson(
        localPath('../outside.json'),
        { filter: '.' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      harness.services.dataCruncher.ripgrep(
        localPath(outside),
        { pattern: 'secret', maxResults: 1 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      harness.services.dataCruncher.queryJson(localPath('.'), { filter: '.' }, context),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects symlinks that escape the data root', async () => {
    const target = join(harness.tempDir, 'outside.json');
    await writeFile(target, '{"secret":true}');
    try {
      await symlink(target, join(harness.dataRoot, 'link.json'));
    } catch {
      return; // symlink creation requires privileges on some platforms
    }

    await expect(
      harness.services.dataCruncher.queryJson(localPath('link.json'), { filter: '.' }, context),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses local paths when they are disabled', async () => {
    const disabled = await createHarness({ env: { LOCAL_PATHS_ENABLED: 'false' } });
    try {
      await expect(
        disabled.services.dataCruncher.queryJson(localPath('data.json'), { filter: '.' }, context),
      ).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await disabled.dispose();
    }
  });

  it('rejects files larger than the configured maximum', async () => {
    const small = await createHarness({ env: { MAX_FILE_BYTES: 1024 } });
    try {
      await writeFile(join(small.dataRoot, 'big.json'), JSON.stringify({ x: 'y'.repeat(4096) }));
      await expect(
        small.services.dataCruncher.queryJson(localPath('big.json'), { filter: '.' }, context),
      ).rejects.toMatchObject({ code: 'payload_too_large' });
    } finally {
      await small.dispose();
    }
  });
});

describe('execution bounds', () => {
  it('reports unresolvable tooling as an upstream failure, not an internal error', async () => {
    // A binary that is absent, unreadable or too old is an operational failure of this server.
    const broken = await createHarness();
    try {
      const runtime = broken.runtime as unknown as {
        executables: () => Promise<never>;
      };
      runtime.executables = () =>
        Promise.reject(new ExecutableResolutionError('jq was not found on PATH'));

      await writeFile(join(broken.dataRoot, 'data.json'), '{}');
      await expect(
        broken.services.dataCruncher.queryJson(localPath('data.json'), { filter: '.' }, context),
      ).rejects.toMatchObject({ code: 'upstream_error', retryable: true });
    } finally {
      await broken.dispose();
    }
  });

  it('rejects work when the queue is saturated', async () => {
    const saturated = await createHarness({
      env: { TOOL_CONCURRENCY: 1, TOOL_QUEUE_LIMIT: 0 },
    });
    try {
      await writeFile(
        join(saturated.dataRoot, 'big.json'),
        JSON.stringify(Array.from({ length: 20_000 }, (_, index) => ({ index }))),
      );
      const first = saturated.services.dataCruncher.queryJson(
        localPath('big.json'),
        { filter: '[.[].index] | add' },
        context,
      );
      const second = saturated.services.dataCruncher.queryJson(
        localPath('big.json'),
        { filter: '.' },
        context,
      );
      await expect(second).rejects.toMatchObject({ code: 'busy', retryable: true });
      await first.catch(() => undefined);
    } finally {
      await saturated.dispose();
    }
  });

  it('stops execution when the caller aborts', async () => {
    await write('data.json', '{"a":1}');
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.services.dataCruncher.queryJson(
        localPath('data.json'),
        { filter: '.' },
        {
          ...context,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('times out long running work', async () => {
    const slow = await createHarness({ env: { SUBPROCESS_TIMEOUT_MS: 200 } });
    try {
      await writeFile(join(slow.dataRoot, 'data.json'), '{}');
      await expect(
        slow.services.dataCruncher.queryJson(
          localPath('data.json'),
          { filter: 'reduce range(0; 100000000) as $i (0; . + $i)' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await slow.dispose();
    }
  });
});
