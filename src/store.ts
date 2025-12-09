import type { Redis } from 'ioredis';

import type { BoundingBox } from './bbox.js';
import { logger } from './logger.js';
import type { TileInfo } from './tiling.js';
import { tileKey } from './tiling.js';

type PresenceState = 'present' | 'missing';

interface PresenceEntry {
  state: PresenceState;
  expiresAt: number;
  amenityCount: number;
  stale: boolean;
}

export interface CacheCoverageEntry {
  geohash: string;
  entries: number;
  amenityItems: number;
  staleEntries: number;
  staleAmenityItems: number;
}

type PresenceListener = () => void;

class TilePresenceCache {
  private readonly entries = new Map<string, Map<string, PresenceEntry>>();

  private readonly listeners = new Map<string, Set<PresenceListener>>();

  constructor(private readonly defaultMissingTtlMs: number) {}

  private getAmenityEntries(amenity: string): Map<string, PresenceEntry> {
    let amenityEntries = this.entries.get(amenity);
    if (!amenityEntries) {
      amenityEntries = new Map();
      this.entries.set(amenity, amenityEntries);
    }
    return amenityEntries;
  }

  private fullKey(amenity: string, tileHash: string): string {
    return `${amenity}:${tileHash}`;
  }

  private clearIfExpired(
    amenity: string,
    tileHash: string,
    entry: PresenceEntry | undefined
  ): PresenceEntry | undefined {
    if (!entry) {
      return undefined;
    }
    const now = Date.now();
    if (entry.expiresAt > now) {
      return entry;
    }
    if (entry.state === 'present') {
      entry.stale = true;
      entry.expiresAt = Number.POSITIVE_INFINITY;
      return entry;
    }
    const amenityEntries = this.entries.get(amenity);
    amenityEntries?.delete(tileHash);
    if (amenityEntries && amenityEntries.size === 0) {
      this.entries.delete(amenity);
    }
    return undefined;
  }

  public markPresent(
    amenity: string,
    tileHash: string,
    expiresAt: number,
    amenityCount: number,
    stale = false
  ): void {
    const entry: PresenceEntry = { state: 'present', expiresAt, amenityCount, stale };
    this.getAmenityEntries(amenity).set(tileHash, entry);
    this.notify(amenity, tileHash);
  }

  public markMissing(amenity: string, tileHash: string, ttlMs?: number): void {
    const duration = Math.max(1, Math.floor(ttlMs ?? this.defaultMissingTtlMs));
    const entry: PresenceEntry = {
      state: 'missing',
      expiresAt: Date.now() + duration,
      amenityCount: 0,
      stale: false
    };
    this.getAmenityEntries(amenity).set(tileHash, entry);
  }

  public get(amenity: string, tileHash: string): PresenceEntry | undefined {
    const amenityEntries = this.entries.get(amenity);
    if (!amenityEntries) {
      return undefined;
    }
    const entry = amenityEntries.get(tileHash);
    return this.clearIfExpired(amenity, tileHash, entry);
  }

  public countPresent(amenity: string): number {
    const amenityEntries = this.entries.get(amenity);
    if (!amenityEntries) {
      return 0;
    }

    let count = 0;
    for (const [tileHash, entry] of amenityEntries) {
      const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state === 'present') {
          count += 1;
        }
    }

    if (count === 0 && amenityEntries.size === 0) {
      this.entries.delete(amenity);
    }

    return count;
  }

  public countPresentAmenities(): number {
    let amenitiesWithCache = 0;

    for (const [amenity, entries] of this.entries) {
      let hasPresent = false;

      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state === 'present') {
          hasPresent = true;
          break;
        }
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }

      if (hasPresent) {
        amenitiesWithCache += 1;
      }
    }

    return amenitiesWithCache;
  }

  public countAllPresent(): number {
    let total = 0;

    for (const [amenity, entries] of this.entries) {
      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state === 'present') {
          total += 1;
        }
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }
    }

    return total;
  }

  public countAmenityItems(): number {
    let total = 0;

    for (const [amenity, entries] of this.entries) {
      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state === 'present') {
          total += current.amenityCount;
        }
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }
    }

    return total;
  }

  private addListener(key: string, listener: PresenceListener): void {
    const existing = this.listeners.get(key);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(key, new Set([listener]));
    }
  }

  private removeListener(key: string, listener: PresenceListener): void {
    const existing = this.listeners.get(key);
    if (!existing) {
      return;
    }
    existing.delete(listener);
    if (existing.size === 0) {
      this.listeners.delete(key);
    }
  }

  private notify(amenity: string, tileHash: string): void {
    const key = this.fullKey(amenity, tileHash);
    const listeners = this.listeners.get(key);
    if (!listeners) {
      return;
    }
    this.listeners.delete(key);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    }
  }

  public waitForPresent(amenity: string, tileHash: string, timeoutMs: number): Promise<void> {
    const existing = this.get(amenity, tileHash);
    if (existing?.state === 'present') {
      return Promise.resolve();
    }

    const waitDuration = Math.max(0, Math.floor(timeoutMs));
    const key = this.fullKey(amenity, tileHash);

    return new Promise((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const complete = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        this.removeListener(key, complete);
        resolve();
      };

      if (waitDuration > 0) {
        timeout = setTimeout(complete, waitDuration);
      }

      this.addListener(key, complete);
      const current = this.get(amenity, tileHash);
      if (current?.state === 'present') {
        complete();
      }
    });
  }

  public getDefaultMissingTtl(): number {
    return this.defaultMissingTtlMs;
  }

  public getCoverage(): CacheCoverageEntry[] {
    const coverage = new Map<string, CacheCoverageEntry>();

    for (const [amenity, entries] of this.entries) {
      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state !== 'present') {
          continue;
        }

        const existing =
          coverage.get(tileHash) ??
          ({ geohash: tileHash, entries: 0, amenityItems: 0, staleEntries: 0, staleAmenityItems: 0 } as CacheCoverageEntry);

        if (current.stale) {
          existing.staleEntries += 1;
          existing.staleAmenityItems += current.amenityCount;
        } else {
          existing.entries += 1;
          existing.amenityItems += current.amenityCount;
        }

        coverage.set(tileHash, existing);
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }
    }

    return [...coverage.values()];
  }
}

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

