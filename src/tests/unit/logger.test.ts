import type { ProcessEnv } from 'node:process';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createProgressLogger, resolveLogLevel } from '../../logger.js';

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

describe('createProgressLogger', () => {
  it('logs progress percentages with the configured log level', async () => {
    const stream = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    stream.on('data', (chunk) => {
      const lines = chunk.toString('utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        messages.push(JSON.parse(line));
      }
    });

    const log = pino({ level: 'error' }, stream);
    const progressLogger = createProgressLogger(4, log, { phase: 'startup-test' });

    progressLogger('loading configuration');
    progressLogger('creating server');
    progressLogger('registering routes');
    progressLogger('ready to accept traffic');

    await new Promise((resolve) => setImmediate(resolve));

    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      msg: 'loading configuration',
      progress: 25,
      level: pino.levels.values.error,
      phase: 'startup-test'
    });
    expect(messages[3].progress).toBe(100);
  });

  it('omits output when the logger is silent', async () => {
    const stream = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    stream.on('data', (chunk) => {
      const lines = chunk.toString('utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        messages.push(JSON.parse(line));
      }
    });

    const log = pino({ level: 'silent' }, stream);
    const progressLogger = createProgressLogger(2, log);
    progressLogger('suppressed message');
    progressLogger('still suppressed');

    await new Promise((resolve) => setImmediate(resolve));

    expect(messages).toHaveLength(0);
  });
});
