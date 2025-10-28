/* eslint-disable @typescript-eslint/no-floating-promises */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { combineResponses } from './assemble.js';
import { extractBoundingBox, hasAmenityFilter, hasJsonOutput } from './bbox.js';
import type { AppConfig } from './config.js';
import { TooManyTilesError } from './errors.js';
import { applyConditionalHeaders } from './headers.js';
import { logger } from './logger.js';
import type { TileStore } from './store.js';
import { tilesForBoundingBox } from './tiling.js';
import { fetchTile, proxyTransparent } from './upstream.js';

interface InterpreterDeps {
  config: AppConfig;
  redis: Redis;
  store: TileStore;
}

type InterpreterRequest = FastifyRequest;

const requestBodyToQuery = (request: InterpreterRequest): string | null => {
  if (request.method === 'GET') {
    const query = request.query as Record<string, string | string[]>;
    const data = query?.data ?? query?.q;
    if (!data) {
      return null;
    }

    return Array.isArray(data) ? data[0] : data;
  }

  if (!request.body) {
    return null;
  }

  if (typeof request.body === 'string') {
    return request.body;
  }

  if (Buffer.isBuffer(request.body)) {
    return request.body.toString('utf8');
  }

  if (typeof request.body === 'object' && request.body !== null && 'data' in request.body) {
    const maybe = (request.body as Record<string, unknown>).data;
    if (typeof maybe === 'string') {
      return maybe;
    }
  }

  return null;
};

const handleCacheable = async (
  request: InterpreterRequest,
  reply: FastifyReply,
  deps: InterpreterDeps,
  query: string
): Promise<void> => {
  const bbox = extractBoundingBox(query);
  if (!bbox) {
    reply.code(400);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.send({ error: 'Bounding box required' });
    return;
  }

  logger.info(
    {
      bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north }
    },
    'cacheable request with bbox'
  );

  const tiles = tilesForBoundingBox(bbox, deps.config.tilePrecision);
  if (tiles.length > deps.config.maxTilesPerRequest) {
    throw new TooManyTilesError(`Request requires ${tiles.length} tiles`);
  }

  const cached = await deps.store.readTiles(tiles);
  const missing = tiles.filter((tile) => !cached.has(tile.hash));
  const stale = tiles.filter((tile) => cached.get(tile.hash)?.stale ?? false);

  const responses = [];

  for (const tile of tiles) {
    const cachedTile = cached.get(tile.hash);
    if (cachedTile) {
      responses.push(cachedTile.payload.response);
      if (cachedTile.stale) {
        void deps.store
          .withRefreshLock(tile, async () => {
            const response = await fetchTile(deps.config, tile.bounds);
            await deps.store.writeTile(tile, response);
          })
          .catch((error) => logger.warn({ err: error }, 'failed to refresh tile'));
      }
      continue;
    }

    const response = await fetchTile(deps.config, tile.bounds);
    await deps.store.writeTile(tile, response);
    responses.push(response);
  }

  const assembled = combineResponses(responses, bbox);

  if (applyConditionalHeaders(request, reply, assembled)) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  reply.header('Content-Type', 'application/json');
  const cacheHeader = missing.length === 0 && stale.length === 0 ? 'HIT' : missing.length === 0 ? 'STALE' : 'MISS';
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  reply.header('X-Cache', cacheHeader);
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  reply.send(assembled);
};

export const registerInterpreterRoutes = (app: FastifyInstance, deps: InterpreterDeps): void => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/interpreter',
    handler: async (request, reply) => {
      const query = requestBodyToQuery(request as InterpreterRequest);
      if (!query) {
        reply.code(400);
        reply.send({ error: 'Query payload required' });
        return;
      }

      // Proxy any non-cacheable requests upstream to keep full compatibility
      if (!hasJsonOutput(query) || !hasAmenityFilter(query)) {
        await proxyTransparent(request, reply, deps.config);
        return;
      }

      try {
        await handleCacheable(request as InterpreterRequest, reply, deps, query);
      } catch (error) {
        if (error instanceof TooManyTilesError) {
          reply.code(413);
          reply.send({ error: error.message });
          return;
        }

        logger.error({ err: error }, 'failed to handle cacheable request');
        reply.code(500);
        reply.send({ error: 'Internal server error' });
      }
    }
  });

  const transparentEndpoints = ['/api/status', '/api/timestamp', '/api/timestamp/*', '/api/kill_my_queries'];
  for (const endpoint of transparentEndpoints) {
    app.all(endpoint, async (request, reply) => {
      await proxyTransparent(request, reply, deps.config);
    });
  }

  app.all('/api/*', async (request, reply) => {
    await proxyTransparent(request, reply, deps.config);
  });
};
