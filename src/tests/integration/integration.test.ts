import type Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractBoundingBox } from '../../bbox.js';
import { buildServer } from '../../index.js';
import { tileKey, tilesForBoundingBox } from '../../tiling.js';
import { InMemoryRedis } from '../helpers/inMemoryRedis.js';
import { createMockOverpass } from './mock-overpass.js';
import { createTestEnvironment } from './testcontainers.js';

const jsonQuery = '[out:json];node["amenity"="toilets"](52.5,13.3,52.6,13.4);out;';
const formBody = (query: string) => new URLSearchParams({ data: query }).toString();
const drinkingWaterQuery =
  '[out:json];node["amenity"="drinking_water"](52.5,13.3,52.6,13.4);out;';
const uppercaseAmenityQuery = '[out:json];node["amenity"="TOILETS"](52.5,13.3,52.6,13.4);out;';

let stopEnv: (() => Promise<void>) | undefined;
let baseUrl: string;
let hits: string[];
let closeMain: (() => Promise<void>) | undefined;
let redisClient: Redis | undefined;
let upstreamUrls: string[] = [];
let setResponder: ReturnType<typeof createTestEnvironment>['setResponder'];
let resetResponder: ReturnType<typeof createTestEnvironment>['resetResponder'];

beforeAll(async () => {
  const env = await createTestEnvironment();
  stopEnv = env.stop;
  hits = env.hits;
  redisClient = env.redis;
  upstreamUrls = env.upstreamUrls;
  setResponder = env.setResponder;
  resetResponder = env.resetResponder;

  await redisClient.flushall();

  const { app } = await buildServer({
    configOverrides: {
      upstreamUrls: env.upstreamUrls,
      cacheTtlSeconds: 1,
      swrSeconds: 1,
      tilePrecision: 5
    },
    redisClient: env.redis
  });

  await app.ready();
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  closeMain = async () => {
    await app.close();
  };
});

afterAll(async () => {
  if (closeMain) {
    await closeMain();
  }
  if (stopEnv) {
    await stopEnv();
  }
});

