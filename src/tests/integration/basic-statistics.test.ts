import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import { RequestStatistics } from '../../stats.js';
import { TileStore } from '../../store.js';
import { createTestEnvironment } from './testcontainers.js';

const query = '[out:json];node["amenity"="toilets"](52.5,13.3,52.6,13.4);out;';

describe('basic statistics without detailed statistics', () => {
  let env: Awaited<ReturnType<typeof createTestEnvironment>>;

  // Container startup/teardown has its own budget. Keep assertions under the
  // normal test timeout so slow application behavior still fails promptly.
  beforeEach(async () => {
    env = await createTestEnvironment();
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await env?.stop();
  }, 60_000);

  it('reuses cache inventory, counts responses, and avoids statistics initialization and polling I/O', async () => {
    const createStatistics = vi.spyOn(RequestStatistics, 'create');
    const refreshMetrics = vi.spyOn(TileStore.prototype, 'refreshMetrics');
    const options = {
      redisClient: env.redis,
      statisticsWorker: true,
      configOverrides: { statisticsEnabled: false, upstreamUrls: env.upstreamUrls }
    };
    const first = await buildServer(options);
    try {
      expect(createStatistics).not.toHaveBeenCalled();
      expect(refreshMetrics).not.toHaveBeenCalled();
      const response = await first.app.inject({ method: 'GET', url: `/api/interpreter?data=${encodeURIComponent(query)}` });
      expect(response.statusCode).toBe(200);
      await first.app.inject({ method: 'GET', url: '/api/interpreter' });
      const snapshot = (await first.app.inject('/api/statistics')).json();
      expect(snapshot).toMatchObject({ mode: 'basic', totalRequests: 2, clientErrors: 1, serverErrors: 0 });
      expect(snapshot.totalCachedTiles).toBeGreaterThan(0);
      expect(snapshot.cachedAmenities).toBeGreaterThan(0);
      expect(snapshot.cachedAmenityTypes).toBe(1);
      expect(snapshot.cacheHitRate).toBe(Number(((snapshot.cacheStatus.HIT / snapshot.totalRequests) * 100).toFixed(2)));
      expect(snapshot.generatedAt).toEqual(expect.any(String));
      for (const unavailable of [
        'totalUniqueClients', 'totalRequestsDay', 'totalRequestsWeek', 'totalRequestsMonth',
        'totalTilesRequested', 'totalStaleTiles', 'averageTilesPerRequest',
        'hotspots', 'amenities', 'upstreams', 'staleRefreshQueue', 'cacheCoverage'
      ]) expect(snapshot).not.toHaveProperty(unavailable);
      expect(snapshot.cacheStatus[response.headers['x-cache'] as string]).toBe(1);
      const scan = vi.spyOn(env.redis, 'scan');
      const get = vi.spyOn(env.redis, 'get');
      const polled = (await first.app.inject('/api/statistics')).json();
      expect(polled.totalRequests).toBe(2);
      expect(scan).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      scan.mockRestore();
      get.mockRestore();
      await first.app.close();

      const second = await buildServer(options);
      try {
        const restored = (await second.app.inject('/api/statistics')).json();
        expect(restored.totalRequests).toBe(0);
        expect(restored.totalCachedTiles).toBe(snapshot.totalCachedTiles);
        const warm = await second.app.inject({ method: 'GET', url: `/api/interpreter?data=${encodeURIComponent(query)}` });
        expect(warm.statusCode).toBe(200);
        const warmStats = (await second.app.inject('/api/statistics')).json();
        expect(warmStats.totalRequests).toBe(1);
        expect(warmStats.cacheStatus.HIT).toBe(1);
      } finally {
        await second.app.close();
      }
    } finally {
      await first.app.close();
    }
  });

  it('continues deferred stale refreshes without a statistics worker', async () => {
    const { app } = await buildServer({
      redisClient: env.redis,
      configOverrides: {
        statisticsEnabled: false, upstreamUrls: env.upstreamUrls,
        cacheTtlSeconds: 1, swrSeconds: 30, serveStaleFromCache: true
      }
    });
    try {
      const fetch = () => app.inject({ method: 'GET', url: `/api/interpreter?data=${encodeURIComponent(query)}` });
      expect((await fetch()).statusCode).toBe(200);
      const initialHits = env.hits.length;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const stale = await fetch();
      expect(stale.statusCode).toBe(200);
      expect(stale.headers['x-cache']).toBe('STALE');
      await vi.waitFor(() => expect(env.hits.length).toBeGreaterThan(initialHits));
      await vi.waitFor(async () => {
        expect((await fetch()).headers['x-cache']).toBe('HIT');
      });
      expect((await app.inject('/api/statistics')).json().cacheStatus.STALE).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
