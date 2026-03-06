import type { Redis } from 'ioredis';
import ngeohash from 'ngeohash';

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

const MIN_STATS_COVERAGE_GEOHASH_PRECISION = 3;

export interface CacheCoverageEntry {
  geohash: string;
  entries: number;
  amenityItems: number;
  staleEntries: number;
  staleAmenityItems: number;
}

export interface CacheCoverageOptions {
  maxEntries?: number;
}

export interface CacheCoverageBoundsOptions extends CacheCoverageOptions {
  bbox: BoundingBox;
  precision: number;
}

type PresenceListener = () => void;

export interface RestorePresenceProgress {
  batches: number;
  cursor: string;
  scannedKeys: number;
  restoredTiles: number;
  totalTiles?: number;
  progressPercent?: number;
}

const reduceCoverageGeohashPrecision = (geohash: string): string =>
  geohash.length > MIN_STATS_COVERAGE_GEOHASH_PRECISION ? geohash.slice(0, -1) : geohash;

const mergeCoverageEntry = (
  existing: CacheCoverageEntry | undefined,
  incoming: CacheCoverageEntry
): CacheCoverageEntry => {
  if (!existing) {
    return { ...incoming };
  }

  return {
    geohash: incoming.geohash,
    entries: existing.entries + incoming.entries,
    amenityItems: existing.amenityItems + incoming.amenityItems,
    staleEntries: existing.staleEntries + incoming.staleEntries,
    staleAmenityItems: existing.staleAmenityItems + incoming.staleAmenityItems
  };
};