describe('integration', () => {
  it('keeps caches separate for different amenity types', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(drinkingWaterQuery))
      .expect(200);

    const hitsAfterFirst = hits.length;
    expect(hitsAfterFirst).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/drinking_water$/);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(drinkingWaterQuery))
      .expect(200);

    expect(hits.length).toBe(hitsAfterFirst);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    expect(hits.some((entry) => entry.endsWith(':drinking_water'))).toBe(true);
    expect(hits.some((entry) => entry.endsWith(':toilets'))).toBe(true);
  });

  it('caches json bbox requests', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const initialHits = hits.length;
    expect(initialHits).toBeGreaterThan(0);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    expect(hits.length).toBe(initialHits);
  });

  it('exposes the oldest fetch time for cached responses', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const first = await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const firstFetchedAt = first.headers['x-cache-fetched-at'];
    expect(firstFetchedAt).toBeDefined();

    const second = await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const secondFetchedAt = second.headers['x-cache-fetched-at'];
    expect(secondFetchedAt).toBeDefined();
    expect(new Date(secondFetchedAt as string).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(firstFetchedAt as string).getTime()).toBeLessThanOrEqual(
      new Date(secondFetchedAt as string).getTime()
    );
  });

  it('refreshes stale cache entries and returns refreshed data when upstream succeeds', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls,
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5,
        serveStaleFromCache: false
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const first = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const firstFetchedAt = new Date(first.headers['x-cache-fetched-at'] as string).getTime();
      expect(firstFetchedAt).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const second = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const secondFetchedAt = new Date(second.headers['x-cache-fetched-at'] as string).getTime();
      expect(secondFetchedAt).toBeGreaterThan(firstFetchedAt);
      expect(hits.length).toBeGreaterThan(1);
    } finally {
      await app.close();
    }
  });

  it('serves stale cache immediately and refreshes in the background when configured', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls,
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5,
        serveStaleFromCache: true
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const first = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const firstFetchedAt = new Date(first.headers['x-cache-fetched-at'] as string).getTime();
      const hitsAfterFirst = hits.length;

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const second = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const secondFetchedAt = new Date(second.headers['x-cache-fetched-at'] as string).getTime();
      expect(secondFetchedAt).toBe(firstFetchedAt);
      expect(second.headers['x-cache']).toBe('STALE');

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(hits.length).toBeGreaterThan(hitsAfterFirst);
    } finally {
      await app.close();
    }
  });

  it('serves stale cache entries when refresh fails upstream', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls,
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const first = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const firstFetchedAt = new Date(first.headers['x-cache-fetched-at'] as string).getTime();

      await new Promise((resolve) => setTimeout(resolve, 1100));

      setResponder?.(() => ({ status: 500 }));

      const second = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const secondFetchedAt = new Date(second.headers['x-cache-fetched-at'] as string).getTime();
      expect(secondFetchedAt).toBe(firstFetchedAt);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      resetResponder?.();
      await app.close();
    }
  });

  it('falls back to another upstream when refreshing stale tiles in the background', async () => {
    const primaryUpstream = createMockOverpass();
    const secondaryUpstream = createMockOverpass();

    await primaryUpstream.start(0);
    await secondaryUpstream.start(0);

    const primaryAddress = primaryUpstream.app.server.address();
    const primaryPort = typeof primaryAddress === 'object' && primaryAddress ? primaryAddress.port : 0;
    const primaryUrl = `http://127.0.0.1:${primaryPort}/api/interpreter`;

    const secondaryAddress = secondaryUpstream.app.server.address();
    const secondaryPort =
      typeof secondaryAddress === 'object' && secondaryAddress ? secondaryAddress.port : 0;
    const secondaryUrl = `http://127.0.0.1:${secondaryPort}/api/interpreter`;

    const redis = new InMemoryRedis();

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls: [primaryUrl, secondaryUrl],
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5,
        serveStaleFromCache: true
      },
      redisClient: redis as unknown as Redis
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const initialPrimaryHits = primaryUpstream.hits.length;
      const initialSecondaryHits = secondaryUpstream.hits.length;

      await new Promise((resolve) => setTimeout(resolve, 1100));

      primaryUpstream.setResponder?.(() => ({ status: 500 }));

      const second = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      expect(second.headers['x-cache']).toBe('STALE');

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(primaryUpstream.hits.length).toBeGreaterThanOrEqual(initialPrimaryHits);
      expect(secondaryUpstream.hits.length).toBeGreaterThan(initialSecondaryHits);
    } finally {
      await app.close();
      await redis.quit();
      await primaryUpstream.stop();
      await secondaryUpstream.stop();
    }
  });

  it('serves stale cache entries when no upstreams are available', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const first = await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const firstFetchedAt = new Date(first.headers['x-cache-fetched-at'] as string).getTime();

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls: [],
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const second = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const secondFetchedAt = new Date(second.headers['x-cache-fetched-at'] as string).getTime();
      expect(secondFetchedAt).toBe(firstFetchedAt);
      expect(second.headers['x-cache']).toBe('STALE');
    } finally {
      await app.close();
    }
  });

  it('fails when stale cache does not fully cover the requested bbox and no upstreams are available', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const bbox = extractBoundingBox(jsonQuery);
    expect(bbox).toBeDefined();
    const tiles = tilesForBoundingBox(bbox!, 5);
    expect(tiles.length).toBeGreaterThan(0);

    const missingTile = tiles[0];
    const amenityKey = 'toilets';
    if (redisClient) {
      await redisClient.del(tileKey(missingTile.hash, amenityKey));
    }

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls: [],
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const response = await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(503);

      expect(response.headers['x-cache']).toBe('STALE');
      expect(response.body?.error).toMatch(/unavailable/i);
    } finally {
      await app.close();
    }
  });

  it('normalises amenity before fetching tiles', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(uppercaseAmenityQuery))
      .expect(200);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/:toilets$/);
  });

  it('exposes aggregated statistics', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const response = await request(baseUrl).get('/api/statistics').expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    const snapshot = response.body;
    expect(snapshot.totalRequests).toBeGreaterThanOrEqual(2);
    const amenityStats = snapshot.amenities.find((entry: any) => entry.amenity === 'toilets');
    expect(amenityStats).toBeDefined();
    expect(amenityStats.requests).toBeGreaterThanOrEqual(2);
    expect(amenityStats.geohashCoverage).toBeUndefined();
  });

  it('exposes cache coverage separately', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const response = await request(baseUrl).get('/api/statistics/cacheCoverage').expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(Array.isArray(response.body.cacheCoverage)).toBe(true);
  });

  it('exposes geohash coverage separately', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const response = await request(baseUrl).get('/api/statistics/geohashCoverage').expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(Array.isArray(response.body.geohashCoverage)).toBe(true);
    expect(Array.isArray(response.body.geohashCoverage[0]?.geohashCoverage)).toBe(true);
  });

  it('adds CORS headers to API responses', async () => {
    await redisClient?.flushall();

    const response = await request(baseUrl)
      .get('/api/statistics')
      .set('Origin', 'null')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers.vary).toContain('Origin');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
  });

  it('responds to CORS preflight requests', async () => {
    await redisClient?.flushall();

    const response = await request(baseUrl)
      .options('/api/statistics/cacheCoverage')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Content-Type')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('keeps CORS headers on error responses', async () => {
    const response = await request(baseUrl)
      .get('/api/non-existent-endpoint')
      .set('Origin', 'https://example.com')
      .expect(404);

    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(response.headers.vary).toContain('Origin');
  });

  it('does not include cache coverage in the aggregated statistics payload', async () => {
    await redisClient?.flushall();

    const response = await request(baseUrl).get('/api/statistics').expect(200);

    expect(response.body.cacheCoverage).toBeUndefined();
    expect(response.body.geohashCoverage).toBeUndefined();
  });

  it('includes upstream health and request counters in statistics', async () => {
    await redisClient?.flushall();

    const response = await request(baseUrl).get('/api/statistics').expect(200);
    const upstreams = response.body.upstreams;

    expect(Array.isArray(upstreams)).toBe(true);
    expect(upstreams).toHaveLength(upstreamUrls.length);
    for (const entry of upstreams) {
      expect(typeof entry.upstream).toBe('string');
      expect(['available', 'cooldown', 'blocked']).toContain(entry.status);
      expect(typeof entry.reason).toBe('string');
      expect(typeof entry.requestsToday).toBe('number');
      expect(typeof entry.dayStart).toBe('string');
    }
  });

  it('tracks unique clients using forwarded headers when proxy trust is enabled', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls,
        cacheTtlSeconds: 1,
        swrSeconds: 1,
        tilePrecision: 5,
        trustProxy: true
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('X-Forwarded-For', '203.0.113.1')
        .send(formBody(jsonQuery))
        .expect(200);

      await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('X-Forwarded-For', '203.0.113.2')
        .send(formBody(jsonQuery))
        .expect(200);

      const response = await request(url).get('/api/statistics').expect(200);
      expect(response.body.totalUniqueClients).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  it('returns 304 when etag matches', async () => {
    await redisClient?.flushall();
    const first = await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const etag = first.headers.etag;
    expect(etag).toBeDefined();

    await request(baseUrl)
      .post('/api/interpreter')
      .set('If-None-Match', etag)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(304);
  });

  it('enforces MAX_TILES_PER_REQUEST', async () => {
    await redisClient?.flushall();
    const env = await createTestEnvironment();
    await env.redis.flushall();

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls: env.upstreamUrls,
        maxTilesPerRequest: 4,
        tilePrecision: 5
      },
      redisClient: env.redis
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const largeQuery = '[out:json];node["amenity"](0,0,10,10);out;';
    await request(url)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(largeQuery))
      .expect(413);

    await app.close();
    await env.stop();
  });

  it('bypasses caching when transparentOnly is enabled', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    const { app } = await buildServer({
      configOverrides: {
        upstreamUrls,
        transparentOnly: true,
        tilePrecision: 5
      },
      redisClient
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}`;

    try {
      await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      const afterFirst = hits.length;
      expect(afterFirst).toBeGreaterThan(0);

      await request(url)
        .post('/api/interpreter')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formBody(jsonQuery))
        .expect(200);

      expect(hits.length).toBeGreaterThan(afterFirst);
    } finally {
      await app.close();
      hits.splice(0, hits.length);
    }
  });

  it('fills missing tiles with minimal upstream requests', async () => {
    await redisClient?.flushall();
    hits.splice(0, hits.length);

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const bbox = extractBoundingBox(jsonQuery);
    expect(bbox).toBeDefined();
    const allTiles = tilesForBoundingBox(bbox!, 5);
    expect(allTiles.length).toBeGreaterThanOrEqual(2);

    const missingTiles = [allTiles[0], allTiles[1]].filter(Boolean);
    expect(missingTiles).toHaveLength(2);

    const amenityKey = 'toilets';
    if (redisClient) {
      await redisClient.del(...missingTiles.map((tile) => tileKey(tile.hash, amenityKey)));
    }

    const hitsBefore = hits.length;

    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery))
      .expect(200);

    const newHits = hits.slice(hitsBefore);
    expect(newHits.length).toBeGreaterThan(0);
    expect(newHits.length).toBeLessThanOrEqual(missingTiles.length);

    const parseHit = (hit: string) => {
      const [bboxPart] = hit.split(':');
      const [south, west, north, east] = bboxPart.split(',').map((value) => Number(value));
      return { south, west, north, east };
    };

    for (const tile of missingTiles) {
      const key = tileKey(tile.hash, amenityKey);
      const value = redisClient ? await redisClient.get(key) : null;
      expect(value).toBeTruthy();
    }

    const parsedHits = newHits.map(parseHit);
    for (const hit of parsedHits) {
      expect(hit.north - hit.south).toBeLessThanOrEqual(bbox!.north - bbox!.south);
      expect(hit.east - hit.west).toBeLessThanOrEqual(bbox!.east - bbox!.west);
    }
  });
});

describe('validation', () => {
  it('proxies queries without amenity filter', async () => {
    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody('[out:json];node(1,1,2,2);out;'))
      .expect(200);
  });

  it('proxies non-json queries', async () => {
    await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody('[out:xml];node["amenity"](1,1,2,2);out;'))
      .expect(200);
  });
});
