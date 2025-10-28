import { describe, expect, it } from 'vitest';

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
});