const compactCoverageGeohashEntries = (
  coverage: Map<string, CacheCoverageEntry>,
  targetSize: number
): Map<string, CacheCoverageEntry> => {
  if (!Number.isFinite(targetSize) || targetSize <= 0 || coverage.size <= targetSize) {
    return coverage;
  }

  let current = coverage;

  while (current.size > targetSize) {
    const next = new Map<string, CacheCoverageEntry>();
    let changed = false;

    for (const entry of current.values()) {
      const targetGeohash = reduceCoverageGeohashPrecision(entry.geohash);
      const merged = mergeCoverageEntry(next.get(targetGeohash), { ...entry, geohash: targetGeohash });
      next.set(targetGeohash, merged);
      changed = changed || targetGeohash !== entry.geohash;
    }

    if (!changed) {
      break;
    }

    current = next;
  }

  return current;
};

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
    this.notify(amenity, tileHash);
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
      let timeout: ReturnType<typeof setTimeout> | undefined;

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

  public getCoverage(options: CacheCoverageOptions = {}): CacheCoverageEntry[] {
    const targetSize = Math.max(1, options.maxEntries ?? 50000);
    const compactionThreshold = !Number.isFinite(targetSize)
      ? Number.POSITIVE_INFINITY
      : Math.max(targetSize, Math.floor(targetSize * 1.2));

    let coverage = new Map<string, CacheCoverageEntry>();
    let processed = 0;

    for (const [amenity, entries] of this.entries) {
      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state !== 'present') {
          continue;
        }

        const base: CacheCoverageEntry = {
          geohash: tileHash,
          entries: current.stale ? 0 : 1,
          amenityItems: current.stale ? 0 : current.amenityCount,
          staleEntries: current.stale ? 1 : 0,
          staleAmenityItems: current.stale ? current.amenityCount : 0
        };

        coverage.set(tileHash, mergeCoverageEntry(coverage.get(tileHash), base));

        processed += 1;
        if (coverage.size > compactionThreshold && processed % 50 === 0) {
          coverage = compactCoverageGeohashEntries(coverage, targetSize);
        }
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }
    }

    coverage = compactCoverageGeohashEntries(coverage, targetSize);

    return [...coverage.values()];
  }

  public getCoverageForBounds(options: CacheCoverageBoundsOptions): CacheCoverageEntry[] {
    const targetSize = Math.max(1, options.maxEntries ?? 50000);
    const compactionThreshold = !Number.isFinite(targetSize)
      ? Number.POSITIVE_INFINITY
      : Math.max(targetSize, Math.floor(targetSize * 1.2));

    const prefixes = new Set(
      ngeohash.bboxes(
        options.bbox.south,
        options.bbox.west,
        options.bbox.north,
        options.bbox.east,
        options.precision
      )
    );

    if (prefixes.size === 0) {
      return [];
    }

    let coverage = new Map<string, CacheCoverageEntry>();
    let processed = 0;

    for (const [amenity, entries] of this.entries) {
      for (const [tileHash, entry] of entries) {
        const current = this.clearIfExpired(amenity, tileHash, entry);
        if (current?.state !== 'present') {
          continue;
        }

        const prefix = tileHash.slice(0, options.precision);
        if (!prefixes.has(prefix)) {
          continue;
        }

        const base: CacheCoverageEntry = {
          geohash: prefix,
          entries: current.stale ? 0 : 1,
          amenityItems: current.stale ? 0 : current.amenityCount,
          staleEntries: current.stale ? 1 : 0,
          staleAmenityItems: current.stale ? current.amenityCount : 0
        };

        coverage.set(prefix, mergeCoverageEntry(coverage.get(prefix), base));

        processed += 1;
        if (coverage.size > compactionThreshold && processed % 50 === 0) {
          coverage = compactCoverageGeohashEntries(coverage, targetSize);
        }
      }

      if (entries.size === 0) {
        this.entries.delete(amenity);
      }
    }

    coverage = compactCoverageGeohashEntries(coverage, targetSize);

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

interface TileMetadataPayload {
  expiresAt: number;
  amenityCount: number;
}

export interface InvalidateResult {
  deletedKeys: number;
  matchedKeys: number;
  tileHashes: number;
  affectedAmenities: string[];
}

export interface TileStoreOptions {
  ttlSeconds: number;
  swrSeconds: number;
}

const amenityKey = (amenity: string): string => amenity.trim().toLowerCase();
const TILE_COUNT_KEY = 'metadata:tile_count';
export const CACHE_COVERAGE_REVISION_KEY = 'statistics:cacheCoverageRevision';
const TILE_META_PREFIX = 'tilemeta';
const tileMetaKey = (tileHash: string, amenity: string): string =>
  `${TILE_META_PREFIX}:${amenity}:${tileHash}`;

export class TileStore {
  private readonly presence: TilePresenceCache;

  constructor(private readonly redis: Redis, private readonly options: TileStoreOptions) {
    const missingTtl = Math.max(250, Math.min(2000, options.swrSeconds * 1000));
    this.presence = new TilePresenceCache(missingTtl);
  }

  public async restorePresence(onProgress?: (progress: RestorePresenceProgress) => void): Promise<void> {
    const metadataRestore = await this.restorePresenceFromMetadata(onProgress);
    if (metadataRestore.sawMetadata) {
      if (
        metadataRestore.totalTiles !== undefined &&
        metadataRestore.restoredTiles < metadataRestore.totalTiles
      ) {
        logger.info(
          {
            restoredTiles: metadataRestore.restoredTiles,
            totalTiles: metadataRestore.totalTiles
          },
          'tile metadata incomplete, falling back to payload restore'
        );
      } else {
        return;
      }
    }

    let cursor = '0';
    let batches = 0;
    let scannedKeys = 0;
    let restoredTiles = 0;
    const storedTotal = await this.redis.get(TILE_COUNT_KEY);
    const totalTiles = storedTotal && Number.isFinite(Number(storedTotal)) ? Number(storedTotal) : undefined;

    const reportProgress = () => {
      if (!onProgress) {
        return;
      }

      const progressPercent = totalTiles
        ? Math.min(100, Math.round((scannedKeys / totalTiles) * 10000) / 100)
        : cursor === '0'
          ? 100
          : 0;

      onProgress({
        batches,
        cursor,
        scannedKeys,
        restoredTiles,
        totalTiles,
        progressPercent
      });
    };

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'tile:*', 'COUNT', 100);
      batches += 1;
      scannedKeys += keys.length;
      restoredTiles += await this.restoreTileKeys(keys);
      cursor = nextCursor;
      if (batches === 1 || cursor === '0' || batches % 10 === 0) {
        reportProgress();
      }
    } while (cursor !== '0');

    await this.redis.set(TILE_COUNT_KEY, String(scannedKeys));
  }

  private async restorePresenceFromMetadata(
    onProgress?: (progress: RestorePresenceProgress) => void
  ): Promise<{ sawMetadata: boolean; restoredTiles: number; totalTiles?: number }> {
    let cursor = '0';
    let batches = 0;
    let scannedKeys = 0;
    let restoredTiles = 0;
    const storedTotal = await this.redis.get(TILE_COUNT_KEY);
    const totalTiles = storedTotal && Number.isFinite(Number(storedTotal)) ? Number(storedTotal) : undefined;
    let sawMetadata = false;

    const reportProgress = () => {
      if (!onProgress) {
        return;
      }

      const progressPercent = totalTiles
        ? Math.min(100, Math.round((scannedKeys / totalTiles) * 10000) / 100)
        : cursor === '0'
          ? 100
          : 0;

      onProgress({
        batches,
        cursor,
        scannedKeys,
        restoredTiles,
        totalTiles,
        progressPercent
      });
    };

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${TILE_META_PREFIX}:*`,
        'COUNT',
        200
      );
      batches += 1;
      cursor = nextCursor;
      scannedKeys += keys.length;
      if (keys.length === 0) {
        continue;
      }
      sawMetadata = true;

      const values = await this.redis.mget(keys);
      keys.forEach((key, index) => {
        const parsed = this.parseTileMetaKey(key);
        const raw = values[index];
        if (!parsed || !raw) {
          return;
        }

        try {
          const payload = JSON.parse(raw) as TileMetadataPayload;
          const isStale = payload.expiresAt < Date.now();
          this.presence.markPresent(parsed.amenity, parsed.hash, payload.expiresAt, payload.amenityCount, isStale);
          restoredTiles += 1;
        } catch (error) {
          logger.warn({ err: error, key }, 'failed to restore tile metadata from redis');
        }
      });

      if (batches === 1 || cursor === '0' || batches % 10 === 0) {
        reportProgress();
      }
    } while (cursor !== '0');

    if (sawMetadata) {
      await this.redis.set(TILE_COUNT_KEY, String(scannedKeys));
    }

    return { sawMetadata, restoredTiles, totalTiles };
  }

  private async restoreTileKeys(keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    const values = await this.redis.mget(keys);
    let restored = 0;
    const metadataUpdates: Array<{ amenity: string; hash: string; payload: TileMetadataPayload }> = [];

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
        metadataUpdates.push({
          amenity: parsed.amenity,
          hash: parsed.hash,
          payload: { expiresAt: payload.expiresAt, amenityCount }
        });
        restored += 1;
      } catch (error) {
        logger.warn({ err: error, key }, 'failed to restore tile presence from redis');
      }
    });

    if (metadataUpdates.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const update of metadataUpdates) {
        pipeline.set(tileMetaKey(update.hash, update.amenity), JSON.stringify(update.payload));
      }
      try {
        const results = await pipeline.exec();
        for (const result of results ?? []) {
          if (result?.[0]) {
            throw result[0];
          }
        }
      } catch (error) {
        logger.warn({ err: error }, 'failed to store tile metadata during restore');
      }
    }

    return restored;
  }

  private parseTileKey(key: string): { amenity: string; hash: string } | null {
    if (!key.startsWith('tile:')) {
      return null;
    }

    const parts = key.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const [, amenity, hash] = parts;
    if (!amenity || !hash) {
      return null;
    }

    return { amenity, hash };
  }

  private parseTileMetaKey(key: string): { amenity: string; hash: string } | null {
    if (!key.startsWith(`${TILE_META_PREFIX}:`)) {
      return null;
    }

    const parts = key.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const [, amenity, hash] = parts;
    if (!amenity || !hash) {
      return null;
    }

    return { amenity, hash };
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

  public getCacheCoverage(options?: CacheCoverageOptions): CacheCoverageEntry[] {
    return this.presence.getCoverage(options);
  }

  public async getCacheCoverageFromRedis(options: CacheCoverageOptions = {}): Promise<CacheCoverageEntry[]> {
    const targetSize = Math.max(1, options.maxEntries ?? 50000);
    const compactionThreshold = !Number.isFinite(targetSize)
      ? Number.POSITIVE_INFINITY
      : Math.max(targetSize, Math.floor(targetSize * 1.2));

    let coverage = new Map<string, CacheCoverageEntry>();
    let processed = 0;
    let cursor = '0';
    const now = Date.now();

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${TILE_META_PREFIX}:*`,
        'COUNT',
        250
      );
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }

      const values = await this.redis.mget(keys);
      keys.forEach((key, index) => {
        const parsed = this.parseTileMetaKey(key);
        const raw = values[index];
        if (!parsed || !raw) {
          return;
        }

        try {
          const payload = JSON.parse(raw) as TileMetadataPayload;
          const stale = payload.expiresAt < now;
          const base: CacheCoverageEntry = {
            geohash: parsed.hash,
            entries: stale ? 0 : 1,
            amenityItems: stale ? 0 : payload.amenityCount,
            staleEntries: stale ? 1 : 0,
            staleAmenityItems: stale ? payload.amenityCount : 0
          };

          coverage.set(parsed.hash, mergeCoverageEntry(coverage.get(parsed.hash), base));

          processed += 1;
          if (coverage.size > compactionThreshold && processed % 50 === 0) {
            coverage = compactCoverageGeohashEntries(coverage, targetSize);
          }
        } catch {
          // ignore parse errors
        }
      });
    } while (cursor !== '0');

    coverage = compactCoverageGeohashEntries(coverage, targetSize);

    return [...coverage.values()];
  }

  public getCacheCoverageForBounds(options: CacheCoverageBoundsOptions): CacheCoverageEntry[] {
    return this.presence.getCoverageForBounds(options);
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
      const key = tileKey(tile.hash, amenitySuffix);
      pipeline.exists(key);
      pipeline.set(key, JSON.stringify(payload));
      pipeline.set(
        tileMetaKey(tile.hash, amenitySuffix),
        JSON.stringify({ expiresAt: payload.expiresAt, amenityCount } satisfies TileMetadataPayload)
      );
      entriesWithPayload.push({ tile, payload, amenityCount });
    }

    const results = await pipeline.exec();
    let newTiles = 0;
    for (let index = 0; index < (results?.length ?? 0); index += 3) {
      const existsResult = results?.[index];
      const setResult = results?.[index + 1];
      const metaResult = results?.[index + 2];
      if (existsResult?.[0]) {
        throw existsResult[0];
      }
      if (setResult?.[0]) {
        throw setResult[0];
      }
      if (metaResult?.[0]) {
        throw metaResult[0];
      }
      if (existsResult?.[1] === 0) {
        newTiles += 1;
      }
    }

    if (newTiles > 0) {
      await this.redis.incrby(TILE_COUNT_KEY, newTiles);
    }
    await this.redis.incr(CACHE_COVERAGE_REVISION_KEY);

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
      const stale = payload.expiresAt < now;
      this.presence.markPresent(amenitySuffix, tile.hash, payload.expiresAt, amenityCount, stale);
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
    const token = Math.random().toString(36).slice(2);
    const acquired = await this.redis.set(lockKey, token, 'PX', this.options.swrSeconds * 1000, 'NX');
    if (!acquired) {
      logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock skipped');
      return;
    }

    logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock acquired');
    try {
      await handler();
    } finally {
      const current = await this.redis.get(lockKey);
      if (current === token) {
        await this.redis.del(lockKey);
        logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock released');
      } else {
        logger.debug({ tile: tile.hash, amenity: keyAmenity }, 'redis refresh lock release skipped (token mismatch)');
      }
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
    } catch (error) {
      this.presence.markMissing(keyAmenity, tile.hash);
      throw error;
    } finally {
      await this.redis.del(inflightKey);
    }
  }

  public async invalidateTiles(tiles: TileInfo[]): Promise<InvalidateResult> {
    if (tiles.length === 0) {
      return { deletedKeys: 0, matchedKeys: 0, tileHashes: 0, affectedAmenities: [] };
    }

    const hashes = new Set(tiles.map((tile) => tile.hash));
    let deletedKeys = 0;
    let deletedTileKeys = 0;
    let matchedKeys = 0;
    const affectedAmenities = new Set<string>();

    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'tile:*', 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }

      const toDelete: Array<{ key: string; amenity: string; hash: string; isTileKey: boolean }> = [];
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length < 3 || parts[0] !== 'tile') {
          continue;
        }
        const [, amenity, hash] = parts;
        if (!hashes.has(hash)) {
          continue;
        }
        const isTileKey = parts.length === 3;
        toDelete.push({ key, amenity, hash, isTileKey });
        if (isTileKey) {
          toDelete.push({ key: tileMetaKey(hash, amenity), amenity, hash, isTileKey: false });
        }
      }

      if (toDelete.length === 0) {
        continue;
      }

      matchedKeys += toDelete.length;
      const pipeline = this.redis.pipeline();
      for (const entry of toDelete) {
        pipeline.del(entry.key);
      }
      const results = await pipeline.exec();
      for (let index = 0; index < (results?.length ?? 0); index += 1) {
        const result = results?.[index];
        if (result?.[0]) {
          throw result[0];
        }
        const deleted = Number(result?.[1] ?? 0);
        deletedKeys += deleted;
        if (deleted > 0 && toDelete[index]?.isTileKey) {
          deletedTileKeys += 1;
        }
      }

      for (const entry of toDelete) {
        if (!entry.isTileKey) {
          continue;
        }
        this.presence.markMissing(entry.amenity, entry.hash);
        affectedAmenities.add(entry.amenity);
      }
    } while (cursor !== '0');

    if (deletedTileKeys > 0) {
      await this.redis.decrby(TILE_COUNT_KEY, deletedTileKeys);
      await this.redis.incr(CACHE_COVERAGE_REVISION_KEY);
    }

    return {
      deletedKeys,
      matchedKeys,
      tileHashes: hashes.size,
      affectedAmenities: Array.from(affectedAmenities)
    };
  }
}

