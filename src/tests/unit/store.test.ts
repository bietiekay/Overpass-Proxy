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

  it('writes multiple tiles via pipeline', async () => {
    const store = new TileStore(redis as unknown as Redis, { ttlSeconds: 60, swrSeconds: 30 });
    const otherTile: TileInfo = {
      hash: 'u33dc0v',
      bounds: { south: 0, west: 1, north: 1, east: 2 }
    };

    await store.writeTiles(
      [
        { tile, response: { elements: [], generator: 'a', osm3s: {}, version: 0.6 } },
        { tile: otherTile, response: { elements: [], generator: 'b', osm3s: {}, version: 0.6 } }
      ],
      'toilets'
    );

    const values = await store.readTiles([tile, otherTile], 'toilets');
    expect(values.get(tile.hash)?.payload.response.generator).toBe('a');
    expect(values.get(otherTile.hash)?.payload.response.generator).toBe('b');
  });
});
