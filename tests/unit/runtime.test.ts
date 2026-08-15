import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChildEnvironment } from '../../src/runtime/child-environment.js';
import { findExecutable, resolveExecutables } from '../../src/runtime/executables.js';
import { BoundedQueue } from '../../src/runtime/queue.js';
import { runCommand } from '../../src/runtime/subprocess.js';
import { LineSplitter } from '../../src/util/lines.js';
import { sanitizeLine, sanitizeStderr } from '../../src/util/sanitize.js';

const node = { name: 'jq' as const, path: process.execPath, version: 'test' };

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dc-runtime-'));
});

afterEach(async () => rm(tempDir, { recursive: true, force: true }));

const run = (script: string, overrides: Record<string, unknown> = {}) => {
  let output = '';
  return runCommand({
    executable: node,
    args: ['-e', script],
    cwd: tempDir,
    env: buildChildEnvironment({ pathEntries: [dirname(process.execPath)], tempDir }),
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
    onStdout: (chunk) => {
      output += chunk.toString('utf8');
      return true;
    },
    ...overrides,
  }).then((result) => ({ result, output }));
};

describe('child environment', () => {
  it('contains only an explicit allowlist', () => {
    const env = buildChildEnvironment({
      pathEntries: ['/usr/bin'],
      tempDir: '/tmp/work',
      platform: 'linux',
      source: {
        API_KEYS: 'secret',
        RIPGREP_CONFIG_PATH: '/etc/rgrc',
        NODE_OPTIONS: '--require evil',
        HTTPS_PROXY: 'http://proxy',
        AZURE_CLIENT_SECRET: 'secret',
      },
    });
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]);
    expect(JSON.stringify(env)).not.toContain('secret');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('does not pass parent variables to real children', async () => {
    process.env.DATA_CRUNCHER_RUNTIME_SENTINEL = 'leaked-value';
    try {
      const { output } = await run('process.stdout.write(JSON.stringify(process.env))');
      expect(output).not.toContain('leaked-value');
      expect(output).not.toContain('DATA_CRUNCHER_RUNTIME_SENTINEL');
    } finally {
      delete process.env.DATA_CRUNCHER_RUNTIME_SENTINEL;
    }
  });
});

describe('subprocess runner', () => {
  it('caps captured output and stops the child', async () => {
    const { result, output } = await run('process.stdout.write("x".repeat(100000))', {
      maxOutputBytes: 1024,
    });
    expect(result.outputLimitReached).toBe(true);
    expect(output.length).toBe(1024);
  });

  it('terminates children that exceed the time limit', async () => {
    const { result } = await run('setInterval(() => {}, 1000)', { timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.code === null || result.code !== 0).toBe(true);
  });

  it('terminates children when the caller aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { result } = await run('setInterval(() => {}, 1000)', { signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  it('streams stdin and reports the number of bytes fed', async () => {
    const { result, output } = await run(
      'let n=0;process.stdin.on("data",c=>n+=c.length).on("end",()=>process.stdout.write(String(n)))',
      { stdin: Readable.from([Buffer.from('hello world')]) },
    );
    expect(output).toBe('11');
    expect(result.stdinBytes).toBe(11);
  });

  it('captures a bounded amount of stderr', async () => {
    const { result } = await run('process.stderr.write("e".repeat(100000));', {
      maxStderrBytes: 512,
    });
    expect(result.stderr.length).toBe(512);
  });

  it('stops early when the consumer has seen enough', async () => {
    let seen = 0;
    const result = await runCommand({
      executable: node,
      args: ['-e', 'setInterval(() => process.stdout.write("line\\n"), 5)'],
      cwd: tempDir,
      env: buildChildEnvironment({ pathEntries: [dirname(process.execPath)], tempDir }),
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      onStdout: (chunk) => {
        seen += chunk.length;
        return false;
      },
    });
    expect(result.stoppedEarly).toBe(true);
    expect(seen).toBeGreaterThan(0);
  });
});

describe('executable resolution', () => {
  it('resolves jq and ripgrep and records their versions', async () => {
    const executables = await resolveExecutables({ tempDir });
    expect(executables.jq.version).toMatch(/^\d+\./);
    expect(executables.ripgrep.version).toMatch(/^\d+\./);
    expect(executables.pathEntries.length).toBeGreaterThan(0);
  });

  it('rejects missing executables and unusable overrides', async () => {
    await expect(findExecutable('definitely-not-a-real-binary', { pathValue: '' })).rejects.toThrow(
      /not found/,
    );
    await expect(findExecutable('jq', { override: join(tempDir, 'nope') })).rejects.toThrow(
      /not an executable/,
    );
  });
});

describe('bounded queue', () => {
  it('limits concurrency and rejects when the queue is full', async () => {
    const queue = new BoundedQueue(1, 1, 'tool work');
    const release: Array<() => void> = [];
    const task = () => new Promise<void>((resolve) => release.push(resolve));

    const first = queue.run(task);
    const second = queue.run(task);
    await expect(queue.run(task)).rejects.toMatchObject({ code: 'busy', retryable: true });

    release.forEach((resolve) => resolve());
    await first;
    release.forEach((resolve) => resolve());
    await second;
    expect(queue.active).toBe(0);
  });

  it('drops queued work when the caller aborts', async () => {
    const queue = new BoundedQueue(1, 4);
    const controller = new AbortController();
    let release = (): void => undefined;
    const running = queue.run(() => new Promise<void>((resolve) => (release = resolve)));
    const queued = queue.run(() => Promise.resolve('never'), controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'busy' });
    release();
    await running;
  });

  it('rejects everything once closed', async () => {
    const queue = new BoundedQueue(1, 4);
    queue.close();
    await expect(queue.run(() => Promise.resolve(1))).rejects.toMatchObject({ code: 'busy' });
  });
});

describe('output helpers', () => {
  it('drops lines that exceed the buffer cap', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(16, (line) => {
      lines.push(line);
      return true;
    });
    splitter.push(Buffer.from('short\n'));
    splitter.push(Buffer.from(`${'x'.repeat(64)}\n`));
    splitter.push(Buffer.from('after\n'));
    expect(lines).toEqual(['short', 'after']);
    expect(splitter.droppedLines).toBe(1);
  });

  it('removes paths and control characters from messages', () => {
    expect(sanitizeStderr('jq: error at /srv/data/secret.json:1 boom')).not.toContain('secret');
    expect(sanitizeStderr('failed C:\\data\\secret.json')).not.toContain('secret');
    expect(sanitizeLine('a\u0000b\r\n')).toBe('a\uFFFDb\n');
  });
});
