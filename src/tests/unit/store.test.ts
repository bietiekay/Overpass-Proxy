import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('writes and reads tiles', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    await store.writeTile(tile, { elements: [], generator: 'test', osm3s: {}, version: 0.6 }, 'toilets');
    const values = await store.readTiles([tile], 'toilets');
    expect(values.get(tile.hash)?.payload.response.generator).toBe('test');
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
      await store.writeTile(tile, { elements: [], generator: 'test', osm3s: {}, version: 0.6 }, 'toilets');

      const key = tileKey(tile.hash, 'toilets');
      expect(await redis.pttl(key)).toBe(-1);

      vi.setSystemTime(new Date(Date.now() + 5_000));

      const values = await store.readTiles([tile], 'toilets');
      expect(values.get(tile.hash)?.stale).toBe(true);
      expect(await redis.pttl(key)).toBe(-1);
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
