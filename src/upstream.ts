import type { FastifyReply, FastifyRequest } from 'fastify';
import got, { RequestError } from 'got';
import type { Method } from 'got';

import type { BoundingBox } from './bbox.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { OverpassResponse } from './store.js';

export const buildTileQuery = (bbox: BoundingBox, amenity: string): string => {
  const escapedAmenity = amenity.replace(/"/g, '\\"');
  return `[
  out:json][timeout:120];
(
  node["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body meta;
>;
out skel qt;`;
};

interface UpstreamState {
  failedUntil: number;
}

class UpstreamPool {
  private readonly states = new Map<string, UpstreamState>();

  constructor(urls: string[], private readonly cooldownMs: number) {
    for (const url of urls) {
      this.states.set(url, { failedUntil: 0 });
    }
  }

  get size(): number {
    return this.states.size;
  }

  next(excluded: Set<string>): string | null {
    const now = Date.now();
    const available: string[] = [];

    for (const [url, state] of this.states) {
      if (excluded.has(url)) {
        continue;
      }
      if (state.failedUntil <= now) {
        available.push(url);
      }
    }

    if (available.length === 0) {
      return null;
    }

    if (available.length === 1) {
      return available[0];
    }

    const index = Math.floor(Math.random() * available.length);
    return available[index];
  }

  markFailure(url: string): void {
    const state = this.states.get(url);
    if (!state) {
      return;
    }

    const cooldownMs = Math.max(0, this.cooldownMs);
    state.failedUntil = cooldownMs === 0 ? 0 : Date.now() + cooldownMs;
  }

  markSuccess(url: string): void {
    const state = this.states.get(url);
    if (!state) {
      return;
    }

    state.failedUntil = 0;
  }
}

const poolCache = new WeakMap<AppConfig, UpstreamPool>();

const getPool = (config: AppConfig): UpstreamPool => {
  let pool = poolCache.get(config);
  if (!pool) {
    pool = new UpstreamPool(config.upstreamUrls, config.upstreamFailureCooldownSeconds * 1000);
    poolCache.set(config, pool);
  }
  return pool;
};

const shouldMarkFailure = (error: unknown): boolean => {
  if (error instanceof RequestError) {
    const statusCode = error.response?.statusCode;
    if (statusCode !== undefined && statusCode < 500 && statusCode !== 429) {
      return false;
    }
    return true;
  }

  return true;
};

const withUpstream = async <T>(config: AppConfig, fn: (baseUrl: string) => Promise<T>): Promise<T> => {
  const pool = getPool(config);
  if (pool.size === 0) {
    throw new Error('No upstream URLs configured');
  }

  const attempted = new Set<string>();
  let lastError: unknown;

  while (attempted.size < pool.size) {
    const upstream = pool.next(attempted);
    if (!upstream) {
      break;
    }

    try {
      const result = await fn(upstream);
      pool.markSuccess(upstream);
      return result;
    } catch (error) {
      attempted.add(upstream);
      if (!shouldMarkFailure(error)) {
        throw error;
      }

      lastError = error;
      pool.markFailure(upstream);
      logger.warn({ err: error, upstream, cooldownSeconds: config.upstreamFailureCooldownSeconds }, 'upstream request failed');
    }
  }

  throw lastError ?? new Error('No upstream URLs available');
};

export const fetchTile = async (
  config: AppConfig,
  bbox: BoundingBox,
  amenity: string
): Promise<OverpassResponse> => {
  const query = buildTileQuery(bbox, amenity);
  return await withUpstream(config, async (upstreamUrl) => {
    logger.info({ bbox, amenity, upstreamUrl }, 'upstream fetch start');
    const response = await got.post(upstreamUrl, {
      body: new URLSearchParams({ data: query }).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: { request: 120000 }
    });
    logger.info({ bbox, amenity, upstreamUrl }, 'upstream fetch done');
    return JSON.parse(response.body) as OverpassResponse;
  });
};

export const proxyTransparent = async (
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig
): Promise<void> => {
  try {
    await withUpstream(config, async (baseUrl) => {
      const upstreamUrl = new URL(request.url, baseUrl);
      let body: string | Buffer | undefined;
      let bodyReencoded = false;
      const start = Date.now();

      if (request.method === 'GET' || request.method === 'HEAD') {
        body = undefined;
      } else if (typeof request.body === 'string') {
        body = request.body;
      } else if (Buffer.isBuffer(request.body)) {
        body = request.body;
      } else if (request.body && typeof request.body === 'object') {
        body = new URLSearchParams(request.body as Record<string, string>).toString();
        bodyReencoded = true;
      }

      const headers = {
        ...request.headers,
        host: undefined
      } as Record<string, string | string[] | undefined>;
      if (bodyReencoded) {
        delete headers['content-length'];
        delete headers['Content-Length'];
      }

      const summarisePayload = (payload: string | Buffer | undefined) => {
        if (payload === undefined) {
          return { kind: 'empty' };
        }

        if (typeof payload === 'string') {
          return {
            kind: 'string',
            size: Buffer.byteLength(payload, 'utf8'),
            preview: payload.slice(0, 512)
          };
        }

        return {
          kind: 'buffer',
          size: payload.length,
          preview: payload.toString('utf8', 0, 512)
        };
      };

      const requestMeta = {
        method: request.method,
        url: request.url,
        upstreamUrl: upstreamUrl.toString(),
        remoteAddress: request.ip,
        bodyReencoded
      };

      logger.info(requestMeta, 'transparent proxy forwarding request');

      if (logger.levelVal <= logger.levels.values.debug) {
        logger.debug(
          {
            ...requestMeta,
            headers: request.headers,
            body: summarisePayload(body)
          },
          'transparent proxy request details'
        );
      }

      const response = await got(upstreamUrl.toString(), {
        method: request.method as Method,
        headers,
        body,
        throwHttpErrors: false,
        responseType: 'buffer',
        timeout: { request: 120000 }
      });

      if (response.statusCode >= 500 || response.statusCode === 429) {
        logger.warn(
          {
            ...requestMeta,
            statusCode: response.statusCode
          },
          'transparent proxy upstream failure'
        );
        throw new Error(`Upstream responded with status ${response.statusCode}`);
      }

      const durationMs = Date.now() - start;

      if (logger.levelVal <= logger.levels.values.debug) {
        logger.debug(
          {
            ...requestMeta,
            statusCode: response.statusCode,
            headers: response.headers,
            responseSize: response.rawBody.length
          },
          'transparent proxy response details'
        );
      }

      logger.info(
        {
          ...requestMeta,
          statusCode: response.statusCode,
          durationMs
        },
        'transparent proxy request completed'
      );

      reply.status(response.statusCode);
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') {
          reply.header(key, value);
        }
      }

      reply.send(response.rawBody);
    });
  } catch (error) {
    logger.error({ err: error }, 'transparent proxy upstream error');
    if (!reply.sent) {
      reply.code(502);
      reply.send({ error: 'Upstream error' });
    }
  }
};
