import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { combineResponses } from './assemble.js';
import {
  extractAmenityValue,
  extractBoundingBox,
  hasAmenityFilter,
  hasJsonOutput,
  isValidBoundingBox,
  type BoundingBox
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
  StatisticsWorkerClient,
  type CacheCoverageSnapshot,
  type CacheStatus,
  type StatisticsSnapshot
} from './stats.js';

interface InterpreterDeps {
  config: AppConfig;
  redis: Redis;
  store: TileStore;
  stats: StatisticsWorkerClient;
}

type InterpreterRequest = FastifyRequest;

const readNumberValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = readNumberValue(entry);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
};

const parseBoundingBoxInput = (value: unknown): BoundingBox | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const parts = value.split(/[, ]+/).filter((part) => part.length > 0);
    if (parts.length === 4) {
      const numbers = parts.map((part) => Number(part));
      if (numbers.every((num) => Number.isFinite(num))) {
        const [south, west, north, east] = numbers;
        return isValidBoundingBox(south, west, north, east) ? { south, west, north, east } : null;
      }
    }
  }

  if (Array.isArray(value) && value.length === 4) {
    const numbers = value.map((entry) => readNumberValue(entry));
    if (numbers.every((entry) => entry !== null)) {
      const [south, west, north, east] = numbers as number[];
      return isValidBoundingBox(south, west, north, east) ? { south, west, north, east } : null;
    }
  }

  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const south = readNumberValue(candidate.south);
    const west = readNumberValue(candidate.west);
    const north = readNumberValue(candidate.north);
    const east = readNumberValue(candidate.east);
    if ([south, west, north, east].every((entry) => entry !== null)) {
      const bbox = { south: south as number, west: west as number, north: north as number, east: east as number };
      return isValidBoundingBox(bbox.south, bbox.west, bbox.north, bbox.east) ? bbox : null;
    }
  }

  return null;
};

const extractInvalidateBoundingBox = (request: InterpreterRequest): BoundingBox | null => {
  const queryParams = request.query as Record<string, unknown>;
  const queryBbox = parseBoundingBoxInput(queryParams?.bbox);
  if (queryBbox) {
    return queryBbox;
  }

  const queryDirect = parseBoundingBoxInput({
    south: queryParams?.south,
    west: queryParams?.west,
    north: queryParams?.north,
    east: queryParams?.east
  });
  if (queryDirect) {
    return queryDirect;
  }

  if (request.body && typeof request.body === 'object') {
    const body = request.body as Record<string, unknown>;
    const bodyBbox = parseBoundingBoxInput(body.bbox);
    if (bodyBbox) {
      return bodyBbox;
    }
    return parseBoundingBoxInput(body);
  }

  return null;
};

