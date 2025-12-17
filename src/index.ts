import formbody from '@fastify/formbody';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import { registerInterpreterRoutes } from './interpreter.js';
import { createLoggerOptions, logger } from './logger.js';
import { TileStore } from './store.js';
import { RedisStatisticsStorage, RequestStatistics } from './stats.js';
import { createUpstreamMetricsProvider } from './upstream.js';

export interface BuildServerOptions {
  configOverrides?: Partial<AppConfig>;
  redisClient?: Redis;
}

export const buildServer = async (options: BuildServerOptions = {}) => {
  const baseConfig = loadConfig();
  const config: AppConfig = { ...baseConfig, ...options.configOverrides };
  const app = Fastify({ logger: createLoggerOptions(), trustProxy: config.trustProxy });
  void app.register(formbody);

  const statisticsMapPath = resolve(process.cwd(), 'public', 'statistics-map.html');
  const cachePreheaterPath = resolve(process.cwd(), 'public', 'cache-preheater.html');

  // Simple CORS handling for browser clients
  const applyCorsHeaders = (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin ?? '*';
    reply.header('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, X-Requested-With, If-None-Match'
    );
    reply.header('Access-Control-Max-Age', '600');
  };

  app.addHook('onRequest', async (request, reply) => {
    applyCorsHeaders(request, reply);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    applyCorsHeaders(request, reply);
    return payload;
  });

  app.addHook('onError', async (request, reply) => {
    applyCorsHeaders(request, reply);
  });

  // Preflight requests
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'OPTIONS') return;
    applyCorsHeaders(request, reply);
    reply.code(204);
    return reply.send();
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

  const redis = options.redisClient ??
    new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3
    });

  const store = new TileStore(redis, {
    ttlSeconds: config.cacheTtlSeconds,
    swrSeconds: config.swrSeconds,
    singleInstanceRedisCache: config.singleInstanceRedisCache
  });

  if (!config.singleInstanceRedisCache) {
    await store.restorePresence();
  }

  const statisticsStorage = new RedisStatisticsStorage(redis);
  const upstreamMetrics = await createUpstreamMetricsProvider(config, redis);
  const statistics = await RequestStatistics.create(store, statisticsStorage, upstreamMetrics);

  registerInterpreterRoutes(app, { config, redis, store, stats: statistics });

  app.addHook('onClose', async () => {
    if (!options.redisClient) {
      await redis.quit();
    }
  });

  return { app, config };
};

export const start = async () => {
  const { app, config } = await buildServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port }, 'overpass proxy listening');
};

if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    logger.error({ err: error }, 'failed to start server');
    process.exitCode = 1;
  });
}
