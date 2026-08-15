import type { AppConfig, ExecutionLimits } from '../config/index.js';
import { badRequest, outputLimit, timedOut, upstreamError } from '../errors.js';
import type { Runtime } from '../runtime/index.js';
import { ExecutableResolutionError } from '../runtime/executables.js';
import { ExecutableMissingError, runCommand, type CommandResult } from '../runtime/subprocess.js';
import { LineSplitter } from '../util/lines.js';
import { sanitizeLine, sanitizeStderr } from '../util/sanitize.js';
import type { AssetStore } from './assets/index.js';
import { assertNoModuleDirectives } from './jq-filter.js';
import { LocalPathResolver, openRegularFile, type OpenedFile } from './local-paths.js';

export type DataReference =
  | { readonly kind: 'local_path'; readonly path: string }
  | { readonly kind: 'asset'; readonly assetId: string };

export interface ExecutionContext {
  readonly principal: string;
  readonly signal?: AbortSignal | undefined;
}

export interface JsonQueryRequest {
  readonly filter: string;
  readonly maxOutputBytes?: number | undefined;
}

export interface JsonQueryResult {
  readonly output: string;
  readonly returnedBytes: number;
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

interface Input {
  readonly file: OpenedFile;
  readonly bomOffset: number;
  dispose(): Promise<void>;
}

export class DataCruncherService {
  private readonly limits: ExecutionLimits;
  private readonly localPaths: LocalPathResolver;

  public constructor(
    config: AppConfig,
    private readonly runtime: Runtime,
    private readonly assets: AssetStore,
  ) {
    this.limits = config.limits;
    this.localPaths = new LocalPathResolver({
      roots: config.data.roots,
      enabled: config.data.localPathsEnabled,
      maxFileBytes: config.limits.maxFileBytes,
    });
  }

  public async queryJson(
    reference: DataReference,
    request: JsonQueryRequest,
    context: ExecutionContext,
  ): Promise<JsonQueryResult> {
    this.assertLength(request.filter, this.limits.maxFilterLength, 'filter');
    assertNoModuleDirectives(request.filter);
    const budget = Math.min(
      request.maxOutputBytes ?? this.limits.defaultOutputBytes,
      this.limits.maxOutputBytes,
    );

    return this.runQueued(context, async (signal) => {
      const input = await this.openInput(reference, context.principal);
      try {
        const warnings: string[] = [];
        this.assertTextual(input, warnings, 'JSON');

        const chunks: Buffer[] = [];
        let collected = 0;
        const result = await this.execute(
          'jq',
          ['--compact-output', '--monochrome-output', '--', request.filter],
          input,
          {
            signal,
            maxOutputBytes: budget,
            onStdout: (chunk) => {
              chunks.push(chunk);
              collected += chunk.length;
              return true;
            },
          },
        );

        this.assertCompleted(result, 'jq');
        if (result.code !== 0 && !result.outputLimitReached) this.throwJqFailure(result);

        const raw = Buffer.concat(chunks, collected).toString('utf8').replace(/\r\n/g, '\n');
        if (!result.outputLimitReached) {
          const output = raw.replace(/\n+$/, '');
          return {
            output,
            returnedBytes: Buffer.byteLength(output, 'utf8'),
            truncated: false,
            warnings,
          };
        }

        const lastBreak = raw.lastIndexOf('\n');
        if (lastBreak < 0) {
          throw outputLimit(
            'A single jq result exceeded the output limit; narrow the filter or raise maxOutputBytes',
            { maxOutputBytes: budget },
          );
        }
        const output = raw.slice(0, lastBreak);
        warnings.push('Output was truncated at the requested byte budget; narrow the filter.');
        return {
          output,
          returnedBytes: Buffer.byteLength(output, 'utf8'),
          truncated: true,
          warnings,
        };
      } finally {
        await input.dispose();
      }
    });
  }

  public async ripgrep(
    reference: DataReference,
    request: RipgrepRequest,
    context: ExecutionContext,
  ): Promise<RipgrepResult> {
    this.assertLength(request.pattern, this.limits.maxPatternLength, 'pattern');
    const maxResults = Math.min(request.maxResults, this.limits.maxMatches);

    return this.runQueued(context, async (signal) => {
      const input = await this.openInput(reference, context.principal);
      try {
        const warnings: string[] = [];
        this.assertTextual(input, warnings, 'text');

        const matches: RipgrepMatch[] = [];
        let stoppedAtLimit = false;
        const eventCap = Math.max(64 * 1024, this.limits.maxLineLength * 4 + 4096);
        const splitter = new LineSplitter(eventCap, (line) => {
          const match = this.parseMatch(line);
          if (match) matches.push(match);
          if (matches.length < maxResults) return true;
          stoppedAtLimit = true;
          return false;
        });

        const result = await this.execute(
          'rg',
          [
            '--json',
            '--line-number',
            '--threads',
            '1',
            '--max-count',
            String(maxResults),
            '--max-columns',
            String(this.limits.maxLineLength),
            '--max-columns-preview',
            '--regexp',
            request.pattern,
            '--',
            '-',
          ],
          input,
          {
            signal,
            maxOutputBytes: this.limits.maxOutputBytes,
            onStdout: (chunk) => splitter.push(chunk),
          },
        );

        this.assertCompleted(result, 'ripgrep');
        if (!stoppedAtLimit && !result.outputLimitReached) splitter.flush();
        if (result.code === 2) {
          throw badRequest('ripgrep rejected the pattern', {
            reason: sanitizeStderr(result.stderr) || undefined,
          });
        }
        if (splitter.droppedLines > 0) {
          warnings.push('Some matching lines were too long to return and were skipped.');
        }
        if (result.outputLimitReached) {
          warnings.push('Search output reached the byte limit; results are incomplete.');
        }
        if (stoppedAtLimit) {
          warnings.push('Result limit reached; narrow the pattern or raise maxResults.');
        }

        return {
          matches,
          matchCount: matches.length,
          truncated: stoppedAtLimit || result.outputLimitReached,
          scannedBytes: result.stdinBytes,
          warnings,
        };
      } finally {
        await input.dispose();
      }
    });
  }

