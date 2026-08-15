import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import type { ResolvedExecutable } from './executables.js';

const killGraceMs = 2000;
const defaultMaxStderrBytes = 8 * 1024;

export interface CommandSpec {
  readonly executable: ResolvedExecutable;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes?: number;
  readonly stdin?: Readable;
  readonly signal?: AbortSignal;
  /** Return `false` to stop reading and terminate the child early. */
  readonly onStdout?: (chunk: Buffer) => boolean;
}

export interface CommandResult {
  readonly code: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stdinBytes: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitReached: boolean;
  readonly stoppedEarly: boolean;
}

export class ExecutableMissingError extends Error {
  public override readonly name = 'ExecutableMissingError';
}

/**
 * Runs a resolved executable with no shell, an explicit environment, an isolated working
 * directory, and hard limits on wall-clock time and captured output. Input is streamed through
 * stdin so no caller-controlled path ever reaches the child's argument vector.
 */
export const runCommand = async (spec: CommandSpec): Promise<CommandResult> => {
  const child = spawn(spec.executable.path, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  let timedOut = false;
  let aborted = false;
  let outputLimitReached = false;
  let stoppedEarly = false;
  let stdoutBytes = 0;
  let deliveredBytes = 0;
  let stdinBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stderrChunks: Buffer[] = [];
  const maxStderrBytes = spec.maxStderrBytes ?? defaultMaxStderrBytes;

  const terminate = (): void => {
    if (settled || child.killed) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    killTimer.unref();
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, spec.timeoutMs);
  timeoutTimer.unref();

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  spec.signal?.addEventListener('abort', onAbort, { once: true });

  // A terminated child closes its pipes; writes must not surface as unhandled errors.
  child.stdin.on('error', () => undefined);

  if (spec.stdin) {
    spec.stdin.on('data', (chunk: Buffer) => {
      stdinBytes += chunk.length;
    });
    spec.stdin.on('error', () => terminate());
    spec.stdin.pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    const allowed = Math.max(0, spec.maxOutputBytes - deliveredBytes);
    const slice = chunk.length <= allowed ? chunk : chunk.subarray(0, allowed);
    deliveredBytes += slice.length;
    if (slice.length > 0 && spec.onStdout && spec.onStdout(slice) === false) stoppedEarly = true;
    if (chunk.length > allowed) outputLimitReached = true;
    if (outputLimitReached || stoppedEarly) {
      child.stdout.destroy();
      terminate();
    }
  });
  child.stdout.on('error', () => undefined);

  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = maxStderrBytes - stderrBytes;
    if (remaining <= 0) return;
    stderrChunks.push(chunk.subarray(0, remaining));
    stderrBytes += Math.min(remaining, chunk.length);
  });
  child.stderr.on('error', () => undefined);

  try {
    const [code, terminationSignal] = (await Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => {
        throw error;
      }),
    ])) as [number | null, NodeJS.Signals | null];

    return {
      code,
      terminationSignal,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutBytes,
      stdinBytes,
      timedOut,
      aborted,
      outputLimitReached,
      stoppedEarly,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExecutableMissingError(`${spec.executable.name} is not available`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    settled = true;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    spec.signal?.removeEventListener('abort', onAbort);
    spec.stdin?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
};
