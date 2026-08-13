import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { badRequest } from '../errors.js';

const execute = promisify(execFile);
const maxOutputBytes = 1024 * 1024;
const commandTimeoutMs = 15_000;

interface CommandError extends Error {
  readonly code?: number | string;
  readonly stderr?: string;
}

const commandError = (error: unknown): CommandError =>
  error instanceof Error ? (error as CommandError) : new Error(String(error));

export interface RipgrepMatch {
  readonly lineNumber: number;
  readonly line: string;
}

export class DataCruncherService {
  public constructor(private readonly dataRoot: string) {}

  private async readableFile(filePath: string): Promise<string> {
    const root = await realpath(this.dataRoot);
    const candidate = await realpath(isAbsolute(filePath) ? filePath : resolve(root, filePath)).catch(
      () => {
        throw badRequest('File does not exist or is not accessible');
      },
    );
    const fromRoot = relative(root, candidate);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw badRequest('File path must be inside DATA_ROOT');
    }
    if (!(await stat(candidate)).isFile()) throw badRequest('File path must refer to a regular file');
    return candidate;
  }

  public async queryJson(filePath: string, filter: string): Promise<string> {
    const file = await this.readableFile(filePath);
    try {
      const { stdout } = await execute('jq', ['--compact-output', filter, file], {
        encoding: 'utf8',
        maxBuffer: maxOutputBytes,
        timeout: commandTimeoutMs,
      });
      return stdout.trimEnd();
    } catch (error) {
      const failure = commandError(error);
      if (failure.code === 'ENOENT') throw new Error('jq is not installed', { cause: failure });
      throw badRequest('jq could not process the file and filter', {
        stderr: failure.stderr?.trim().slice(0, 2000),
      });
    }
  }

  public async ripgrep(
    filePath: string,
    pattern: string,
    maxResults: number,
  ): Promise<readonly RipgrepMatch[]> {
    const file = await this.readableFile(filePath);
    let stdout: string;
    try {
      ({ stdout } = await execute(
        'rg',
        ['--json', '--max-count', String(maxResults), '--', pattern, file],
        {
          encoding: 'utf8',
          maxBuffer: maxOutputBytes,
          timeout: commandTimeoutMs,
        },
      ));
    } catch (error) {
      const failure = commandError(error);
      if (failure.code === 1) return [];
      if (failure.code === 'ENOENT') throw new Error('ripgrep is not installed', { cause: failure });
      throw badRequest('ripgrep could not process the file and pattern', {
        stderr: failure.stderr?.trim().slice(0, 2000),
      });
    }

    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
      .filter((event) => event.type === 'match')
      .map((event) => {
        const data = event.data as {
          line_number: number;
          lines: { text: string };
        };
        return {
          lineNumber: data.line_number,
          line: data.lines.text.replace(/\r?\n$/, ''),
        };
      })
      .slice(0, maxResults);
  }
}
