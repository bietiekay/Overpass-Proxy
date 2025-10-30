import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { combineResponses } from './assemble.js';
import {
  extractAmenityValue,
  extractBoundingBox,
  hasAmenityFilter,
  hasJsonOutput
} from './bbox.js';
import type { AppConfig } from './config.js';
import { TooManyTilesError } from './errors.js';
import { applyConditionalHeaders } from './headers.js';
import { logger } from './logger.js';
import type { TileStore } from './store.js';
import { tilesForBoundingBox, type TileInfo } from './tiling.js';
import { filterElementsByBbox, type OverpassResponse } from './store.js';
import { planTileFetches } from './fetchPlan.js';
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

const extractAmenityPreference = (request: InterpreterRequest, query: string): string => {
  const fromQuery = extractAmenityValue(query);
  if (fromQuery) {
    return fromQuery;
  }

  const normalise = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalised = normalise(item);
        if (normalised) {
          return normalised;
        }
      }
    }
    return null;
  };

  if (request.method === 'GET') {
    const queryParams = request.query as Record<string, unknown>;
    const maybe = normalise(queryParams?.amenity);
    if (maybe) {
      return maybe;
    }
  }

  if (typeof request.body === 'string') {
    try {
      const params = new URLSearchParams(request.body);
      const maybe = params.get('amenity');
      if (maybe && maybe.trim().length > 0) {
        return maybe.trim();
      }
    } catch {
      // ignore parsing errors
    }
  } else if (Buffer.isBuffer(request.body)) {
    try {
      const params = new URLSearchParams(request.body.toString('utf8'));
      const maybe = params.get('amenity');
      if (maybe && maybe.trim().length > 0) {
        return maybe.trim();
      }
    } catch {
      // ignore parsing errors
    }
  } else if (request.body && typeof request.body === 'object') {
    const maybe = normalise((request.body as Record<string, unknown>).amenity);
    if (maybe) {
      return maybe;
    }
  }

  return 'toilets';
};

const handleCacheable = async (
  request: InterpreterRequest,
  reply: FastifyReply,
  deps: InterpreterDeps,
  query: string,
  amenity: string
): Promise<void> => {
  const normalisedAmenity = amenity.trim().toLowerCase();
  const bbox = extractBoundingBox(query);
  if (!bbox) {
    reply.code(400);
    reply.send({ error: 'Bounding box required' });
    return;
  }

  logger.info(
    {
      bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north },
      amenity: normalisedAmenity,
      requestedAmenity: amenity
    },
    'cacheable request with bbox'
  );

  const tiles = tilesForBoundingBox(bbox, deps.config.tilePrecision);
  if (tiles.length > deps.config.maxTilesPerRequest) {
    throw new TooManyTilesError(`Request requires ${tiles.length} tiles`);
  }

  const cached = await deps.store.readTiles(tiles, normalisedAmenity);
  const missing = tiles.filter((tile) => !cached.has(tile.hash));
  const stale = tiles.filter((tile) => cached.get(tile.hash)?.stale ?? false);

  const responses: OverpassResponse[] = [];
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

  const writeFineTilesFromGroup = async (
    response: OverpassResponse,
    fineTiles: TileInfo[]
  ) => {
    const entries = fineTiles.map((fine) => {
      const filtered: OverpassResponse = {
        ...response,
        elements: filterElementsByBbox(response.elements, fine.bounds)
      };

      return { tile: fine, response: filtered };
    });

    await deps.store.writeTiles(entries, normalisedAmenity);
  };

  const planOptions = {
    coarsePrecision: deps.config.upstreamTilePrecision,
    finePrecision: deps.config.tilePrecision
  };

  const staleGroups = planTileFetches(stale, planOptions);
  for (const group of staleGroups) {
    const representative = group.tiles[0];
    if (!representative) continue;
    void scheduleRefresh(async () => {
      await deps.store
        .withRefreshLock(representative, normalisedAmenity, async () => {
          const response = await fetchTile(deps.config, group.bounds, normalisedAmenity);
          await writeFineTilesFromGroup(response, group.tiles);
        })
        .catch((error) => logger.warn({ err: error }, 'failed to refresh tile group'));
    });
  }

  const missingGroups = planTileFetches(missing, planOptions);
  for (const group of missingGroups) {
    const representative = group.tiles[0];
    if (!representative) continue;
    const outcome = await deps.store.withMissLock(representative, normalisedAmenity, async () => {
      const response = await fetchTile(deps.config, group.bounds, normalisedAmenity);
      await writeFineTilesFromGroup(response, group.tiles);
    });

    for (const fine of group.tiles) {
      const fresh = await deps.store.readTile(fine, normalisedAmenity);
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

  reply.header('Content-Type', 'application/json');
  const cacheHeader = missing.length === 0 && stale.length === 0 ? 'HIT' : missing.length === 0 ? 'STALE' : 'MISS';
  reply.header('X-Cache', cacheHeader);
  reply.send(assembled);
};

export const registerInterpreterRoutes = (app: FastifyInstance, deps: InterpreterDeps): void => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/interpreter',
    handler: async (request, reply) => {
      if (deps.config.transparentOnly) {
        await proxyTransparent(request, reply, deps.config);
        return;
      }

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
        const amenity = extractAmenityPreference(request as InterpreterRequest, query);
        await handleCacheable(request as InterpreterRequest, reply, deps, query, amenity);
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
