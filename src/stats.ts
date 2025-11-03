import type { Redis } from 'ioredis';
import ngeohash from 'ngeohash';

import type { BoundingBox } from './bbox.js';
import { logger } from './logger.js';
import { startOfDayMs } from './time.js';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface CacheMetricsProvider {
  countCachedTiles(amenity: string): number;
}

interface AmenityStatsInternal {
  amenity: string;
  requests: number;
  totalTiles: number;
  clients: Set<string>;
  geohashCounts: Map<string, number>;
  cacheStatusCounts: Record<CacheStatus, number>;
  lastRequestAt: number;
}

export interface GeohashCoverageEntry {
  geohash: string;
  percentage: number;
  requests: number;
}

export interface AmenityStatistics {
  amenity: string;
  requests: number;
  uniqueClients: number;
  cacheItems: number;
  averageTilesPerRequest: number;
  cacheStatus: Record<CacheStatus, number>;
  geohashCoverage: GeohashCoverageEntry[];
  lastRequestAt?: string;
}

export interface StatisticsSnapshot {
  generatedAt: string;
  dayStart: string;
  totalRequests: number;
  totalUniqueClients: number;
  totalTilesRequested: number;
  averageTilesPerRequest: number;
  cacheStatus: Record<CacheStatus, number>;
  hotspots: Array<{ geohash: string; requests: number; share: number }>;
  amenities: AmenityStatistics[];
}

interface RecordRequestOptions {
  amenity: string;
  clientIp: string;
  bbox: BoundingBox;
  cacheStatus: CacheStatus;
  tileCount: number;
  timestamp?: number;
}

const normaliseClientIp = (value: string): string => {
  if (!value || value.trim().length === 0) {
    return 'unknown';
  }
  return value;
};

const geohashForBoundingBox = (bbox: BoundingBox): string | null => {
  const lat = (bbox.north + bbox.south) / 2;
  const lon = (bbox.east + bbox.west) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  try {
    return ngeohash.encode(lat, lon, 3);
  } catch {
    return null;
  }
};

const zeroCacheStatus = (): Record<CacheStatus, number> => ({ HIT: 0, MISS: 0, STALE: 0 });

interface PersistedAmenityStats {
  amenity: string;
  requests: number;
  totalTiles: number;
  clients: string[];
  geohashCounts: Array<[string, number]>;
  cacheStatusCounts: Record<CacheStatus, number>;
  lastRequestAt: number;
}

export interface PersistedStatisticsState {
  dayStart: number;
  totalRequests: number;
  totalTiles: number;
  uniqueClients: string[];
  cacheStatusCounts: Record<CacheStatus, number>;
  amenities: PersistedAmenityStats[];
}

export interface StatisticsStorage {
  load(): Promise<PersistedStatisticsState | null>;
  save(state: PersistedStatisticsState): Promise<void>;
}

export class RedisStatisticsStorage implements StatisticsStorage {
  constructor(private readonly redis: Redis, private readonly key = 'statistics:current') {}

  public async load(): Promise<PersistedStatisticsState | null> {
    const raw = await this.redis.get(this.key);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as PersistedStatisticsState;
    } catch (error) {
      logger.warn({ err: error }, 'failed to parse persisted request statistics');
      return null;
    }
  }

  public async save(state: PersistedStatisticsState): Promise<void> {
    await this.redis.set(this.key, JSON.stringify(state));
  }
}

export class RequestStatistics {
  private dayStart: number = startOfDayMs();

  private totalRequests = 0;

  private totalTiles = 0;

  private readonly uniqueClients = new Set<string>();

  private readonly amenityStats = new Map<string, AmenityStatsInternal>();

