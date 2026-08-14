import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

describe('configuration', () => {
  it('ignores blank optional values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      PUBLIC_BASE_URL: '',
    });
    expect(config.data.root).toBe('.');
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('rejects disabled production authentication', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })),
    ).toThrow(ConfigurationError);
  });

  it('requires strong API keys', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow('at least 32');
  });
});
