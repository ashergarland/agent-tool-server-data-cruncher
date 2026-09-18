import { describe, expect, it } from 'vitest';
import { loadDataCruncherConfig } from '../../src/config/index.js';

describe('Data Cruncher configuration', () => {
  it('uses bounded defaults and composes Platform configuration', () => {
    const config = loadDataCruncherConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      DATA_ROOT: 'fixtures',
    });
    expect(config.service.name).toBe('agent-tool-server-data-cruncher');
    expect(config.data.root).toBe('fixtures');
    expect(config.execution.limits).toMatchObject({
      maxFileBytes: 64 * 1024 * 1024,
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
      defaultOutputBytes: 128 * 1024,
      maxMatches: 1000,
      toolConcurrency: 2,
      toolQueueLimit: 32,
    });
  });

  it('treats blank optional variables as absent', () => {
    const config = loadDataCruncherConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      DATA_ROOT: '  ',
      JQ_PATH: '',
      RIPGREP_PATH: ' ',
      TEMP_DIR: '',
    });
    expect(config.data.root).toBeUndefined();
    expect(config.execution.jqPath).toBeUndefined();
    expect(config.execution.ripgrepPath).toBeUndefined();
    expect(config.execution.tempDir).toBeUndefined();
  });

  it('rejects invalid limits and cross-field output budgets', () => {
    expect(() =>
      loadDataCruncherConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        MAX_FILE_BYTES: '12',
      }),
    ).toThrow();
    expect(() =>
      loadDataCruncherConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        MAX_OUTPUT_BYTES: '1024',
        DEFAULT_OUTPUT_BYTES: '2048',
      }),
    ).toThrow(/DEFAULT_OUTPUT_BYTES/u);
  });
});
