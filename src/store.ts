import type { Redis } from 'ioredis';

import type { BoundingBox } from './bbox.js';
import { logger } from './logger.js';
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

const amenityKey = (amenity: string): string => amenity.trim().toLowerCase();

export class TileStore {
  constructor(private readonly redis: Redis, private readonly options: TileStoreOptions) {}

  public async readTiles(tiles: TileInfo[], amenity: string): Promise<Map<string, CachedTile>> {
    const amenitySuffix = amenityKey(amenity);
    const keys = tiles.map((tile) => tileKey(tile.hash, amenitySuffix));
    const values = await this.redis.mget(keys);
    const now = Date.now();

    const result = new Map<string, CachedTile>();

    let hits = 0;
    let misses = 0;
    let staleCount = 0;

    tiles.forEach((tile, index) => {
      const value = values[index];
      if (!value) {
        misses += 1;
        return;
      }

      try {
        const payload = JSON.parse(value) as OverpassTilePayload;
        const stale = payload.expiresAt < now;
        result.set(tile.hash, { tile, payload, stale });
        hits += 1;
        if (stale) {
          staleCount += 1;
        }
      } catch {
        result.delete(tile.hash);
        misses += 1;
      }
    });

    logger.info(
      {
        tiles: tiles.map((t) => t.hash),
        hits,
        misses,
        stale: staleCount,
        amenity: amenitySuffix
      },
      'redis tile read'
    );

    return result;
  }

  public async writeTile(tile: TileInfo, response: OverpassResponse, amenity: string): Promise<void> {
    await this.writeTiles([{ tile, response }], amenity);
  }

  public async writeTiles(
    entries: Array<{ tile: TileInfo; response: OverpassResponse }>,
    amenity: string
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const now = Date.now();
    const expiryMs = (this.options.ttlSeconds + this.options.swrSeconds) * 1000;
    const amenitySuffix = amenityKey(amenity);
    const pipeline = this.redis.pipeline();
    const tileHashes: string[] = [];

    for (const { tile, response } of entries) {
      const payload: OverpassTilePayload = {
        response,
        fetchedAt: now,
        expiresAt: now + this.options.ttlSeconds * 1000
      };
      tileHashes.push(tile.hash);
      pipeline.set(tileKey(tile.hash, amenitySuffix), JSON.stringify(payload), 'PX', expiryMs);
    }

    const results = await pipeline.exec();
    for (const [error] of results ?? []) {
      if (error) {
        throw error;
      }
    }

    const logContext: Record<string, unknown> = {
      tiles: tileHashes,
      count: tileHashes.length,
      expiresAt: now + this.options.ttlSeconds * 1000,
      ttlSeconds: this.options.ttlSeconds,
      swrSeconds: this.options.swrSeconds,
      amenity: amenitySuffix
    };

    if (tileHashes.length === 1) {
      logContext.tile = tileHashes[0];
    }

    logger.info(logContext, 'redis tile write');
  }

  public async readTile(tile: TileInfo, amenity: string): Promise<CachedTile | undefined> {
    const key = tileKey(tile.hash, amenityKey(amenity));
    const value = await this.redis.get(key);
    if (!value) {
      return undefined;
    }
    try {
      const payload = JSON.parse(value) as OverpassTilePayload;
      const stale = payload.expiresAt < Date.now();
      return { tile, payload, stale };
    } catch {
      return undefined;
    }
  }

  public async withRefreshLock(tile: TileInfo, amenity: string, handler: () => Promise<void>): Promise<void> {
    const keyAmenity = amenityKey(amenity);
    const lockKey = `${tileKey(tile.hash, keyAmenity)}:lock`;
    const acquired = await this.redis.set(lockKey, '1', 'PX', this.options.swrSeconds * 1000, 'NX');
    if (!acquired) {
      logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock skipped');
      return;
    }

    logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock acquired');
    try {
      await handler();
    } finally {
      await this.redis.del(lockKey);
      logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock released');
    }
  }

  public async withMissLock(
    tile: TileInfo,
    amenity: string,
    handler: () => Promise<void>,
    ttlMs = 10000
  ): Promise<'fetched' | 'waited'> {
    const keyAmenity = amenityKey(amenity);
    const inflightKey = `${tileKey(tile.hash, keyAmenity)}:inflight`;
    const acquired = await this.redis.set(inflightKey, '1', 'PX', ttlMs, 'NX');
    if (!acquired) {
      // Another request is fetching this tile. Wait briefly for the tile to appear.
      const deadline = Date.now() + ttlMs;
      // simple poll loop with backoff
      let delay = 50;
      while (Date.now() < deadline) {
        const existing = await this.readTile(tile, amenity);
        if (existing) {
          return 'waited';
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 400);
      }
      return 'waited';
    }

    try {
      await handler();
      return 'fetched';
    } finally {
      await this.redis.del(inflightKey);
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
