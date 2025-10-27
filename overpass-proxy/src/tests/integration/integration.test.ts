import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../index.js';
import { createTestEnvironment } from './testcontainers.js';

const jsonQuery = '[out:json];node(52.5,13.3,52.6,13.4);out;';
const formBody = (query: string) => new URLSearchParams({ data: query }).toString();

let stopEnv: (() => Promise<void>) | undefined;
let baseUrl: string;
let hits: string[];
let closeMain: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const env = await createTestEnvironment();
  stopEnv = env.stop;
  hits = env.hits;

  await env.redis.flushall();

  const { app } = buildServer({
    configOverrides: {
      upstreamUrl: env.upstreamUrl,
      cacheTtlSeconds: 1,
      swrSeconds: 1,
      transparentOnly: false,
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
  it('proxies non-json requests transparently', async () => {
    const response = await request(baseUrl)
      .get('/api/interpreter')
      .query({ data: '[out:xml];node(1,2,3,4);out;' })
      .expect(200);

    expect(response.text).toContain('ok');
  });

  it('caches json bbox requests', async () => {
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

  it('returns 304 when etag matches', async () => {
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

  it('respects TRANSPARENT_ONLY flag', async () => {
    const env = await createTestEnvironment();
    await env.redis.flushall();

    const { app } = buildServer({
      configOverrides: {
        upstreamUrl: env.upstreamUrl,
        transparentOnly: true
      },
      redisClient: env.redis
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const query = '[out:json];node(1,1,2,2);out;';
    env.hits.splice(0, env.hits.length);

    await request(url)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(query))
      .expect(200);

    await request(url)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(query))
      .expect(200);

    expect(env.hits.length).toBeGreaterThanOrEqual(2);

    await app.close();
    await env.stop();
  });

  it('enforces MAX_TILES_PER_REQUEST', async () => {
    const env = await createTestEnvironment();
    await env.redis.flushall();

    const { app } = buildServer({
      configOverrides: {
        upstreamUrl: env.upstreamUrl,
        maxTilesPerRequest: 4,
        tilePrecision: 5
      },
      redisClient: env.redis
    });

    await app.ready();
    await app.listen({ port: 0 });
    const address = app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const largeQuery = '[out:json];node(0,0,10,10);out;';
    await request(url)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(largeQuery))
      .expect(413);

    await app.close();
    await env.stop();
  });
});
