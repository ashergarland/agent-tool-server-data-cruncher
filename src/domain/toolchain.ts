import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { upstreamError } from '@agent-tool-platform/runtime/errors';
import {
  buildChildEnvironment,
  ExecutableMissingError,
  ExecutableResolutionError,
  processFailureToAppError,
  resolveExecutable,
  runBoundedProcess,
  type BoundedProcessResult,
} from '@agent-tool-platform/runtime/process';
import type { DataCruncherConfig } from '../config/index.js';

export interface ResolvedDataExecutable {
  readonly name: 'jq' | 'rg';
  readonly path: string;
  readonly version: string;
}

export interface ResolvedDataTooling {
  readonly jq: ResolvedDataExecutable;
  readonly ripgrep: ResolvedDataExecutable;
  readonly environment: Readonly<Record<string, string>>;
}

const parseVersion = (name: 'jq' | 'rg', output: string): string => {
  const first = output.split('\n')[0]?.trim() ?? '';
  const match =
    name === 'jq' ? /jq-?\s*([0-9][^\s]*)/iu.exec(first) : /([0-9]+\.[0-9]+\.?[0-9]*)/u.exec(first);
  if (!match?.[1]) throw new ExecutableResolutionError(`Could not determine the ${name} version`);
  return match[1];
};

const minimumMajorMinor: Readonly<Record<'jq' | 'rg', readonly [number, number]>> = {
  jq: [1, 7],
  rg: [14, 0],
};

const assertSupported = (name: 'jq' | 'rg', version: string): void => {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [minimumMajor, minimumMinor] = minimumMajorMinor[name];
  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    throw new ExecutableResolutionError(
      `${name} ${version} is older than the required ${minimumMajor}.${minimumMinor}`,
    );
  }
};

export class DataToolchain {
  private resolved: Promise<ResolvedDataTooling> | undefined;

  public constructor(
    private readonly config: DataCruncherConfig,
    private readonly scratchPath: string,
  ) {}

  public tooling(): Promise<ResolvedDataTooling> {
    this.resolved ??= this.resolve().catch((error: unknown) => {
      this.resolved = undefined;
      throw error;
    });
    return this.resolved;
  }

  public async run(
    name: 'jq' | 'rg',
    args: readonly string[],
    stdin: Readable,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<BoundedProcessResult> {
    try {
      const tooling = await this.tooling();
      const executable = name === 'jq' ? tooling.jq : tooling.ripgrep;
      return await runBoundedProcess({
        executablePath: executable.path,
        label: name === 'jq' ? 'jq' : 'ripgrep',
        args,
        cwd: this.scratchPath,
        env: { ...tooling.environment },
        timeoutMs: this.config.execution.limits.timeoutMs,
        maxOutputBytes,
        stdin,
        signal,
      });
    } catch (error) {
      if (error instanceof ExecutableResolutionError || error instanceof ExecutableMissingError) {
        throw upstreamError('The required jq and ripgrep tooling is unavailable');
      }
      throw error;
    }
  }

  private async resolve(): Promise<ResolvedDataTooling> {
    const [jqPath, ripgrepPath] = await Promise.all([
      resolveExecutable('jq', { override: this.config.execution.jqPath }),
      resolveExecutable('rg', { override: this.config.execution.ripgrepPath }),
    ]);
    const environment = buildChildEnvironment({
      pathEntries: [dirname(jqPath), dirname(ripgrepPath)],
      tempDir: this.scratchPath,
    });
    const [jq, ripgrep] = await Promise.all([
      this.probe('jq', jqPath, environment),
      this.probe('rg', ripgrepPath, environment),
    ]);
    return { jq, ripgrep, environment };
  }

  private async probe(
    name: 'jq' | 'rg',
    path: string,
    environment: Record<string, string>,
  ): Promise<ResolvedDataExecutable> {
    const result = await runBoundedProcess({
      executablePath: path,
      label: name === 'jq' ? 'jq' : 'ripgrep',
      args: ['--version'],
      cwd: this.scratchPath,
      env: environment,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
    const processError = processFailureToAppError(result, name);
    if (processError || result.code !== 0) {
      throw new ExecutableResolutionError(`${name} did not report a usable version`, {
        cause: processError,
      });
    }
    const version = parseVersion(name, result.stdout);
    assertSupported(name, version);
    return { name, path, version };
  }
}
