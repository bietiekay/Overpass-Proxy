import { pino, type LoggerOptions, type LevelWithSilent } from 'pino';
import type { ProcessEnv } from 'node:process';

const mapVerbosity = (value: string): LevelWithSilent | null => {
  switch (value) {
    case 'errors':
    case 'error':
      return 'error';
    case 'info':
      return 'info';
    case 'full':
    case 'debug':
    case 'verbose':
      return 'debug';
    default:
      return null;
  }
};

export const resolveLogLevel = (env: ProcessEnv = process.env): LevelWithSilent => {
  const verbosity = env.LOG_VERBOSITY?.toLowerCase().trim();
  const mapped = verbosity ? mapVerbosity(verbosity) : null;
  if (mapped) {
    return mapped;
  }

  const explicitLevel = env.LOG_LEVEL?.toLowerCase().trim();
  if (explicitLevel) {
    return explicitLevel as LevelWithSilent;
  }

  if (env.NODE_ENV === 'test') {
    return 'silent';
  }

  return 'info';
};

export const createLoggerOptions = (env: ProcessEnv = process.env): LoggerOptions => {
  const options: LoggerOptions = {
    level: resolveLogLevel(env)
  };

  if (env.NODE_ENV === 'development') {
    options.transport = { target: 'pino-pretty' } as LoggerOptions['transport'];
  }

  return options;
};

export const logger = pino(createLoggerOptions());
