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
import {
  CacheCoverageOverflowError,
  RequestStatistics,
  type CacheCoverageSnapshot,
  type CacheStatus,
  type StatisticsSnapshot
} from './stats.js';

interface InterpreterDeps {
  config: AppConfig;
  redis: Redis;
  store: TileStore;
  stats: RequestStatistics;
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
  const upstreamOptions = { redis: deps.redis, clientKey: request.ip };
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

  const responsesByTile = new Map<string, { response: OverpassResponse; fetchedAt: number }>();
  const recordResponse = (tileHash: string, payload: { response: OverpassResponse; fetchedAt: number }) => {
    responsesByTile.set(tileHash, payload);
  };

  for (const tile of tiles) {
    const cachedTile = cached.get(tile.hash);
    if (cachedTile) {
      recordResponse(tile.hash, {
        response: cachedTile.payload.response,
        fetchedAt: cachedTile.payload.fetchedAt
      });
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
  const refreshStaleTiles = async (updateResponses: boolean) => {
    for (const group of staleGroups) {
      const representative = group.tiles[0];
      if (!representative) continue;

      await deps.store
        .withRefreshLock(representative, normalisedAmenity, async () => {
          const response = await fetchTile(deps.config, group.bounds, normalisedAmenity, upstreamOptions);
          await writeFineTilesFromGroup(response, group.tiles);
        })
        .catch((error) => logger.warn({ err: error }, 'failed to refresh tile group'));

      if (!updateResponses) continue;

      for (const fine of group.tiles) {
        const refreshed = await deps.store.readTile(fine, normalisedAmenity);
        if (refreshed) {
          recordResponse(fine.hash, {
            response: refreshed.payload.response,
            fetchedAt: refreshed.payload.fetchedAt
          });
        } else {
          const cachedTile = cached.get(fine.hash);
          if (cachedTile) {
            recordResponse(fine.hash, {
              response: cachedTile.payload.response,
              fetchedAt: cachedTile.payload.fetchedAt
            });
          }
        }
      }
    }
  };

  // If the request can be entirely satisfied from cache, optionally prefer speed by returning stale
  // data immediately and refreshing in the background. When cache coverage is incomplete—or when the
  // feature is disabled—we await the refresh so responses reflect the latest attempted write.
  if (deps.config.serveStaleFromCache && stale.length > 0 && missing.length === 0) {
    void refreshStaleTiles(false).catch((error) =>
      logger.warn({ err: error }, 'failed to refresh stale tiles in background')
    );
  } else {
    await refreshStaleTiles(true);
  }

  const missingGroups = planTileFetches(missing, planOptions);
  let missingFetchFailed = false;
  for (const group of missingGroups) {
    const representative = group.tiles[0];
    if (!representative) continue;
    const outcome = await deps.store
      .withMissLock(representative, normalisedAmenity, async () => {
        const response = await fetchTile(deps.config, group.bounds, normalisedAmenity, upstreamOptions);
        await writeFineTilesFromGroup(response, group.tiles);
      })
      .catch((error) => {
        missingFetchFailed = true;
        logger.warn({ err: error }, 'failed to fetch missing tile group');
        return 'waited';
      });

    for (const fine of group.tiles) {
      const fresh = await deps.store.readTile(fine, normalisedAmenity);
      if (fresh) {
        recordResponse(fine.hash, {
          response: fresh.payload.response,
          fetchedAt: fresh.payload.fetchedAt
        });
      } else {
        logger.warn({ tile: fine.hash, outcome }, 'fine tile missing after fetch');
      }
    }
  }

  const sortedResponses = Array.from(responsesByTile.values()).sort(
    (left, right) => left.fetchedAt - right.fetchedAt
  );
  const fetchedAts = sortedResponses.map((entry) => entry.fetchedAt);
  const unresolvedTiles = tiles.filter((tile) => !responsesByTile.has(tile.hash));
  let cacheHeader: CacheStatus;
  if (unresolvedTiles.length === 0) {
    cacheHeader = stale.length === 0 && !missingFetchFailed ? 'HIT' : 'STALE';
  } else if (responsesByTile.size > 0) {
    cacheHeader = 'STALE';
  } else {
    cacheHeader = 'MISS';
  }

  await deps.stats.recordRequest({
    amenity: normalisedAmenity,
    clientIp: request.ip,
    bbox,
    cacheStatus: cacheHeader,
    tileCount: tiles.length,
    tiles
  });

  if (unresolvedTiles.length > 0 && missingFetchFailed) {
    reply.code(503);
    reply.header('Content-Type', 'application/json');
    reply.header('X-Cache', cacheHeader);
    if (fetchedAts.length > 0) {
      const oldestFetchedAt = Math.min(...fetchedAts);
      reply.header('X-Cache-Fetched-At', new Date(oldestFetchedAt).toISOString());
    }
    reply.send({ error: 'Requested area unavailable from cache' });
    return;
  }

  const assembled = combineResponses(
    sortedResponses.map((entry) => entry.response),
    bbox
  );

  if (applyConditionalHeaders(request, reply, assembled)) {
    return;
  }

  reply.header('Content-Type', 'application/json');
  reply.header('X-Cache', cacheHeader);
  if (fetchedAts.length > 0) {
    const oldestFetchedAt = Math.min(...fetchedAts);
    reply.header('X-Cache-Fetched-At', new Date(oldestFetchedAt).toISOString());
  }
  reply.send(assembled);
};

export const registerInterpreterRoutes = (app: FastifyInstance, deps: InterpreterDeps): void => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/interpreter',
    handler: async (request, reply) => {
      const upstreamOptions = { redis: deps.redis, clientKey: request.ip };
      if (deps.config.transparentOnly) {
        await proxyTransparent(request, reply, deps.config, upstreamOptions);
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
        await proxyTransparent(request, reply, deps.config, upstreamOptions);
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

  app.get('/api/statistics', async (_request, reply) => {
    const { cacheCoverage: _cacheCoverage, ...snapshot } = (await deps.stats.getSnapshot()) as
      StatisticsSnapshot & Partial<CacheCoverageSnapshot>;
    reply.header('Content-Type', 'application/json');
    reply.send(snapshot);
  });

  app.get('/api/statistics/geohashCoverage', async (_request, reply) => {
    const snapshot = await deps.stats.getGeohashCoverageSnapshot();
    reply.header('Content-Type', 'application/json');
    reply.send(snapshot);
  });

  app.get('/api/statistics/cacheCoverage', async (request, reply) => {
    const { minPrecision, precision } = request.query as {
      minPrecision?: string;
      precision?: string;
    };
    const parsedMinPrecision = minPrecision ? Number.parseInt(minPrecision, 10) : undefined;
    const parsedPrecision = precision ? Number.parseInt(precision, 10) : undefined;
    const selectedMinPrecision = Number.isFinite(parsedMinPrecision)
      ? parsedMinPrecision
      : Number.isFinite(parsedPrecision)
        ? parsedPrecision
        : undefined;

    try {
      const snapshot = await deps.stats.getCacheCoverageSnapshot(undefined, {
        minPrecision: selectedMinPrecision
      });
      reply.header('Content-Type', 'application/json');
      reply.send(snapshot);
    } catch (error) {
      if (error instanceof CacheCoverageOverflowError) {
        reply.code(413);
        reply.send({
          error: 'Cache coverage payload too large',
          entryCount: error.entryCount,
          maxEntries: error.maxEntries,
          hint: 'Try requesting a lower minPrecision or precision to coarsen the geohashes'
        });
        return;
      }
      throw error;
    }
  });

  const transparentEndpoints = ['/api/status', '/api/timestamp', '/api/timestamp/*', '/api/kill_my_queries'];
  for (const endpoint of transparentEndpoints) {
    app.all(endpoint, async (request, reply) => {
      const upstreamOptions = { redis: deps.redis, clientKey: request.ip };
      await proxyTransparent(request, reply, deps.config, upstreamOptions);
    });
  }

  app.all('/api/*', async (request, reply) => {
    const upstreamOptions = { redis: deps.redis, clientKey: request.ip };
    await proxyTransparent(request, reply, deps.config, upstreamOptions);
  });
};
