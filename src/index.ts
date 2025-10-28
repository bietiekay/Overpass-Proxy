import formbody from '@fastify/formbody';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { Redis } from 'ioredis';

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
  const app = Fastify({ logger: true });
  void app.register(formbody);

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
