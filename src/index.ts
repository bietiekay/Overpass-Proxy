import formbody from '@fastify/formbody';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import { registerInterpreterRoutes } from './interpreter.js';
import { createLoggerOptions, createProgressLogger, logger } from './logger.js';
import { TileStore, type RestorePresenceProgress } from './store.js';
import { StatisticsWorkerClient } from './stats.js';

export interface BuildServerOptions {
  configOverrides?: Partial<AppConfig>;
  redisClient?: Redis;
  startupProgress?: (message: string) => void;
}

export const buildServer = async (options: BuildServerOptions = {}) => {
  const startupProgress = options.startupProgress ?? (() => {});
  const startupLogger = logger.child({ phase: 'startup' });
  startupProgress('loading configuration');
  const baseConfig = loadConfig();
  const config: AppConfig = { ...baseConfig, ...options.configOverrides };
  startupProgress('creating fastify instance');
  const app = Fastify({ logger: createLoggerOptions(), trustProxy: config.trustProxy });
  void app.register(formbody);

  const statisticsMapPath = resolve(process.cwd(), 'public', 'statistics-map.html');
  const cachePreheaterPath = resolve(process.cwd(), 'public', 'cache-preheater.html');
  const cacheInvalidatorPath = resolve(process.cwd(), 'public', 'cache-invalidator.html');

  // Simple CORS handling for browser clients
  app.addHook('onSend', async (_request, reply, payload) => {
    // Allow public access; adjust if you need to restrict origins
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, X-Requested-With, If-None-Match'
    );
    reply.header('Access-Control-Max-Age', '600');
    return payload;
  });

  app.get('/statistics-map', async (_request, reply) => {
    const html = await readFile(statisticsMapPath, 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.send(html);
  });

  app.get('/cache-preheater', async (_request, reply) => {
    const html = await readFile(cachePreheaterPath, 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.send(html);
  });

  app.get('/cache-invalidator', async (_request, reply) => {
    const html = await readFile(cacheInvalidatorPath, 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.send(html);
  });

  // Preflight requests
  app.options('*', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(204);
    reply.send();
  });

  const summariseBody = (body: unknown): { kind: string; size: number; preview?: string } => {
    if (typeof body === 'string') {
      const size = Buffer.byteLength(body, 'utf8');
      return { kind: 'string', size, preview: body.slice(0, 1000) };
    }
    if (Buffer.isBuffer(body)) {
      return { kind: 'buffer', size: body.length, preview: body.toString('utf8', 0, 1000) };
    }
    if (typeof body === 'object' && body !== null) {
      try {
        const json = JSON.stringify(body);
        const size = Buffer.byteLength(json, 'utf8');
        return { kind: 'object', size, preview: json.slice(0, 1000) };
      } catch {
        return { kind: 'object', size: 0 };
      }
    }
    return { kind: typeof body, size: 0 };
  };

  app.addHook('onRequest', async (request) => {
    app.log.info(
      {
        method: request.method,
        url: request.url,
        headers: request.headers,
        remoteAddress: request.ip
      },
      'incoming request'
    );
  });

  app.addHook('preValidation', async (request: FastifyRequest) => {
    if (request.method === 'POST') {
      const summary = summariseBody((request as FastifyRequest).body);
      app.log.info({ body: summary }, 'incoming POST body');
    }
  });
  startupProgress('registering base routes and hooks');

  startupProgress('initialising Redis client');
  const redis = options.redisClient ??
    new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3
    });

  const store = new TileStore(redis, {
    ttlSeconds: config.cacheTtlSeconds,
    swrSeconds: config.swrSeconds
  });

  const logRestoreProgress = (progress: RestorePresenceProgress) => {
    const progressPercent = progress.progressPercent ?? 0;
    const logContext: Record<string, unknown> = {
      stage: 'restoring cache presence',
      batches: progress.batches,
      cursor: progress.cursor,
      scannedKeys: progress.scannedKeys,
      restoredTiles: progress.restoredTiles
    };

    if (progress.totalTiles !== undefined) {
      logContext.totalTiles = progress.totalTiles;
    }

    logContext.progressPercent = progressPercent;

    startupLogger.info(
      logContext,
      `scanning Redis for cached tiles (${progressPercent}%)`
    );
  };

  startupProgress('restoring cache presence');
  await store.restorePresence(logRestoreProgress);

  startupProgress('preparing statistics subsystem');
  const statistics = new StatisticsWorkerClient({ config, redis, redisUrl: config.redisUrl });
  await statistics.ready();

  registerInterpreterRoutes(app, { config, redis, store, stats: statistics });
  startupProgress('registering interpreter routes');

  app.addHook('onClose', async () => {
    await statistics.stop();
    if (!options.redisClient) {
      await redis.quit();
    }
  });

  return { app, config };
};

export const start = async () => {
  const startupProgress = createProgressLogger(8, logger);
  const { app, config } = await buildServer({ startupProgress });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  startupProgress('overpass proxy listening');
  logger.info({ port: config.port }, 'overpass proxy listening');
};

if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    logger.error({ err: error }, 'failed to start server');
    process.exitCode = 1;
  });
}
