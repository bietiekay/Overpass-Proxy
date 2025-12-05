import type { Redis } from 'ioredis';
import ngeohash from 'ngeohash';

import type { BoundingBox } from './bbox.js';
import { logger } from './logger.js';
import type { CacheCoverageEntry } from './store.js';
import type { TileInfo } from './tiling.js';
import { startOfDayMs, startOfMonthMs, startOfWeekMs } from './time.js';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface CacheMetricsProvider {
  countCachedTiles(amenity: string): number;
  countCachedAmenities(): number;
  countCachedAmenityTypes(): number;
  countTotalCachedTiles(): number;
  getCacheCoverage(): CacheCoverageEntry[];
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
  cacheHitRate: number;
  averageTilesPerRequest: number;
  cacheStatus: Record<CacheStatus, number>;
  lastRequestAt?: string;
}

export interface AmenityGeohashCoverage {
  amenity: string;
  geohashCoverage: GeohashCoverageEntry[];
}

export interface StatisticsSnapshot {
  generatedAt: string;
  dayStart: string;
  weekStart: string;
  monthStart: string;
  totalRequests: number;
  totalRequestsDay: number;
  totalRequestsWeek: number;
  totalRequestsMonth: number;
  totalUniqueClients: number;
  totalTilesRequested: number;
  totalCachedTiles: number;
  cachedAmenities: number;
  cachedAmenityTypes: number;
  cacheHitRate: number;
  averageTilesPerRequest: number;
  cacheStatus: Record<CacheStatus, number>;
  hotspots: Array<{ geohash: string; requests: number; share: number }>;
  amenities: AmenityStatistics[];
  upstreams: UpstreamStatisticsEntry[];
}

export interface CacheCoverageSnapshot {
  generatedAt: string;
  cacheCoverage: CacheCoverageEntry[];
}

export interface GeohashCoverageSnapshot {
  generatedAt: string;
  geohashCoverage: AmenityGeohashCoverage[];
}

export type UpstreamStatus = 'available' | 'cooldown' | 'blocked';

export interface UpstreamStatisticsEntry {
  upstream: string;
  status: UpstreamStatus;
  reason: string;
  requestsToday: number;
  dayStart: string;
  blockedUntil?: string;
  backoffUntil?: string;
  failedUntil?: string;
  dailyLimit?: number;
  nextRetry?: string;
  ewmaLatencyMs?: number;
  ewmaSuccess?: number;
  weight?: number;
  totalRequests?: number;
  totalFailures?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  backoffAttempts?: number;
}

export interface UpstreamMetricsProvider {
  describeUpstreams(): UpstreamStatisticsEntry[];
}

interface RecordRequestOptions {
  amenity: string;
  clientIp: string;
  bbox: BoundingBox;
  cacheStatus: CacheStatus;
  tileCount: number;
  tiles?: TileInfo[];
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
    return ngeohash.encode(lat, lon, 4);
  } catch {
    return null;
  }
};

const zeroCacheStatus = (): Record<CacheStatus, number> => ({ HIT: 0, MISS: 0, STALE: 0 });