const countAmenitiesInResponse = (response: OverpassResponse): number =>
  response.elements.filter((element) => Boolean(element.tags?.amenity)).length;

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
  private readonly presence: TilePresenceCache;

  constructor(private readonly redis: Redis, private readonly options: TileStoreOptions) {
    const missingTtl = Math.max(250, Math.min(2000, options.swrSeconds * 1000));
    this.presence = new TilePresenceCache(missingTtl);
  }

  public async restorePresence(): Promise<void> {
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'tile:*', 'COUNT', 100);
      await this.restoreTileKeys(keys);
      cursor = nextCursor;
    } while (cursor !== '0');
  }

  private async restoreTileKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    const values = await this.redis.mget(keys);

    keys.forEach((key, index) => {
      const parsed = this.parseTileKey(key);
      const raw = values[index];

      if (!parsed || !raw) {
        return;
      }

      try {
        const payload = JSON.parse(raw) as OverpassTilePayload;
        const amenityCount = countAmenitiesInResponse(payload.response);
        const isStale = payload.expiresAt < Date.now();
        this.presence.markPresent(parsed.amenity, parsed.hash, payload.expiresAt, amenityCount, isStale);
      } catch (error) {
        logger.warn({ err: error, key }, 'failed to restore tile presence from redis');
      }
    });
  }

  private parseTileKey(key: string): { amenity: string; hash: string } | null {
    if (!key.startsWith('tile:')) {
      return null;
    }

    const [, amenity, ...hashParts] = key.split(':');
    if (!amenity || hashParts.length === 0) {
      return null;
    }

    return { amenity, hash: hashParts.join(':') };
  }

  public countCachedTiles(amenity: string): number {
    const amenitySuffix = amenityKey(amenity);
    return this.presence.countPresent(amenitySuffix);
  }

  public countCachedAmenities(): number {
    return this.presence.countAmenityItems();
  }

  public countCachedAmenityTypes(): number {
    return this.presence.countPresentAmenities();
  }

  public countTotalCachedTiles(): number {
    return this.presence.countAllPresent();
  }

  public getCacheCoverage(): CacheCoverageEntry[] {
    return this.presence.getCoverage();
  }

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
        this.presence.markMissing(amenitySuffix, tile.hash);
        return;
      }

      try {
        const payload = JSON.parse(value) as OverpassTilePayload;
        const stale = payload.expiresAt < now;
        const amenityCount = countAmenitiesInResponse(payload.response);
        result.set(tile.hash, { tile, payload, stale });
        this.presence.markPresent(amenitySuffix, tile.hash, payload.expiresAt, amenityCount, stale);
        hits += 1;
        if (stale) {
          staleCount += 1;
        }
      } catch {
        result.delete(tile.hash);
        misses += 1;
        this.presence.markMissing(amenitySuffix, tile.hash);
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
    const amenitySuffix = amenityKey(amenity);
    const pipeline = this.redis.pipeline();
    const tileHashes: string[] = [];
    const entriesWithPayload: Array<{ tile: TileInfo; payload: OverpassTilePayload; amenityCount: number }> = [];

    for (const { tile, response } of entries) {
      const payload: OverpassTilePayload = {
        response,
        fetchedAt: now,
        expiresAt: now + this.options.ttlSeconds * 1000
      };
      const amenityCount = countAmenitiesInResponse(response);
      tileHashes.push(tile.hash);
      pipeline.set(tileKey(tile.hash, amenitySuffix), JSON.stringify(payload));
      entriesWithPayload.push({ tile, payload, amenityCount });
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

    for (const { tile, payload, amenityCount } of entriesWithPayload) {
      this.presence.markPresent(amenitySuffix, tile.hash, payload.expiresAt, amenityCount);
    }

    logger.info(logContext, 'redis tile write');
  }

  public async readTile(tile: TileInfo, amenity: string): Promise<CachedTile | undefined> {
    const amenitySuffix = amenityKey(amenity);
    const known = this.presence.get(amenitySuffix, tile.hash);
    if (known?.state === 'missing') {
      return undefined;
    }

    const key = tileKey(tile.hash, amenitySuffix);
    const value = await this.redis.get(key);
    if (!value) {
      this.presence.markMissing(amenitySuffix, tile.hash);
      return undefined;
    }
    try {
      const payload = JSON.parse(value) as OverpassTilePayload;
      const amenityCount = countAmenitiesInResponse(payload.response);
      const now = Date.now();
      const stale = payload.expiresAt < now;
      this.presence.markPresent(amenitySuffix, tile.hash, payload.expiresAt, amenityCount, stale);
      return { tile, payload, stale };
    } catch {
      this.presence.markMissing(amenitySuffix, tile.hash);
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
      const existing = await this.readTile(tile, amenity);
      if (existing) {
        return 'waited';
      }

      const ttl = await this.redis.pttl(inflightKey);
      const waitDuration = ttl > 0 ? Math.max(ttl, 1) : Math.min(ttlMs, this.presence.getDefaultMissingTtl());
      await this.presence.waitForPresent(keyAmenity, tile.hash, waitDuration);
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