  private runQueued<T>(
    context: ExecutionContext,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [this.runtime.signal, ...(context.signal ? [context.signal] : [])];
    const signal = AbortSignal.any(signals);
    return this.runtime.toolQueue.run(() => task(signal), signal);
  }

  private assertLength(value: string, max: number, label: string): void {
    if (value.length > max) {
      throw badRequest(`The ${label} exceeds the configured maximum length`, { maxLength: max });
    }
  }

  private assertTextual(input: Input, warnings: string[], expected: 'JSON' | 'text'): void {
    if (input.file.sizeBytes === 0) {
      warnings.push('The input is empty.');
      return;
    }
    const { preview } = input.file;
    const utf16Or32Bom =
      (preview[0] === 0xff && preview[1] === 0xfe) || (preview[0] === 0xfe && preview[1] === 0xff);
    if (utf16Or32Bom) {
      throw badRequest(`Input encoding is not supported; provide UTF-8 ${expected}`);
    }
    if (preview.subarray(input.bomOffset).includes(0x00)) {
      throw badRequest(`Input looks binary; provide UTF-8 ${expected}`);
    }
    if (input.bomOffset > 0) warnings.push('A UTF-8 byte order mark was skipped.');
  }

  private async execute(
    name: 'jq' | 'rg',
    args: readonly string[],
    input: Input,
    options: {
      readonly signal: AbortSignal;
      readonly maxOutputBytes: number;
      readonly onStdout: (chunk: Buffer) => boolean;
    },
  ): Promise<CommandResult> {
    try {
      // Resolution is inside the try because a missing, unreadable or too-old binary is an
      // operational failure of this server, not a caller error.
      const [executables, workspace, env] = await Promise.all([
        this.runtime.executables(),
        this.runtime.workspace(),
        this.runtime.childEnvironment(),
      ]);
      return await runCommand({
        executable: name === 'jq' ? executables.jq : executables.ripgrep,
        args,
        cwd: workspace.childTempDir,
        env,
        timeoutMs: this.limits.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        stdin: input.file.createStream(input.bomOffset),
        signal: options.signal,
        onStdout: options.onStdout,
      });
    } catch (error) {
      if (error instanceof ExecutableMissingError || error instanceof ExecutableResolutionError) {
        throw upstreamError('The search tooling is unavailable on this server');
      }
      throw error;
    }
  }

  private assertCompleted(result: CommandResult, tool: string): void {
    if (result.timedOut) {
      throw timedOut(`${tool} exceeded the execution time limit`, {
        timeoutMs: this.limits.timeoutMs,
      });
    }
    if (result.aborted && !result.stoppedEarly && !result.outputLimitReached) {
      throw badRequest('The request was cancelled before it completed');
    }
  }

  private throwJqFailure(result: CommandResult): never {
    if (result.code === 3) {
      throw badRequest('The jq filter is not valid', {
        reason: sanitizeStderr(result.stderr) || undefined,
      });
    }
    if (result.code === 2) {
      throw badRequest('The input is not valid JSON or JSONL');
    }
    throw badRequest('jq could not apply the filter to this input');
  }

  private parseMatch(line: string): RipgrepMatch | undefined {
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
    } catch {
      return undefined;
    }
    if (event.type !== 'match' || !event.data) return undefined;

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
    const sanitized = sanitizeLine(text.replace(/\n$/, ''));
    const clipped = sanitized.slice(0, this.limits.maxLineLength);
    return {
      lineNumber: typeof data.line_number === 'number' ? data.line_number : 0,
      line: clipped,
      lineTruncated: clipped.length < sanitized.length,
    };
  }

  private async openInput(reference: DataReference, principal: string): Promise<Input> {
    if (reference.kind === 'asset') {
      const materialized = await this.assets.materialize(reference.assetId, principal);
      try {
        const file = await openRegularFile(materialized.path, this.limits.maxFileBytes);
        return {
          file,
          bomOffset: bomOffsetOf(file),
          dispose: async () => {
            await file.close();
            await materialized.dispose();
          },
        };
      } catch (error) {
        await materialized.dispose();
        throw error;
      }
    }

    const file = await this.localPaths.open(reference.path);
    return { file, bomOffset: bomOffsetOf(file), dispose: () => file.close() };
  }
}

const bomOffsetOf = (file: OpenedFile): number =>
  file.preview.subarray(0, 3).equals(utf8Bom) ? 3 : 0;
