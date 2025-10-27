import type { Redis } from 'ioredis';

import type { BoundingBox } from './bbox.js';
import type { TileInfo } from './tiling.js';
import { tileKey } from './tiling.js';

export interface CachedTile {
  tile: TileInfo;
  payload: OverpassTilePayload;
  stale: boolean;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: Array<{ type: 'node' | 'way' | 'relation'; ref: number; role: string }>;
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: Record<string, unknown>;
  elements: OverpassElement[];
}

export interface OverpassTilePayload {
  response: OverpassResponse;
  fetchedAt: number;
  expiresAt: number;
}

export interface TileStoreOptions {
  ttlSeconds: number;
  swrSeconds: number;
}

export class TileStore {
  constructor(private readonly redis: Redis, private readonly options: TileStoreOptions) {}

  public async readTiles(tiles: TileInfo[]): Promise<Map<string, CachedTile>> {
    const keys = tiles.map((tile) => tileKey(tile.hash));
    const values = await this.redis.mget(keys);
    const now = Date.now();

    const result = new Map<string, CachedTile>();

    tiles.forEach((tile, index) => {
      const value = values[index];
      if (!value) {
        return;
      }

      try {
        const payload = JSON.parse(value) as OverpassTilePayload;
        const stale = payload.expiresAt < now;
        result.set(tile.hash, { tile, payload, stale });
      } catch {
        result.delete(tile.hash);
      }
    });

    return result;
  }

  public async writeTile(tile: TileInfo, response: OverpassResponse): Promise<void> {
    const now = Date.now();
    const payload: OverpassTilePayload = {
      response,
      fetchedAt: now,
      expiresAt: now + this.options.ttlSeconds * 1000
    };

    await this.redis.set(tileKey(tile.hash), JSON.stringify(payload), 'PX', (this.options.ttlSeconds + this.options.swrSeconds) * 1000);
  }

  public async withRefreshLock(tile: TileInfo, handler: () => Promise<void>): Promise<void> {
    const lockKey = `${tileKey(tile.hash)}:lock`;
    const acquired = await this.redis.set(lockKey, '1', 'PX', this.options.swrSeconds * 1000, 'NX');
    if (!acquired) {
      return;
    }

    try {
      await handler();
    } finally {
      await this.redis.del(lockKey);
    }
  }
}

export const filterElementsByBbox = (elements: OverpassElement[], bbox: BoundingBox): OverpassElement[] => {
  return elements.filter((element) => {
    if (element.type === 'node') {
      if (typeof element.lat !== 'number' || typeof element.lon !== 'number') {
        return false;
      }

      return (
        element.lat >= bbox.south &&
        element.lat <= bbox.north &&
        element.lon >= bbox.west &&
        element.lon <= bbox.east
      );
    }

    return true;
  });
};
