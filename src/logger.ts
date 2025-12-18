import { pino, type LoggerOptions, type LevelWithSilent, type Logger, type LogFn } from 'pino';

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

export const resolveLogLevel = (
  env: NodeJS.ProcessEnv = process.env
): LevelWithSilent => {
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

export const createLoggerOptions = (
  env: NodeJS.ProcessEnv = process.env
): LoggerOptions => {
  const options: LoggerOptions = {
    level: resolveLogLevel(env)
  };

  if (env.NODE_ENV === 'development') {
    options.transport = { target: 'pino-pretty' } as LoggerOptions['transport'];
  }

  return options;
};

export const logger = pino(createLoggerOptions());

const resolveLogMethod = (log: Logger): LogFn => {
  if (log.level === 'silent') {
    return () => {};
  }

  const candidate = (log as unknown as Record<string, unknown>)[log.level];
  if (typeof candidate === 'function') {
    return (candidate as LogFn).bind(log);
  }

  return log.info.bind(log);
};

export const createProgressLogger = (
  totalSteps: number,
  log: Logger = logger,
  context: Record<string, unknown> = { phase: 'startup' }
): ((message: string) => void) => {
  const scopedLogger = context ? log.child(context) : log;
  const logMethod = resolveLogMethod(scopedLogger);
  const steps = Math.max(1, totalSteps);
  let currentStep = 0;

  return (message: string) => {
    currentStep += 1;
    const completed = Math.min(currentStep, steps);
    const progress = Math.round((completed / steps) * 100);
    logMethod({ progress }, message);
  };
};
