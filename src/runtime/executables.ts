import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { buildChildEnvironment } from './child-environment.js';
import { runCommand } from './subprocess.js';

export interface ResolvedExecutable {
  readonly name: 'jq' | 'rg';
  readonly path: string;
  readonly version: string;
}

export interface Executables {
  readonly jq: ResolvedExecutable;
  readonly ripgrep: ResolvedExecutable;
  /** PATH entries handed to children: only the directories holding the resolved binaries. */
  readonly pathEntries: readonly string[];
}

export class ExecutableResolutionError extends Error {
  public override readonly name = 'ExecutableResolutionError';
}

const executableNames = (name: string, platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? [`${name}.exe`, name] : [name];

const isExecutableFile = async (candidate: string): Promise<boolean> => {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    await access(candidate, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const findExecutable = async (
  name: string,
  options: {
    readonly override?: string | undefined;
    readonly pathValue?: string | undefined;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<string> => {
  const platform = options.platform ?? process.platform;
  if (options.override) {
    const candidate = resolve(options.override);
    if (!(await isExecutableFile(candidate))) {
      throw new ExecutableResolutionError(`Configured ${name} path is not an executable file`);
    }
    return candidate;
  }

  const searchPath = (options.pathValue ?? '').split(delimiter).filter(Boolean);
  for (const directory of searchPath) {
    if (!isAbsolute(directory)) continue;
    for (const fileName of executableNames(name, platform)) {
      const candidate = join(directory, fileName);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  throw new ExecutableResolutionError(`${name} was not found on PATH`);
};

const parseVersion = (name: 'jq' | 'rg', output: string): string => {
  const first = output.split('\n')[0]?.trim() ?? '';
  const match =
    name === 'jq' ? /jq-?\s*([0-9][^\s]*)/i.exec(first) : /([0-9]+\.[0-9]+\.?[0-9]*)/.exec(first);
  if (!match?.[1]) throw new ExecutableResolutionError(`Could not determine the ${name} version`);
  return match[1];
};

// jq must be 1.7+: queries pass the filter after `--`, and 1.6 treats an end-of-options separator
// that precedes the program as a usage error (exit 2), which the failure mapper would surface as
// invalid input on every call. Do not lower this without also changing how the filter is passed.
const minimumMajorMinor: Readonly<Record<'jq' | 'rg', readonly [number, number]>> = {
  jq: [1, 7],
  rg: [13, 0],
};

const assertSupported = (name: 'jq' | 'rg', version: string): void => {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [minMajor, minMinor] = minimumMajorMinor[name];
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new ExecutableResolutionError(
      `${name} ${version} is older than the required ${minMajor}.${minMinor}`,
    );
  }
};

const probe = async (
  name: 'jq' | 'rg',
  path: string,
  tempDir: string,
): Promise<ResolvedExecutable> => {
  const provisional: ResolvedExecutable = { name, path, version: 'unknown' };
  let output = '';
  const result = await runCommand({
    executable: provisional,
    args: ['--version'],
    cwd: tempDir,
    env: buildChildEnvironment({ pathEntries: [dirname(path)], tempDir }),
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    onStdout: (chunk) => {
      output += chunk.toString('utf8');
      return true;
    },
  });
  if (result.code !== 0) {
    throw new ExecutableResolutionError(`${name} did not report a version`);
  }
  const version = parseVersion(name, output);
  assertSupported(name, version);
  return { name, path, version };
};

export interface ResolveExecutablesOptions {
  readonly tempDir: string;
  readonly source?: NodeJS.ProcessEnv;
}

export const resolveExecutables = async ({
  tempDir,
  source = process.env,
}: ResolveExecutablesOptions): Promise<Executables> => {
  const [jqPath, ripgrepPath] = await Promise.all([
    findExecutable('jq', { override: source.JQ_PATH, pathValue: source.PATH }),
    findExecutable('rg', { override: source.RIPGREP_PATH, pathValue: source.PATH }),
  ]);
  const [jq, ripgrep] = await Promise.all([
    probe('jq', jqPath, tempDir),
    probe('rg', ripgrepPath, tempDir),
  ]);
  return { jq, ripgrep, pathEntries: [...new Set([dirname(jq.path), dirname(ripgrep.path)])] };
};
