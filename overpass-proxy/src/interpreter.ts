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

  // Group fine tiles into chunks of at least 50 tiles per upstream fetch
  const MIN_TILES_PER_FETCH = 50;

  const groupFineTilesForFetch = (fineHashes: string[]): Array<{ bounds: { south: number; west: number; north: number; east: number }; fineHashes: string[] }> => {
    if (fineHashes.length === 0) return [];
    
    if (fineHashes.length < MIN_TILES_PER_FETCH) {
      // Group all into one super-tile covering entire region
      const allFine = fineHashes.map((h) => fineTilesByHash.get(h)).filter((t): t is NonNullable<typeof t> => t !== undefined);
      if (allFine.length === 0) return [];
      
      const south = Math.min(...allFine.map((t) => t.bounds.south));
      const west = Math.min(...allFine.map((t) => t.bounds.west));
      const north = Math.max(...allFine.map((t) => t.bounds.north));
      const east = Math.max(...allFine.map((t) => t.bounds.east));
      
      return [{ bounds: { south, west, north, east }, fineHashes }];
    }
    
    // Try to use existing coarse tiles to group
    const result: Array<{ bounds: { south: number; west: number; north: number; east: number }; fineHashes: string[] }> = [];
    for (const coarse of coarseTiles) {
      const fineUnderCoarse = tilesForBoundingBox(coarse.bounds, deps.config.tilePrecision);
      const matchingHashes = fineUnderCoarse.map((t) => t.hash).filter((h) => fineHashes.includes(h));
      if (matchingHashes.length > 0) {
        result.push({ bounds: coarse.bounds, fineHashes: matchingHashes });
      }
    }
    
    // If any groups would be too small, merge them intelligently
    if (result.length > 1 && result.some((g) => g.fineHashes.length < MIN_TILES_PER_FETCH)) {
      // Merge small groups until each has at least MIN_TILES_PER_FETCH
      const merged: Array<{ bounds: { south: number; west: number; north: number; east: number }; fineHashes: string[] }> = [];
      let current = [...result];
      
      while (current.length > 0) {
        const first = current.shift()!;
        let combined = { ...first };
        
        // Try to merge with adjacent small groups
        current = current.filter((group) => {
          if (group.fineHashes.length >= MIN_TILES_PER_FETCH) return true;
          
          // Merge into current group
          combined.fineHashes.push(...group.fineHashes);
          // Recompute combined bounds
          const allFine = combined.fineHashes.map((h) => fineTilesByHash.get(h)).filter((t): t is NonNullable<typeof t> => t !== undefined);
          if (allFine.length === 0) return false;
          
          combined.bounds.south = Math.min(...allFine.map((t) => t.bounds.south));
          combined.bounds.west = Math.min(...allFine.map((t) => t.bounds.west));
          combined.bounds.north = Math.max(...allFine.map((t) => t.bounds.north));
          combined.bounds.east = Math.max(...allFine.map((t) => t.bounds.east));
          
          return false;
        });
        
        merged.push(combined);
      }
      
      return merged;
    }
    
    return result;
  };
  
  // Handle stale refreshes: group into fetches of at least MIN_TILES_PER_FETCH
  const staleHashes = Array.from(fineStaleSet);
  const staleGroups = groupFineTilesForFetch(staleHashes);
  for (const group of staleGroups) {
    void scheduleRefresh(async () => {
      const representative = fineTilesByHash.get(group.fineHashes[0]);
      if (!representative) return;
      await deps.store
        .withRefreshLock(representative, async () => {
          const response = await fetchTile(deps.config, group.bounds);
          await writeFineTilesFromCoarse(group.bounds, response, group.fineHashes);
        })
        .catch((error) => logger.warn({ err: error }, 'failed to refresh tile group'));
    });
  }
  
  // Handle cache misses: group into fetches of at least MIN_TILES_PER_FETCH
  const missingHashes = Array.from(fineMissingSet);
  const missingGroups = groupFineTilesForFetch(missingHashes);
  for (const group of missingGroups) {
    const representative = fineTilesByHash.get(group.fineHashes[0]);
    if (!representative) continue;
    const outcome = await deps.store.withMissLock(representative, async () => {
      const response = await fetchTile(deps.config, group.bounds);
      await writeFineTilesFromCoarse(group.bounds, response, group.fineHashes);
    });
    
    // After miss-lock, read each fine tile and add to responses
    for (const hash of group.fineHashes) {
      const fine = fineTilesByHash.get(hash);
      if (!fine) continue;
      const fresh = await deps.store.readTile(fine);
      if (fresh) {
        responses.push(fresh.payload.response);
      } else {
        logger.warn({ tile: fine.hash, outcome }, 'fine tile missing after fetch');
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
