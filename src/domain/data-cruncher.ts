import { Readable } from 'node:stream';
import type { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import { badRequest, limitExceeded, upstreamError } from '@agent-tool-platform/runtime/errors';
import type { ConfinedOpenedFile, RootBoundary } from '@agent-tool-platform/runtime/fs';
import {
  processFailureToAppError,
  type BoundedProcessResult,
} from '@agent-tool-platform/runtime/process';
import type { DataCruncherLimits } from '../config/index.js';
import { sanitizeLine, sanitizeStderr } from '../util/sanitize.js';
import { assertNoModuleDirectives } from './jq-filter.js';

export interface DataProcessRunner {
  run(
    name: 'jq' | 'rg',
    args: readonly string[],
    stdin: Readable,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<BoundedProcessResult>;
}

export interface JsonQueryRequest {
  readonly filter: string;
  readonly maxOutputBytes?: number | undefined;
}

export interface JsonQueryResult {
  readonly output: string;
  readonly returnedBytes: number;
  readonly scannedBytes: number;
  readonly truncated: boolean;
  readonly warnings: string[];
}

export interface RipgrepMatch {
  readonly lineNumber: number;
  readonly line: string;
  readonly lineTruncated: boolean;
}

export interface RipgrepRequest {
  readonly pattern: string;
  readonly maxResults: number;
}

export interface RipgrepResult {
  readonly matches: RipgrepMatch[];
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly scannedBytes: number;
  readonly warnings: string[];
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

const createInputStream = (
  file: ConfinedOpenedFile,
  signal: AbortSignal,
  skipBytes: number,
): Readable => {
  const source = file.createReadStream({ signal });
  if (skipBytes === 0) return source;

  return Readable.from(
    (async function* (): AsyncGenerator<Buffer> {
      let remaining = skipBytes;
      for await (const chunk of source) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Confined file streams must emit buffers');
        if (remaining >= chunk.length) {
          remaining -= chunk.length;
          continue;
        }
        const output = remaining === 0 ? chunk : chunk.subarray(remaining);
        remaining = 0;
        yield output;
      }
    })(),
  );
};

export class DataCruncherService {
  public constructor(
    private readonly limits: DataCruncherLimits,
    private readonly workspace: RootBoundary,
    private readonly queue: BoundedQueue,
    private readonly processRunner: DataProcessRunner,
  ) {}

  public async queryJson(
    path: string,
    request: JsonQueryRequest,
    signal: AbortSignal,
  ): Promise<JsonQueryResult> {
    this.assertLength(request.filter, this.limits.maxFilterLength, 'filter');
    assertNoModuleDirectives(request.filter);
    if (
      request.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1024)
    ) {
      throw badRequest('maxOutputBytes must be an integer of at least 1024');
    }
    const requestedBudget = request.maxOutputBytes ?? this.limits.defaultOutputBytes;
    const budget = Math.min(requestedBudget, this.limits.maxOutputBytes);

    return this.queue.run(async () => {
      const input = await this.workspace.openFile(path, { previewBytes: 8192 });
      try {
        const warnings: string[] = [];
        const bomOffset = this.assertTextual(input, warnings, 'JSON');
        if (requestedBudget > budget) {
          warnings.push('maxOutputBytes was clamped to the deployment ceiling.');
        }

        const result = await this.processRunner.run(
          'jq',
          ['--compact-output', '--monochrome-output', '--', request.filter],
          createInputStream(input, signal, bomOffset),
          signal,
          budget,
        );
        this.assertProcessCompleted(result, 'jq');
        if (result.code !== 0 && !result.outputLimitReached) this.throwJqFailure(result);

        const raw = result.stdout.replace(/\r\n/gu, '\n');
        if (!result.outputLimitReached) {
          const output = raw.replace(/\n+$/gu, '');
          return {
            output,
            returnedBytes: Buffer.byteLength(output, 'utf8'),
            scannedBytes: result.stdinBytes,
            truncated: false,
            warnings,
          };
        }

        const lastBreak = raw.lastIndexOf('\n');
        if (lastBreak < 0) {
          throw limitExceeded(
            'A single jq result exceeded the output limit; narrow the filter or raise maxOutputBytes',
            { maxOutputBytes: budget },
          );
        }
        const output = raw.slice(0, lastBreak);
        warnings.push('Output was truncated at the requested byte budget; narrow the filter.');
        return {
          output,
          returnedBytes: Buffer.byteLength(output, 'utf8'),
          scannedBytes: result.stdinBytes,
          truncated: true,
          warnings,
        };
      } finally {
        await input.close();
      }
    }, signal);
  }

  public async ripgrep(
    path: string,
    request: RipgrepRequest,
    signal: AbortSignal,
  ): Promise<RipgrepResult> {
    this.assertLength(request.pattern, this.limits.maxPatternLength, 'pattern');
    if (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1) {
      throw badRequest('maxResults must be a positive integer');
    }
    const maxResults = Math.min(request.maxResults, this.limits.maxMatches);
    const observedResultLimit = maxResults + 1;

    return this.queue.run(async () => {
      const input = await this.workspace.openFile(path, { previewBytes: 8192 });
      try {
        const warnings: string[] = [];
        const bomOffset = this.assertTextual(input, warnings, 'text');
        if (request.maxResults > maxResults) {
          warnings.push('maxResults was clamped to the deployment ceiling.');
        }

        const result = await this.processRunner.run(
          'rg',
          [
            '--json',
            '--line-number',
            '--threads',
            '1',
            '--max-count',
            String(observedResultLimit),
            '--max-columns',
            String(this.limits.maxLineLength),
            '--max-columns-preview',
            '--regexp',
            request.pattern,
            '--',
            '-',
          ],
          createInputStream(input, signal, bomOffset),
          signal,
          this.limits.maxOutputBytes,
        );
        this.assertProcessCompleted(result, 'ripgrep');
        if (result.code === 2) {
          throw badRequest('ripgrep rejected the pattern', {
            reason: sanitizeStderr(result.stderr) || undefined,
          });
        }
        if (result.code !== 0 && result.code !== 1 && !result.outputLimitReached) {
          throw upstreamError('ripgrep could not search this input');
        }

        const observedMatches = this.parseMatches(result.stdout, result.outputLimitReached);
        const hasAdditionalMatch = observedMatches.length > maxResults;
        const matches = observedMatches.slice(0, maxResults);
        if (result.outputLimitReached) {
          warnings.push('Search output reached the byte limit; results are incomplete.');
        }
        if (hasAdditionalMatch) {
          warnings.push('Result limit reached; narrow the pattern or raise maxResults.');
        }
        return {
          matches,
          matchCount: matches.length,
          truncated: hasAdditionalMatch || result.outputLimitReached,
          scannedBytes: result.stdinBytes,
          warnings,
        };
      } finally {
        await input.close();
      }
    }, signal);
  }

  private parseMatches(stdout: string, outputLimitReached: boolean): RipgrepMatch[] {
    const lines = stdout.split(/\r?\n/u);
    if (outputLimitReached && !stdout.endsWith('\n')) lines.pop();
    return lines.flatMap((line) => {
      if (line.length === 0) return [];
      let event: { type?: string; data?: Record<string, unknown> };
      try {
        event = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      } catch {
        return [];
      }
      if (event.type !== 'match' || !event.data) return [];
      const data = event.data as {
        line_number?: number | null;
        lines?: { text?: string; bytes?: string };
      };
      const text =
        typeof data.lines?.text === 'string'
          ? data.lines.text
          : typeof data.lines?.bytes === 'string'
            ? Buffer.from(data.lines.bytes, 'base64').toString('utf8')
            : '';
      const sanitized = sanitizeLine(text.replace(/\n$/u, ''));
      const clipped = sanitized.slice(0, this.limits.maxLineLength);
      return [
        {
          lineNumber: typeof data.line_number === 'number' ? data.line_number : 0,
          line: clipped,
          lineTruncated: clipped.length < sanitized.length,
        },
      ];
    });
  }

  private assertLength(value: string, max: number, label: string): void {
    if (value.length === 0) throw badRequest(`The ${label} must not be empty`);
    if (value.length > max) {
      throw badRequest(`The ${label} exceeds the configured maximum length`, { maxLength: max });
    }
  }

  private assertTextual(
    input: ConfinedOpenedFile,
    warnings: string[],
    expected: 'JSON' | 'text',
  ): number {
    if (input.sizeBytes === 0) {
      warnings.push('The input is empty.');
      return 0;
    }
    const { preview } = input;
    const utf16Or32Bom =
      (preview[0] === 0xff && preview[1] === 0xfe) || (preview[0] === 0xfe && preview[1] === 0xff);
    if (utf16Or32Bom) {
      throw badRequest(`Input encoding is not supported; provide UTF-8 ${expected}`);
    }
    const bomOffset = preview.subarray(0, 3).equals(utf8Bom) ? 3 : 0;
    if (preview.subarray(bomOffset).includes(0x00)) {
      throw badRequest(`Input looks binary; provide UTF-8 ${expected}`);
    }
    if (bomOffset > 0) warnings.push('A UTF-8 byte order mark was skipped.');
    return bomOffset;
  }

  private assertProcessCompleted(result: BoundedProcessResult, label: string): void {
    if (!result.timedOut && !result.aborted) return;
    throw processFailureToAppError(result, label) ?? upstreamError(`${label} did not complete`);
  }

  private throwJqFailure(result: BoundedProcessResult): never {
    if (result.code === 3) {
      throw badRequest('The jq filter is not valid', {
        reason: sanitizeStderr(result.stderr) || undefined,
      });
    }
    if (result.code === 2 || result.code === 4) {
      throw badRequest('The input is not valid JSON or JSONL');
    }
    throw badRequest('jq could not apply the filter to this input');
  }
}
