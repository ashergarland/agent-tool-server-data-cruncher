import { delimiter } from 'node:path';

/**
 * Builds the complete environment handed to every child process.
 *
 * The environment is an allowlist constructed from scratch, so application secrets,
 * `RIPGREP_CONFIG_PATH`, `JQ_*`, `NODE_OPTIONS`, proxy settings and credentials of the parent
 * process can never reach `jq` (which exposes `env`/`$ENV` to filters) or ripgrep.
 */
export interface ChildEnvironmentOptions {
  readonly pathEntries: readonly string[];
  readonly tempDir: string;
  readonly platform?: NodeJS.Platform;
  readonly source?: NodeJS.ProcessEnv;
}

export const buildChildEnvironment = ({
  pathEntries,
  tempDir,
  platform = process.platform,
  source = process.env,
}: ChildEnvironmentOptions): Record<string, string> => {
  const environment: Record<string, string> = {
    PATH: [...new Set(pathEntries)].join(delimiter),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: tempDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };

  if (platform === 'win32') {
    // Windows binaries need the OS root to load system libraries. Neither value is sensitive.
    // Note: libuv additionally copies a fixed list of Windows variables (USERNAME, USERPROFILE,
    // HOMEDRIVE and similar) into every child on this platform. None is an application secret, and
    // the supported production platform is Linux, where this allowlist is exact.
    for (const key of ['SystemRoot', 'windir'] as const) {
      const value = source[key];
      if (value) environment[key] = value;
    }
  }

  return environment;
};