const calculateHitRate = (
  cacheStatus: Record<CacheStatus, number>,
  totalRequests: number
): number => {
  if (totalRequests <= 0) {
    return 0;
  }
  const hitRate = (cacheStatus.HIT / totalRequests) * 100;
  return Number(hitRate.toFixed(2));
};

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
  weekStart: number;
  monthStart: number;
  totalRequests: number;
  totalRequestsDay: number;
  totalRequestsWeek: number;
  totalRequestsMonth: number;
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

  private weekStart: number = startOfWeekMs();

  private monthStart: number = startOfMonthMs();

  private totalRequests = 0;

  private totalRequestsDay = 0;

  private totalRequestsWeek = 0;

  private totalRequestsMonth = 0;

  private totalTiles = 0;

  private readonly uniqueClients = new Set<string>();

  private readonly amenityStats = new Map<string, AmenityStatsInternal>();

  private readonly cacheStatusCounts: Record<CacheStatus, number> = zeroCacheStatus();

  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly cacheMetrics: CacheMetricsProvider,
    private readonly storage: StatisticsStorage,
    private readonly upstreamMetrics?: UpstreamMetricsProvider
  ) {}

  public static async create(
    cacheMetrics: CacheMetricsProvider,
    storage: StatisticsStorage,
    upstreamMetrics?: UpstreamMetricsProvider
  ): Promise<RequestStatistics> {
    const stats = new RequestStatistics(cacheMetrics, storage, upstreamMetrics);
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
      this.weekStart = persisted.weekStart ?? startOfWeekMs(persisted.dayStart);
      this.monthStart = persisted.monthStart ?? startOfMonthMs(persisted.dayStart);
      this.totalRequests = persisted.totalRequests;
      this.totalRequestsDay = persisted.totalRequestsDay ?? persisted.totalRequests;
      this.totalRequestsWeek = persisted.totalRequestsWeek ?? persisted.totalRequests;
      this.totalRequestsMonth = persisted.totalRequestsMonth ?? persisted.totalRequests;
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

  private refreshPeriodCounters(now: number): void {
    const currentDayStart = startOfDayMs(now);
    if (this.dayStart !== currentDayStart) {
      this.dayStart = currentDayStart;
      this.totalRequestsDay = 0;
    }

    const currentWeekStart = startOfWeekMs(now);
    if (this.weekStart !== currentWeekStart) {
      this.weekStart = currentWeekStart;
      this.totalRequestsWeek = 0;
    }

    const currentMonthStart = startOfMonthMs(now);
    if (this.monthStart !== currentMonthStart) {
      this.monthStart = currentMonthStart;
      this.totalRequestsMonth = 0;
    }
  }

  public async recordRequest(options: RecordRequestOptions): Promise<void> {
    await this.runExclusive(async () => {
      const now = options.timestamp ?? Date.now();

      this.refreshPeriodCounters(now);

      const clientIp = normaliseClientIp(options.clientIp);
      const amenity = options.amenity.trim().toLowerCase();

      this.totalRequests += 1;
      this.totalRequestsDay += 1;
      this.totalRequestsWeek += 1;
      this.totalRequestsMonth += 1;
      this.totalTiles += options.tileCount;
      this.uniqueClients.add(clientIp);
      this.cacheStatusCounts[options.cacheStatus] += 1;

      const amenityStats = this.getAmenityStats(amenity);
      amenityStats.requests += 1;
      amenityStats.totalTiles += options.tileCount;
      amenityStats.clients.add(clientIp);
      amenityStats.cacheStatusCounts[options.cacheStatus] += 1;
      amenityStats.lastRequestAt = now;

      const geohashes =
        options.tiles && options.tiles.length > 0
          ? new Set(options.tiles.map((tile) => tile.hash))
          : new Set<string>([geohashForBoundingBox(options.bbox) ?? undefined].filter(Boolean) as string[]);

      for (const geohash of geohashes) {
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
      this.refreshPeriodCounters(now);

      const generatedAt = new Date(now).toISOString();
      const dayStartIso = new Date(this.dayStart).toISOString();
      const weekStartIso = new Date(this.weekStart).toISOString();
      const monthStartIso = new Date(this.monthStart).toISOString();

      const amenities: AmenityStatistics[] = [];
      const globalGeohashCounts = new Map<string, number>();

      for (const stats of this.amenityStats.values()) {
        const cacheItems = this.cacheMetrics.countCachedTiles(stats.amenity);
        for (const [hash, count] of stats.geohashCounts) {
          globalGeohashCounts.set(hash, (globalGeohashCounts.get(hash) ?? 0) + count);
        }

        const averageTilesPerRequest =
          stats.requests > 0 ? Number((stats.totalTiles / stats.requests).toFixed(2)) : 0;

        const cacheHitRate = calculateHitRate(stats.cacheStatusCounts, stats.requests);

        amenities.push({
          amenity: stats.amenity,
          requests: stats.requests,
          uniqueClients: stats.clients.size,
          cacheItems,
          cacheHitRate,
          averageTilesPerRequest,
          cacheStatus: { ...stats.cacheStatusCounts },
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

      const cacheHitRate = calculateHitRate(this.cacheStatusCounts, this.totalRequests);

      const upstreams = this.upstreamMetrics?.describeUpstreams() ?? [];

      return {
        generatedAt,
        dayStart: dayStartIso,
        weekStart: weekStartIso,
        monthStart: monthStartIso,
        totalRequests: this.totalRequests,
        totalRequestsDay: this.totalRequestsDay,
        totalRequestsWeek: this.totalRequestsWeek,
        totalRequestsMonth: this.totalRequestsMonth,
        totalUniqueClients: this.uniqueClients.size,
        totalTilesRequested: this.totalTiles,
        totalCachedTiles: this.cacheMetrics.countTotalCachedTiles(),
        cachedAmenities: this.cacheMetrics.countCachedAmenities(),
        cachedAmenityTypes: this.cacheMetrics.countCachedAmenityTypes(),
        cacheHitRate,
        averageTilesPerRequest,
        cacheStatus: { ...this.cacheStatusCounts },
        hotspots,
        amenities,
        upstreams
      };
    });
  }

  public async getGeohashCoverageSnapshot(now = Date.now()): Promise<GeohashCoverageSnapshot> {
    return this.runExclusive(async () => {
      this.refreshPeriodCounters(now);

      const generatedAt = new Date(now).toISOString();
      const { amenityCoverage } = this.buildGeohashCoverage();

      return { generatedAt, geohashCoverage: amenityCoverage };
    });
  }

  public async getCacheCoverageSnapshot(now = Date.now()): Promise<CacheCoverageSnapshot> {
    const generatedAt = new Date(now).toISOString();
    const cacheCoverage = this.cacheMetrics
      .getCacheCoverage()
      .sort((a, b) => b.entries - a.entries || a.geohash.localeCompare(b.geohash));

    return { generatedAt, cacheCoverage };
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.save(this.serialise());
    } catch (error) {
      logger.warn({ err: error }, 'failed to persist request statistics');
    }
  }

  private buildGeohashCoverage(): {
    amenityCoverage: AmenityGeohashCoverage[];
    globalGeohashCounts: Map<string, number>;
  } {
    const amenityCoverageWithCounts: Array<AmenityGeohashCoverage & { requests: number }> = [];
    const globalGeohashCounts = new Map<string, number>();

    for (const stats of this.amenityStats.values()) {
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

      amenityCoverageWithCounts.push({
        amenity: stats.amenity,
        geohashCoverage,
        requests: stats.requests
      });
    }

    amenityCoverageWithCounts.sort(
      (a, b) => b.requests - a.requests || a.amenity.localeCompare(b.amenity)
    );

    const amenityCoverage = amenityCoverageWithCounts.map(({ requests: _requests, ...rest }) => rest);

    return { amenityCoverage, globalGeohashCounts };
  }

  private serialise(): PersistedStatisticsState {
    return {
      dayStart: this.dayStart,
      weekStart: this.weekStart,
      monthStart: this.monthStart,
      totalRequests: this.totalRequests,
      totalRequestsDay: this.totalRequestsDay,
      totalRequestsWeek: this.totalRequestsWeek,
      totalRequestsMonth: this.totalRequestsMonth,
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
