import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});
