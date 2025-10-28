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
import { filterElementsByBbox } from './store.js';
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
  // limit concurrent stale refreshes per request (applied to coarse groups)
  const maxConcurrentRefreshes = 8;
  let activeRefreshes = 0;
  const refreshQueue: Array<() => void> = [];
  const scheduleRefresh = async (fn: () => Promise<void>) => {
    if (activeRefreshes >= maxConcurrentRefreshes) {
      await new Promise<void>((resolve) => refreshQueue.push(resolve));
    }
    activeRefreshes += 1;
    try {
      await fn();
    } finally {
      activeRefreshes -= 1;
      const next = refreshQueue.shift();
      if (next) next();
    }
  };

  // push any cached responses immediately
  for (const tile of tiles) {
    const cachedTile = cached.get(tile.hash);
    if (cachedTile) {
      responses.push(cachedTile.payload.response);
    }
  }

  // Group missing and stale fine tiles by coarse tiles to reduce upstream requests
  const fineMissingSet = new Set(missing.map((t) => t.hash));
  const fineStaleSet = new Set(stale.map((t) => t.hash));
  const coarseTiles = tilesForBoundingBox(bbox, deps.config.upstreamTilePrecision);

  const fineTilesByHash = new Map(tiles.map((t) => [t.hash, t] as const));

  const writeFineTilesFromCoarse = async (coarseBounds: { south: number; west: number; north: number; east: number }, response: any, fineHashes: string[]) => {
    for (const hash of fineHashes) {
      const fine = fineTilesByHash.get(hash);
      if (!fine) continue;
      const filtered = {
        ...response,
        elements: filterElementsByBbox(response.elements, fine.bounds)
      };
      await deps.store.writeTile(fine, filtered);
    }
  };

  // Handle stale refreshes in background per coarse tile
  for (const coarse of coarseTiles) {
    const fineUnderCoarse = tilesForBoundingBox(coarse.bounds, deps.config.tilePrecision);
    const fineHashes = fineUnderCoarse.map((t) => t.hash).filter((h) => fineStaleSet.has(h));
    if (fineHashes.length === 0) continue;
    void scheduleRefresh(async () => {
      // Use one representative fine tile lock to avoid duplicate concurrent refreshes
      const representative = fineTilesByHash.get(fineHashes[0]);
      if (!representative) return;
      await deps.store
        .withRefreshLock(representative, async () => {
          const response = await fetchTile(deps.config, coarse.bounds);
          await writeFineTilesFromCoarse(coarse.bounds, response, fineHashes);
        })
        .catch((error) => logger.warn({ err: error }, 'failed to refresh coarse tile'));
    });
  }

  // Handle cache misses by fetching each coarse tile once
  for (const coarse of coarseTiles) {
    const fineUnderCoarse = tilesForBoundingBox(coarse.bounds, deps.config.tilePrecision);
    const fineHashes = fineUnderCoarse.map((t) => t.hash).filter((h) => fineMissingSet.has(h));
    if (fineHashes.length === 0) continue;

    // Use miss-lock on one representative fine tile to coalesce concurrent requests
    const representative = fineTilesByHash.get(fineHashes[0]);
    if (!representative) continue;
    const outcome = await deps.store.withMissLock(representative, async () => {
      const response = await fetchTile(deps.config, coarse.bounds);
      await writeFineTilesFromCoarse(coarse.bounds, response, fineHashes);
    });

    // After miss-lock, read each fine tile and add to responses
    for (const hash of fineHashes) {
      const fine = fineTilesByHash.get(hash);
      if (!fine) continue;
      const fresh = await deps.store.readTile(fine);
      if (fresh) {
        responses.push(fresh.payload.response);
      } else {
        logger.warn({ tile: fine.hash, outcome }, 'fine tile missing after coarse miss-lock');
      }
    }
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
