import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import Redis from 'ioredis';

import { loadConfig, type AppConfig } from './config.js';
import { registerInterpreterRoutes } from './interpreter.js';
import { logger } from './logger.js';
import { TileStore } from './store.js';

export interface BuildServerOptions {
  configOverrides?: Partial<AppConfig>;
  redisClient?: Redis;
}

export const buildServer = (options: BuildServerOptions = {}) => {
  const baseConfig = loadConfig();
  const config: AppConfig = { ...baseConfig, ...options.configOverrides };
  const app = Fastify({ logger });
  void app.register(formbody);

  const redis = options.redisClient ??
    new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3
    });

  const store = new TileStore(redis, {
    ttlSeconds: config.cacheTtlSeconds,
    swrSeconds: config.swrSeconds
  });

  registerInterpreterRoutes(app, { config, redis, store });

  app.addHook('onClose', async () => {
    if (!options.redisClient) {
      await redis.quit();
    }
  });

  return { app, config };
};

export const start = async () => {
  const { app, config } = buildServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port }, 'overpass proxy listening');
};

if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    logger.error({ err: error }, 'failed to start server');
    process.exitCode = 1;
  });
}
