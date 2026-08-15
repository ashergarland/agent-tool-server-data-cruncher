import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

const parse = (env: Record<string, unknown>) => envSchema.parse(env);
const production = {
  NODE_ENV: 'production',
  AUTH_MODE: 'api-key',
  API_KEYS: '12345678901234567890123456789012',
};

describe('configuration', () => {
  it('ignores blank optional values and applies defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      PUBLIC_BASE_URL: '',
    });
    expect(config.data.roots).toEqual(['.']);
    expect(config.data.localPathsEnabled).toBe(true);
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(config.assets.store.kind).toBe('disabled');
    expect(config.limits.defaultOutputBytes).toBeLessThan(config.limits.maxOutputBytes);
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('reads multiple data roots and an explicit local path switch', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      DATA_ROOTS: '/srv/one, /srv/two',
      LOCAL_PATHS_ENABLED: 'false',
    });
    expect(config.data.roots).toEqual(['/srv/one', '/srv/two']);
    expect(config.data.localPathsEnabled).toBe(false);
  });

  it('rejects disabled production authentication and weak keys', () => {
    expect(() => buildConfig(parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }))).toThrow(
      ConfigurationError,
    );
    expect(() =>
      buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow('at least 32');
  });

  it('rejects inconsistent limits', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          MAX_OUTPUT_BYTES: 4096,
          DEFAULT_OUTPUT_BYTES: 8192,
        }),
      ),
    ).toThrow('DEFAULT_OUTPUT_BYTES');
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          MAX_FILE_BYTES: 4096,
          ASSET_MAX_BYTES: 8192,
        }),
      ),
    ).toThrow('ASSET_MAX_BYTES');
    expect(() => parse({ SUBPROCESS_TIMEOUT_MS: 5 })).toThrow();
    expect(() => parse({ TOOL_CONCURRENCY: 0 })).toThrow();
  });

  it('fails fast on unusable production settings', () => {
    expect(() =>
      buildConfig(parse({ ...production, LOCAL_PATHS_ENABLED: 'true', DATA_ROOT: 'relative' })),
    ).toThrow('absolute');
    expect(() =>
      buildConfig(parse({ ...production, LOCAL_PATHS_ENABLED: 'false', ASSET_STORE: 'disabled' })),
    ).toThrow('asset store');
    expect(() =>
      buildConfig(
        parse({
          ...production,
          LOCAL_PATHS_ENABLED: 'false',
          ASSET_STORE: 'filesystem',
          ASSET_FS_ROOT: '/data/assets',
        }),
      ),
    ).toThrow('development store');
  });

  it('validates asset store settings', () => {
    expect(() =>
      buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'disabled', ASSET_STORE: 'filesystem' })),
    ).toThrow('ASSET_FS_ROOT');
    expect(() =>
      buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'disabled', ASSET_STORE: 'azure-blob' })),
    ).toThrow('AZURE_STORAGE_ACCOUNT');

    const config = buildConfig(
      parse({
        ...production,
        LOCAL_PATHS_ENABLED: 'false',
        ASSET_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'storageaccount',
        AZURE_STORAGE_CONTAINER: 'assets',
        AZURE_CLIENT_ID: 'client-id',
      }),
    );
    expect(config.assets.store).toEqual({
      kind: 'azure-blob',
      account: 'storageaccount',
      container: 'assets',
      clientId: 'client-id',
    });
  });

  it('reports every invalid environment value at once', () => {
    expect(() => loadConfig({ PORT: 'not-a-port', AUTH_MODE: 'nope' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
