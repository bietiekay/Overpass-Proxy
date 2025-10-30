import type { ProcessEnv } from 'node:process';
import { describe, expect, it } from 'vitest';

import { resolveLogLevel } from '../../logger.js';

describe('resolveLogLevel', () => {
  it('maps explicit verbosity levels', () => {
    expect(resolveLogLevel({ LOG_VERBOSITY: 'errors' } as ProcessEnv)).toBe('error');
    expect(resolveLogLevel({ LOG_VERBOSITY: 'INFO' } as ProcessEnv)).toBe('info');
    expect(resolveLogLevel({ LOG_VERBOSITY: 'full' } as ProcessEnv)).toBe('debug');
  });

  it('falls back to LOG_LEVEL when provided', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'warn' } as ProcessEnv)).toBe('warn');
  });

  it('defaults to silent during tests when unset', () => {
    expect(resolveLogLevel({ NODE_ENV: 'test' } as ProcessEnv)).toBe('silent');
  });

  it('defaults to info otherwise', () => {
    expect(resolveLogLevel({} as ProcessEnv)).toBe('info');
  });
});
