import { beforeEach, describe, expect, it, vi } from 'vitest';
import ngeohash from 'ngeohash';

import type Redis from 'ioredis';

import { TileStore } from '../../store.js';
import { logger } from '../../logger.js';
import type { TileInfo } from '../../tiling.js';
import { tileKey } from '../../tiling.js';
import { InMemoryRedis } from '../helpers/inMemoryRedis.js';

const redis = new InMemoryRedis();

const tile: TileInfo = {
  hash: 'u33dc0r',
  bounds: { south: 0, west: 0, north: 1, east: 1 }
};

describe('TileStore', () => {
  beforeEach(async () => {
    await redis.flushall();
  });

  it('aggregates Redis metadata without retaining a second presence index', async () => {
    const writer = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const metrics = new TileStore(redis as unknown as Redis, {
      ttlSeconds: 60, swrSeconds: 30, metricsOnly: true, metricsRefreshIntervalMs: 0
    });
    const response = { elements: [{ type: 'node' as const, id: 1, tags: { amenity: 'toilets' } }] };
    await writer.writeTile(tile, response, 'toilets');
    await metrics.restorePresence();
    await metrics.refreshMetrics();
    expect(metrics.countTotalCachedTiles()).toBe(1);
    expect(metrics.countCachedTiles('toilets')).toBe(1);
    expect(metrics.countCachedAmenities()).toBe(1);
    expect(metrics.countCachedAmenityTypes()).toBe(1);
    expect(metrics.getCacheCoverage()).toEqual(writer.getCacheCoverage());
    // Reads and worker refresh writes must not repopulate the disabled index.
    await metrics.readTile(tile, 'toilets');
    await metrics.writeTile({ ...tile, hash: 'u33dc0s' }, response, 'toilets');
    expect(metrics.getCacheCoverageForBounds({ bbox: tile.bounds, precision: 3 })).toEqual([]);
    const scan = vi.spyOn(redis, 'scan');
    await metrics.refreshMetrics();
    expect(metrics.countTotalCachedTiles()).toBe(2);
    scan.mockClear();
    await metrics.refreshMetrics();
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it('coalesces and throttles metadata scans while refreshing stale coverage periodically', async () => {
    vi.useFakeTimers();
    try {
      const writer = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
      const metrics = new TileStore(redis as unknown as Redis, {
        ttlSeconds: 60, swrSeconds: 30, metricsOnly: true
      });
      await writer.writeTile(tile, { elements: [] }, 'toilets');
      const scan = vi.spyOn(redis, 'scan');
      await Promise.all([metrics.refreshMetrics(), metrics.refreshMetrics()]);
      expect(scan).toHaveBeenCalledTimes(1);
      await writer.writeTile({ ...tile, hash: 'u33dc0s' }, { elements: [] }, 'toilets');
      await metrics.refreshMetrics();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(metrics.countTotalCachedTiles()).toBe(1);
      vi.advanceTimersByTime(30000);
      await metrics.refreshMetrics();
      expect(scan).toHaveBeenCalledTimes(2);
      expect(metrics.countTotalCachedTiles()).toBe(2);
      vi.advanceTimersByTime(5 * 60 * 1000);
      await metrics.refreshMetrics();
      expect(metrics.getCacheCoverage().reduce((sum, entry) => sum + entry.staleEntries, 0)).toBe(2);
      scan.mockRestore();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('writes and reads tiles', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    await store.writeTile(tile, { elements: [], generator: 'test', osm3s: {}, version: 0.6 }, 'toilets');
    const values = await store.readTiles([tile], 'toilets');
    expect(values.get(tile.hash)?.payload.response.generator).toBe('test');
  });

  it('bounds batched Redis reads and preserves mixed results across batch boundaries', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const tiles = Array.from({ length: 1201 }, (_, index): TileInfo => ({
      hash: `u33dc${index.toString(36).padStart(3, '0')}`,
      bounds: { south: 0, west: 0, north: 1, east: 1 }
    }));
    const now = Date.now();
    const response = {
      elements: [{ type: 'node' as const, id: 1, tags: { amenity: 'toilets' } }]
    };
    const expectedHashes: string[] = [];
    let expectedStale = 0;

    for (const [index, requestedTile] of tiles.entries()) {
      const kind = index % 4;
      if (kind === 0 || kind === 1) {
        const stale = kind === 1;
        await redis.set(
          tileKey(requestedTile.hash, 'toilets'),
          JSON.stringify({ response, fetchedAt: now - 1000, expiresAt: stale ? now - 1 : now + 60_000 })
        );
        expectedHashes.push(requestedTile.hash);
        if (stale) expectedStale += 1;
      } else if (kind === 2) {
        await redis.set(tileKey(requestedTile.hash, 'toilets'), 'malformed-json');
      }
    }

    const mget = vi.spyOn(redis, 'mget');
    const values = await store.readTiles(tiles, 'toilets');

    expect(mget).toHaveBeenCalledTimes(3);
    expect(mget.mock.calls.map(([keys]) => keys.length)).toEqual([500, 500, 201]);
    expect([...values.keys()]).toEqual(expectedHashes);
    expect([...values.values()].filter((value) => value.stale)).toHaveLength(expectedStale);
    expect(store.countTotalCachedTiles()).toBe(expectedHashes.length);
    expect(store.countCachedAmenities()).toBe(expectedHashes.length);
    const coverage = store.getCacheCoverage();
    expect(coverage.reduce((total, entry) => total + entry.staleEntries, 0)).toBe(expectedStale);
    expect(coverage.reduce((total, entry) => total + entry.entries, 0)).toBe(expectedHashes.length - expectedStale);
    mget.mockRestore();
  });

  it('keeps compact presence counts correct through stale expiry and invalidation', async () => {
    vi.useFakeTimers();
    try {
      const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 1, swrSeconds: 1 });
      const response = { elements: [{ type: 'node' as const, id: 1, tags: { amenity: 'toilets' } }] };
      await store.writeTile(tile, response, 'toilets');
      expect(store.countCachedAmenities()).toBe(1);
      vi.advanceTimersByTime(1_001);
      const coverage = store.getCacheCoverage();
      expect(coverage.reduce((total, item) => total + item.staleEntries, 0)).toBe(1);
      expect(store.countCachedTiles('toilets')).toBe(1);
      await store.invalidateTiles([tile]);
      expect(store.countCachedTiles('toilets')).toBe(0);
      expect(store.countCachedAmenities()).toBe(0);
      expect(store.countCachedAmenityTypes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves exact counts above the packed presence counter range', async () => {
    vi.useFakeTimers();
    try {
      const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 1, swrSeconds: 1 });
      const elements = Array.from({ length: 1300 }, (_, id) => ({
        type: 'node' as const,
        id,
        tags: { amenity: 'toilets' }
      }));
      await store.writeTile(tile, { elements }, 'toilets');
      expect(store.countCachedAmenities()).toBe(1300);
      vi.advanceTimersByTime(1001);
      expect(store.getCacheCoverage()[0]?.staleAmenityItems).toBe(1300);
      await store.invalidateTiles([tile]);
      expect(store.countCachedAmenities()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves counts for expiry timestamps outside the packed integer range', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 5_000_000_000, swrSeconds: 30 });
    const response = { elements: [{ type: 'node' as const, id: 1, tags: { amenity: 'toilets' } }] };
    await store.writeTile(tile, response, 'toilets');
    expect(store.countCachedTiles('toilets')).toBe(1);
    expect(store.countCachedAmenities()).toBe(1);
    expect(store.getCacheCoverage()[0]?.amenityItems).toBe(1);
  });

  it('sub-batches metadata restores when Redis SCAN returns more than its COUNT hint', async () => {
    const keys = Array.from(
      { length: 1101 },
      (_, index) => `tilemeta:toilets:u${index.toString(36).padStart(6, '0')}`
    );
    for (const key of keys) {
      await redis.set(key, JSON.stringify({ expiresAt: Date.now() + 60_000, amenityCount: 1 }));
    }
    const scan = vi.spyOn(redis, 'scan').mockResolvedValue(['0', keys]);
    const mget = vi.spyOn(redis, 'mget');
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });

    await store.restorePresence();

    expect(mget.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 101]);
    expect(store.countCachedTiles('toilets')).toBe(1101);
    scan.mockRestore();
    mget.mockRestore();
  });

  it('marks tiles as stale after ttl', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: -1, swrSeconds: 30 });
    await store.writeTile(tile, { elements: [], generator: 'test', osm3s: {}, version: 0.6 }, 'toilets');
    const values = await store.readTiles([tile], 'toilets');
    expect(values.get(tile.hash)?.stale).toBe(true);
  });

  it('retains cached tiles even after they become stale', async () => {
    vi.useFakeTimers();
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 1, swrSeconds: 1 });
    try {
      await store.writeTile(
        tile,
        {
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 0.5,
              lon: 0.5,
              tags: { amenity: 'toilets' }
            }
          ],
          generator: 'test',
          osm3s: {},
          version: 0.6
        },
        'toilets'
      );

      const key = tileKey(tile.hash, 'toilets');
      expect(await redis.pttl(key)).toBe(-1);

      vi.setSystemTime(new Date(Date.now() + 5_000));

      const values = await store.readTiles([tile], 'toilets');
      expect(values.get(tile.hash)?.stale).toBe(true);
      expect(await redis.pttl(key)).toBe(-1);
      expect(store.countCachedTiles('toilets')).toBe(1);
      expect(store.countCachedAmenityTypes()).toBe(1);
      expect(store.countCachedAmenities()).toBe(1);
      expect(store.countTotalCachedTiles()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes multiple tiles in a single pipeline', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const secondTile: TileInfo = {
      hash: 'u33dc0q',
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    };

    await store.writeTiles(
      [
        { tile, response: { elements: [], generator: 'bulk-one', osm3s: {}, version: 0.6 } },
        { tile: secondTile, response: { elements: [], generator: 'bulk-two', osm3s: {}, version: 0.6 } }
      ],
      'toilets'
    );

    const values = await store.readTiles([tile, secondTile], 'toilets');
    expect(values.get(tile.hash)?.payload.response.generator).toBe('bulk-one');
    expect(values.get(secondTile.hash)?.payload.response.generator).toBe('bulk-two');
  });

  it('counts cached tiles for an amenity', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const secondTile: TileInfo = {
      hash: 'u33dc0q',
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    };

    await store.writeTiles(
      [
        { tile, response: { elements: [], generator: 'first', osm3s: {}, version: 0.6 } },
        { tile: secondTile, response: { elements: [], generator: 'second', osm3s: {}, version: 0.6 } }
      ],
      'toilets'
    );

    expect(store.countCachedTiles('toilets')).toBe(2);
    expect(store.countCachedTiles('drinking_water')).toBe(0);
  });

  it('returns cache coverage scoped to bounds', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const secondTile: TileInfo = {
      hash: 'u0qj0d1',
      bounds: { south: 10, west: 10, north: 11, east: 11 }
    };

    await store.writeTiles(
      [
        { tile, response: { elements: [], generator: 'first', osm3s: {}, version: 0.6 } },
        { tile: secondTile, response: { elements: [], generator: 'second', osm3s: {}, version: 0.6 } }
      ],
      'toilets'
    );

    const precision = 5;
    const [south, west, north, east] = ngeohash.decode_bbox(tile.hash.slice(0, precision));
    const bbox = { south, west, north, east };

    const coverage = store.getCacheCoverageForBounds({ bbox, precision });
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.geohash).toBe(tile.hash.slice(0, precision));
  });

  it('restores presence information from redis', async () => {
    const firstStore = new TileStore(redis as unknown as Redis, {
      ttlSeconds: 60,
      swrSeconds: 30
    });

    await firstStore.writeTile(
      tile,
      {
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 0.5,
            lon: 0.5,
            tags: { amenity: 'toilets' }
          }
        ],
        generator: 'first',
        osm3s: {},
        version: 0.6
      },
      'toilets'
    );

    await firstStore.writeTile(
      { hash: 'u33dc0q', bounds: { south: 1, west: 1, north: 2, east: 2 } },
      {
        elements: [
          {
            type: 'node',
            id: 2,
            lat: 1.5,
            lon: 1.5,
            tags: { amenity: 'drinking_water' }
          }
        ],
        generator: 'second',
        osm3s: {},
        version: 0.6
      },
      'drinking_water'
    );

    const restoredStore = new TileStore(redis as unknown as Redis, {
      ttlSeconds: 60,
      swrSeconds: 30
    });

    await restoredStore.restorePresence();

    expect(restoredStore.countCachedTiles('toilets')).toBe(1);
    expect(restoredStore.countCachedTiles('drinking_water')).toBe(1);
    expect(restoredStore.countCachedAmenityTypes()).toBe(2);
    expect(restoredStore.countCachedAmenities()).toBe(2);
  });

  it('ignores lock and inflight keys when restoring presence', async () => {
    const store = new TileStore(redis as unknown as Redis, {
      ttlSeconds: 60,
      swrSeconds: 30
    });

    await store.writeTile(tile, { elements: [], generator: 'test', osm3s: {}, version: 0.6 }, 'toilets');

    await redis.set(`${tileKey(tile.hash, 'toilets')}:lock`, 'token');
    await redis.set(`${tileKey(tile.hash, 'toilets')}:inflight`, '1');

    const warnSpy = vi.spyOn(logger, 'warn');

    const restoredStore = new TileStore(redis as unknown as Redis, {
      ttlSeconds: 60,
      swrSeconds: 30
    });

    await restoredStore.restorePresence();

    expect(restoredStore.countCachedTiles('toilets')).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does not delete newer refresh locks when the token changes mid-refresh', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 1 });
    const lockKey = `${tileKey(tile.hash, 'toilets')}:lock`;

    await store.withRefreshLock(tile, 'toilets', async () => {
      await redis.del(lockKey);
      await redis.set(lockKey, 'new-token', 'PX', 1_000);
    });

    expect(await redis.get(lockKey)).toBe('new-token');
  });

  it('notifies miss-lock waiters immediately when the handler fails', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 1 });

    const failing = store.withMissLock(
      tile,
      'toilets',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('upstream failure');
      },
      200
    );

    const start = Date.now();
    const waiter = store.withMissLock(tile, 'toilets', async () => {}, 200);

    const [first, second] = await Promise.allSettled([failing, waiter]);
    const durationMs = Date.now() - start;

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect(second.value).toBe('waited');
    expect(durationMs).toBeLessThan(150);
  });
});
