import type Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractBoundingBox } from '../../bbox.js';
import { buildServer } from '../../index.js';
import { tileKey, tilesForBoundingBox } from '../../tiling.js';
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

beforeAll(async () => {
  const env = await createTestEnvironment();
  stopEnv = env.stop;
  hits = env.hits;
  redisClient = env.redis;

  await redisClient.flushall();

  const { app } = buildServer({
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

    const { app } = buildServer({
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