const extractSecretValue = (request: InterpreterRequest): string | null => {
  const queryParams = request.query as Record<string, unknown>;
  const rawQuerySecret = queryParams?.secret;
  if (typeof rawQuerySecret === 'string' && rawQuerySecret.trim().length > 0) {
    return rawQuerySecret.trim();
  }
  if (Array.isArray(rawQuerySecret)) {
    const candidate = rawQuerySecret.find((value) => typeof value === 'string' && value.trim().length > 0);
    if (candidate) {
      return candidate.trim();
    }
  }

  if (request.body && typeof request.body === 'object') {
    const rawBodySecret = (request.body as Record<string, unknown>).secret;
    if (typeof rawBodySecret === 'string' && rawBodySecret.trim().length > 0) {
      return rawBodySecret.trim();
    }
  }

  return null;
};

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
  const shouldDeferStaleRefresh = deps.config.serveStaleFromCache && stale.length > 0 && missing.length === 0;
  let queuedStaleRefresh: (() => void) | null = null;
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
  // data immediately and refreshing in the background once the response has been delivered. When
  // cache coverage is incomplete—or when the feature is disabled—we await the refresh so responses
  // reflect the latest attempted write.
  if (shouldDeferStaleRefresh) {
    queuedStaleRefresh = () => {
      deps.stats.enqueueStaleRefreshTask({
        amenity: normalisedAmenity,
        groups: staleGroups,
        statsPayload
      });
    };
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

  const statsPayload = {
    amenity: normalisedAmenity,
    clientIp: request.ip,
    bbox,
    cacheStatus: cacheHeader,
    tileCount: tiles.length,
    tiles
  };
  let recordedStats = false;
  const recordStats = () => {
    if (recordedStats) return;

    deps.stats.recordRequest(statsPayload);
    recordedStats = true;
    const pendingPosts = deps.stats.getPendingRecordPosts();
    if (pendingPosts > 50) {
      logger.warn({ pendingPosts }, 'statistics worker record backlog');
    }
  };

  if (!shouldDeferStaleRefresh) {
    recordStats();
  }

  if (unresolvedTiles.length > 0 && missingFetchFailed) {
    recordStats();
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

  if (unresolvedTiles.length > 0) {
    recordStats();
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

  if (!shouldDeferStaleRefresh) {
    recordStats();
  }

  if (applyConditionalHeaders(request, reply, assembled)) {
    queuedStaleRefresh?.();
    return;
  }

  reply.header('Content-Type', 'application/json');
  reply.header('X-Cache', cacheHeader);
  if (fetchedAts.length > 0) {
    const oldestFetchedAt = Math.min(...fetchedAts);
    reply.header('X-Cache-Fetched-At', new Date(oldestFetchedAt).toISOString());
  }
  if (!shouldDeferStaleRefresh) {
    recordStats();
  }
  reply.send(assembled);
  queuedStaleRefresh?.();
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
    const { snapshot, pending } = await deps.stats.getStatisticsSnapshot();
    reply.header('Content-Type', 'application/json');

    if (!snapshot) {
      reply.code(202);
      reply.send({ pending: true });
      return;
    }

    const { cacheCoverage: _cacheCoverage, ...withoutCacheCoverage } = snapshot as StatisticsSnapshot &
      Partial<CacheCoverageSnapshot>;

    if (pending) {
      reply.code(202);
      reply.send({ ...withoutCacheCoverage, pending: true });
      return;
    }

    reply.send(withoutCacheCoverage);
  });

  app.get('/api/statistics/geohashCoverage', async (_request, reply) => {
    const snapshot = await deps.stats.getGeohashCoverageSnapshot();
    reply.header('Content-Type', 'application/json');
    if (snapshot.pending) {
      reply.code(202);
    }
    reply.send(snapshot);
  });

  app.get('/api/statistics/cacheCoverage', async (_request, reply) => {
    const snapshot = await deps.stats.getCacheCoverageSnapshot();
    reply.header('Content-Type', 'application/json');
    if (snapshot.pending) {
      reply.code(202);
    }
    reply.send(snapshot);
  });

  app.post('/api/cache/invalidate', async (request, reply) => {
    if (!deps.config.cacheInvalidateSecret) {
      reply.code(403);
      reply.send({ error: 'Cache invalidation secret is not configured' });
      return;
    }

    const secret = extractSecretValue(request as InterpreterRequest);
    if (!secret || secret !== deps.config.cacheInvalidateSecret) {
      reply.code(403);
      reply.send({ error: 'Invalid secret keyword' });
      return;
    }

    const bbox = extractInvalidateBoundingBox(request as InterpreterRequest);
    if (!bbox) {
      reply.code(400);
      reply.send({ error: 'Bounding box required' });
      return;
    }

    const tiles = tilesForBoundingBox(bbox, deps.config.tilePrecision);
    if (tiles.length > deps.config.maxTilesPerRequest) {
      reply.code(413);
      reply.send({ error: `Invalidate request requires ${tiles.length} tiles` });
      return;
    }

    const result = await deps.store.invalidateTiles(tiles);
    reply.header('Content-Type', 'application/json');
    reply.send({
      ok: true,
      bbox,
      tileCount: tiles.length,
      ...result
    });
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
