import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataCruncherService } from '../../src/services/data-cruncher.js';

let root: string;
let service: DataCruncherService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'data-cruncher-'));
  service = new DataCruncherService(root);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe('data cruncher service', () => {
  it('queries JSON with jq', async () => {
    await writeFile(
      join(root, 'users.json'),
      JSON.stringify({ users: [{ email: 'one@example.com' }, { email: 'two@example.com' }] }),
    );

    expect(await service.queryJson('users.json', '.users[].email')).toBe(
      '"one@example.com"\n"two@example.com"',
    );
  });

  it('returns ripgrep matches and line numbers', async () => {
    await writeFile(join(root, 'app.log'), 'INFO started\nERROR first\nWARN retry\nERROR second\n');

    expect(await service.ripgrep('app.log', '^ERROR', 10)).toEqual([
      { lineNumber: 2, line: 'ERROR first' },
      { lineNumber: 4, line: 'ERROR second' },
    ]);
    expect(await service.ripgrep('app.log', 'missing', 10)).toEqual([]);
  });

  it('rejects paths outside the configured data root', async () => {
    await expect(service.queryJson('/etc/passwd', '.')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(service.ripgrep('../outside.log', '.', 10)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(service.queryJson('.', '.')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('maps invalid filters and patterns to bad requests', async () => {
    await writeFile(join(root, 'data.json'), '{}');
    await writeFile(join(root, 'app.log'), 'line\n');

    await expect(service.queryJson('data.json', '.[')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(service.ripgrep('app.log', '[', 10)).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});
