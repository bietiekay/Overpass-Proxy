import { beforeEach, describe, expect, it } from 'vitest';

import type Redis from 'ioredis';

import { TileStore } from '../../store.js';
import type { TileInfo } from '../../tiling.js';
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
});