  private readonly cacheStatusCounts: Record<CacheStatus, number> = zeroCacheStatus();

  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly cacheMetrics: CacheMetricsProvider,
    private readonly storage: StatisticsStorage
  ) {}

  public static async create(
    cacheMetrics: CacheMetricsProvider,
    storage: StatisticsStorage
  ): Promise<RequestStatistics> {
    const stats = new RequestStatistics(cacheMetrics, storage);
    await stats.restore();
    return stats;
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async restore(): Promise<void> {
    try {
      const persisted = await this.storage.load();
      if (!persisted) {
        return;
      }

      this.dayStart = persisted.dayStart;
      this.totalRequests = persisted.totalRequests;
      this.totalTiles = persisted.totalTiles;
      this.uniqueClients.clear();
      for (const client of persisted.uniqueClients) {
        this.uniqueClients.add(client);
      }
      this.cacheStatusCounts.HIT = persisted.cacheStatusCounts.HIT ?? 0;
      this.cacheStatusCounts.MISS = persisted.cacheStatusCounts.MISS ?? 0;
      this.cacheStatusCounts.STALE = persisted.cacheStatusCounts.STALE ?? 0;
      this.amenityStats.clear();
      for (const amenity of persisted.amenities) {
        const stats: AmenityStatsInternal = {
          amenity: amenity.amenity,
          requests: amenity.requests,
          totalTiles: amenity.totalTiles,
          clients: new Set(amenity.clients),
          geohashCounts: new Map(amenity.geohashCounts),
          cacheStatusCounts: {
            HIT: amenity.cacheStatusCounts.HIT ?? 0,
            MISS: amenity.cacheStatusCounts.MISS ?? 0,
            STALE: amenity.cacheStatusCounts.STALE ?? 0
          },
          lastRequestAt: amenity.lastRequestAt ?? 0
        };
        this.amenityStats.set(stats.amenity, stats);
      }
    } catch (error) {
      logger.warn({ err: error }, 'failed to restore request statistics from storage');
    }
  }

  private async rotateDay(now = Date.now()): Promise<void> {
    const start = startOfDayMs(now);
    if (start === this.dayStart) {
      return;
    }

    this.dayStart = start;
    this.totalRequests = 0;
    this.totalTiles = 0;
    this.uniqueClients.clear();
    this.amenityStats.clear();
    this.cacheStatusCounts.HIT = 0;
    this.cacheStatusCounts.MISS = 0;
    this.cacheStatusCounts.STALE = 0;

    await this.persist();
  }

  private getAmenityStats(amenity: string): AmenityStatsInternal {
    let stats = this.amenityStats.get(amenity);
    if (!stats) {
      stats = {
        amenity,
        requests: 0,
        totalTiles: 0,
        clients: new Set<string>(),
        geohashCounts: new Map<string, number>(),
        cacheStatusCounts: zeroCacheStatus(),
        lastRequestAt: 0
      };
      this.amenityStats.set(amenity, stats);
    }
    return stats;
  }

  public async recordRequest(options: RecordRequestOptions): Promise<void> {
    await this.runExclusive(async () => {
      const now = options.timestamp ?? Date.now();
      await this.rotateDay(now);

      const clientIp = normaliseClientIp(options.clientIp);
      const amenity = options.amenity.trim().toLowerCase();

      this.totalRequests += 1;
      this.totalTiles += options.tileCount;
      this.uniqueClients.add(clientIp);
      this.cacheStatusCounts[options.cacheStatus] += 1;

      const amenityStats = this.getAmenityStats(amenity);
      amenityStats.requests += 1;
      amenityStats.totalTiles += options.tileCount;
      amenityStats.clients.add(clientIp);
      amenityStats.cacheStatusCounts[options.cacheStatus] += 1;
      amenityStats.lastRequestAt = now;

      const geohash = geohashForBoundingBox(options.bbox);
      if (geohash) {
        amenityStats.geohashCounts.set(
          geohash,
          (amenityStats.geohashCounts.get(geohash) ?? 0) + 1
        );
      }

      await this.persist();
    });
  }

  public async getSnapshot(now = Date.now()): Promise<StatisticsSnapshot> {
    return this.runExclusive(async () => {
      await this.rotateDay(now);

      const generatedAt = new Date(now).toISOString();
      const dayStartIso = new Date(this.dayStart).toISOString();

      const amenities: AmenityStatistics[] = [];
      const globalGeohashCounts = new Map<string, number>();

      for (const stats of this.amenityStats.values()) {
        const cacheItems = this.cacheMetrics.countCachedTiles(stats.amenity);
        const geohashCoverage: GeohashCoverageEntry[] = [];

        for (const [hash, count] of stats.geohashCounts) {
          const percentage = stats.requests > 0 ? (count / stats.requests) * 100 : 0;
          geohashCoverage.push({
            geohash: hash,
            percentage: Number(percentage.toFixed(2)),
            requests: count
          });
          globalGeohashCounts.set(hash, (globalGeohashCounts.get(hash) ?? 0) + count);
        }

        geohashCoverage.sort((a, b) => b.requests - a.requests);

        const averageTilesPerRequest =
          stats.requests > 0 ? Number((stats.totalTiles / stats.requests).toFixed(2)) : 0;

        amenities.push({
          amenity: stats.amenity,
          requests: stats.requests,
          uniqueClients: stats.clients.size,
          cacheItems,
          averageTilesPerRequest,
          cacheStatus: { ...stats.cacheStatusCounts },
          geohashCoverage,
          lastRequestAt:
            stats.lastRequestAt > 0 ? new Date(stats.lastRequestAt).toISOString() : undefined
        });
      }

      amenities.sort((a, b) => b.requests - a.requests || a.amenity.localeCompare(b.amenity));

      const hotspots = [...globalGeohashCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([geohash, requests]) => ({
          geohash,
          requests,
          share:
            this.totalRequests > 0
              ? Number(((requests / this.totalRequests) * 100).toFixed(2))
              : 0
        }));

      const averageTilesPerRequest =
        this.totalRequests > 0 ? Number((this.totalTiles / this.totalRequests).toFixed(2)) : 0;

      return {
        generatedAt,
        dayStart: dayStartIso,
        totalRequests: this.totalRequests,
        totalUniqueClients: this.uniqueClients.size,
        totalTilesRequested: this.totalTiles,
        averageTilesPerRequest,
        cacheStatus: { ...this.cacheStatusCounts },
        hotspots,
        amenities
      };
    });
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.save(this.serialise());
    } catch (error) {
      logger.warn({ err: error }, 'failed to persist request statistics');
    }
  }

  private serialise(): PersistedStatisticsState {
    return {
      dayStart: this.dayStart,
      totalRequests: this.totalRequests,
      totalTiles: this.totalTiles,
      uniqueClients: [...this.uniqueClients],
      cacheStatusCounts: { ...this.cacheStatusCounts },
      amenities: [...this.amenityStats.values()].map((stats) => ({
        amenity: stats.amenity,
        requests: stats.requests,
        totalTiles: stats.totalTiles,
        clients: [...stats.clients],
        geohashCounts: [...stats.geohashCounts.entries()],
        cacheStatusCounts: { ...stats.cacheStatusCounts },
        lastRequestAt: stats.lastRequestAt
      }))
    };
  }
}