export const filterElementsByBbox = (elements: OverpassElement[], bbox: BoundingBox): OverpassElement[] => {
  const nodeLocations = new Map<number, { lat: number; lon: number }>();
  const wayNodes = new Map<number, number[]>();

  const isWithin = (lat: number, lon: number): boolean =>
    lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;

  for (const element of elements) {
    if (element.type === 'node' && typeof element.lat === 'number' && typeof element.lon === 'number') {
      nodeLocations.set(element.id, { lat: element.lat, lon: element.lon });
    } else if (element.type === 'way' && Array.isArray(element.nodes)) {
      wayNodes.set(element.id, element.nodes);
    }
  }

  const wayIntersects = (nodeIds: number[] | undefined): boolean => {
    if (!nodeIds || nodeIds.length === 0) {
      return false;
    }
    return nodeIds.some((nodeId) => {
      const coords = nodeLocations.get(nodeId);
      return coords ? isWithin(coords.lat, coords.lon) : false;
    });
  };

  const relationIntersects = (members: OverpassElement['members']): boolean => {
    if (!members || members.length === 0) {
      return false;
    }
    return members.some((member) => {
      if (member.type === 'node') {
        const coords = nodeLocations.get(member.ref);
        return coords ? isWithin(coords.lat, coords.lon) : false;
      }
      if (member.type === 'way') {
        const nodes = wayNodes.get(member.ref);
        return wayIntersects(nodes);
      }
      return false;
    });
  };

  return elements.filter((element) => {
    if (element.type === 'node') {
      if (typeof element.lat !== 'number' || typeof element.lon !== 'number') {
        return false;
      }
      return isWithin(element.lat, element.lon);
    }

    if (element.type === 'way') {
      return wayIntersects(element.nodes);
    }

    if (element.type === 'relation') {
      return relationIntersects(element.members);
    }

    return true;
  });
};
