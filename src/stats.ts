import IORedis, { type Redis } from 'ioredis';
import ngeohash from 'ngeohash';
import { setImmediate as setImmediateCallback } from 'node:timers';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import type { BoundingBox } from './bbox.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { CacheCoverageEntry, CacheCoverageOptions } from './store.js';
import { CACHE_COVERAGE_REVISION_KEY, TileStore } from './store.js';
import type { TileInfo } from './tiling.js';
import { startOfDayMs, startOfMonthMs, startOfWeekMs } from './time.js';
import type {
  StaleRefreshQueueMetricsProvider,
  StaleRefreshQueueOverview
} from './staleRefreshQueue.js';
import { StaleRefreshQueue } from './staleRefreshQueue.js';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface CacheMetricsProvider {
  countCachedTiles(amenity: string): number;
  countCachedAmenities(): number;
  countCachedAmenityTypes(): number;
  countTotalCachedTiles(): number;
  getCacheCoverage(options?: CacheCoverageOptions): CacheCoverageEntry[];
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

type AmenityCoverageState = {
  amenity: string;
  requests: number;
  geohashCounts: Array<[string, number]>;
};

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
  totalStaleTiles: number; // Total number of stale tiles in cache (sum of staleEntries from cache coverage)
  cachedAmenities: number;
  cachedAmenityTypes: number;
  cacheHitRate: number;
  averageTilesPerRequest: number;
  cacheStatus: Record<CacheStatus, number>; // cacheStatus.STALE = number of requests that returned stale data (not tile count)
  hotspots: Array<{ geohash: string; requests: number; share: number }>;
  amenities: AmenityStatistics[];
  upstreams: UpstreamStatisticsEntry[];
  staleRefreshQueue?: StaleRefreshQueueOverview;
}

export interface CacheCoverageSnapshot {
  generatedAt: string;
  cacheCoverage: CacheCoverageEntry[];
  pending?: boolean;
}

export interface GeohashCoverageSnapshot {
  generatedAt: string;
  geohashCoverage: AmenityGeohashCoverage[];
  pending?: boolean;
}

export type UpstreamStatus = 'available' | 'cooldown' | 'blocked';

export interface UpstreamStatisticsEntry {
  upstream: string;
  status: UpstreamStatus;
  reason: string;
  backoffReason?: string;
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

export const DEFAULT_COVERAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_COVERAGE_CACHE_TTL_MS = 30 * 60 * 1000;
export const COVERAGE_YIELD_INTERVAL = 250;
export const DEFAULT_CACHE_COVERAGE_MAX_ENTRIES = 25000;
export const DEFAULT_GEOHASH_COVERAGE_MAX_ENTRIES = 10000;
export const COMPACTION_THRESHOLD_MULTIPLIER = 1.25;
const MIN_STATS_COVERAGE_GEOHASH_PRECISION = 3;

export const STATISTICS_SNAPSHOT_KEY = 'statistics:snapshot';
export const CACHE_COVERAGE_SNAPSHOT_KEY = 'statistics:cacheCoverageSnapshot';
export const GEOHASH_COVERAGE_SNAPSHOT_KEY = 'statistics:geohashCoverageSnapshot';
const MIN_REFRESH_TRIGGER_INTERVAL_MS = 5_000;

const yieldToEventLoop = async (): Promise<void> =>
  new Promise((resolve) => setImmediateCallback(resolve));

const normaliseLimit = (value: number | undefined, fallback: number): number =>
  Math.max(1, value ?? fallback);

const reduceCoverageGeohashPrecision = (geohash: string): string =>
  geohash.length > MIN_STATS_COVERAGE_GEOHASH_PRECISION ? geohash.slice(0, -1) : geohash;

type GeohashMerge<T> = (existing: T | undefined, incoming: T, geohash: string) => T;

const compactCoverageGeohashMap = <T>(
  entries: Map<string, T>,
  targetSize: number,
  combine: GeohashMerge<T>
): Map<string, T> => {
  if (!Number.isFinite(targetSize) || targetSize <= 0 || entries.size <= targetSize) {
    return entries;
  }

  let current = entries;

  while (current.size > targetSize) {
    const next = new Map<string, T>();
    let changed = false;

    for (const [geohash, value] of current) {
      const targetHash = reduceCoverageGeohashPrecision(geohash);
      const merged = combine(next.get(targetHash), value, targetHash);
      next.set(targetHash, merged);
      changed = changed || targetHash !== geohash;
    }

    if (!changed) {
      break;
    }

    current = next;
  }

  return current;
};

const mergeCacheCoverageEntry = (
  existing: CacheCoverageEntry | undefined,
  incoming: CacheCoverageEntry,
  geohash = incoming.geohash
): CacheCoverageEntry => ({
  geohash,
  entries: (existing?.entries ?? 0) + incoming.entries,
  amenityItems: (existing?.amenityItems ?? 0) + incoming.amenityItems,
  staleEntries: (existing?.staleEntries ?? 0) + incoming.staleEntries,
  staleAmenityItems: (existing?.staleAmenityItems ?? 0) + incoming.staleAmenityItems
});

const mergeCacheCoverageForHash: GeohashMerge<CacheCoverageEntry> = (existing, incoming, geohash) =>
  mergeCacheCoverageEntry(existing, { ...incoming, geohash }, geohash);

const mergeGeohashCount: GeohashMerge<number> = (existing, incoming) =>
  (existing ?? 0) + incoming;

interface SnapshotCacheStoreEntry {
  value: string;
  expiresAt: number;
}

export class SnapshotCacheStore {
  private readonly memory = new Map<string, SnapshotCacheStoreEntry>();

  constructor(private readonly redis?: Redis) {}

  public async get(key: string): Promise<string | null> {
    if (this.redis) {
      return this.redis.get(key);
    }

    const current = this.memory.get(key);
    if (!current) {
      return null;
    }

    if (current.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }

    return current.value;
  }

  public async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (this.redis) {
      await this.redis.set(key, value, 'PX', ttlMs);
      return;
    }

    this.memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export interface SnapshotReadOptions {
  refreshIntervalMs?: number;
}

export const readCachedSnapshot = async <T extends { generatedAt: string }>(
  store: SnapshotCacheStore,
  key: string,
  now = Date.now(),
  options: SnapshotReadOptions = {}
): Promise<{ snapshot: T | null; pending: boolean }> => {
  const raw = await store.get(key);
  if (!raw) {
    return { snapshot: null, pending: true };
  }

  try {
    const snapshot = JSON.parse(raw) as T;
    const generatedAt = Date.parse(snapshot.generatedAt);
    const invalid = !Number.isFinite(generatedAt);
    
    // Check if snapshot is too old (stale)
    // If refreshIntervalMs is provided and snapshot is older than 2x the interval, consider it stale
    if (!invalid && options.refreshIntervalMs && options.refreshIntervalMs > 0) {
      const ageMs = now - generatedAt;
      const maxAgeMs = options.refreshIntervalMs * 2;
      if (ageMs > maxAgeMs) {
        logger.warn(
          {
            key,
            ageMs,
            maxAgeMs,
            generatedAt: snapshot.generatedAt
          },
          'cached snapshot is too old, marking as pending to force refresh'
        );
        return { snapshot, pending: true };
      }
    }
    
    return { snapshot, pending: invalid };
  } catch (error) {
    logger.warn({ err: error, key }, 'failed to parse cached snapshot');
    return { snapshot: null, pending: true };
  }
};

const reportMemoryUsage = (): {
  rssMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
} => {
  const memory = process.memoryUsage();
  const toMb = (value: number) => Math.round(value / 1024 / 1024);

  return {
    rssMb: toMb(memory.rss),
    heapTotalMb: toMb(memory.heapTotal),
    heapUsedMb: toMb(memory.heapUsed),
    externalMb: toMb(memory.external),
    arrayBuffersMb: toMb(memory.arrayBuffers)
  };
};

const summarizeAmenityState = (
  amenityState: AmenityCoverageState[]
): {
  amenityCount: number;
  geohashEntries: number;
  maxAmenityGeohashes: number;
  maxAmenity?: string;
} => {
  let geohashEntries = 0;
  let maxAmenityGeohashes = 0;
  let maxAmenity: string | undefined;

  for (const stats of amenityState) {
    const entryCount = stats.geohashCounts.length;
    geohashEntries += entryCount;
    if (entryCount > maxAmenityGeohashes) {
      maxAmenityGeohashes = entryCount;
      maxAmenity = stats.amenity;
    }
  }

  return {
    amenityCount: amenityState.length,
    geohashEntries,
    maxAmenityGeohashes,
    maxAmenity
  };
};

export class SharedStaleRefreshMetrics implements StaleRefreshQueueMetricsProvider {
  private overview: StaleRefreshQueueOverview = {
    queuedRequests: 0,
    queuedTileGroups: 0,
    queuedTiles: 0
  };

  private readonly listeners = new Set<() => void>();

  describeQueue(): StaleRefreshQueueOverview {
    return this.overview;
  }

  onUpdate(listener: () => void): void {
    this.listeners.add(listener);
  }

  public update(overview: StaleRefreshQueueOverview): void {
    this.overview = overview;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn({ err: error }, 'stale refresh metrics listener failed');
      }
    }
  }
}

class SnapshotCache<T extends { generatedAt: string }> {
  private refreshPromise: Promise<boolean> | null = null;

  private refreshStartTime: number | null = null;

  private lastGeneratedAt: number | null = null;

  private dirty = false;

  private readonly buildTimeoutMs: number;

  private refreshFailureCount = 0;

  constructor(
    private readonly store: SnapshotCacheStore,
    private readonly key: string,
    private readonly builder: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly refreshIntervalMs: number,
    private readonly label: string
  ) {
    // Set timeout to 10 minutes for statistics builds to prevent infinite hangs
    this.buildTimeoutMs = 10 * 60 * 1000;
  }

  public start(): void {
    this.maybeRefresh();
    if (this.refreshIntervalMs > 0) {
      setInterval(() => this.maybeRefresh(), this.refreshIntervalMs).unref();
    }
  }

  public async refresh(): Promise<boolean> {
    if (this.refreshPromise) {
      // Check if the refresh has been running too long (stuck)
      if (this.refreshStartTime && Date.now() - this.refreshStartTime > this.buildTimeoutMs) {
        logger.warn(
          {
            key: this.key,
            label: this.label,
            target: this.label,
            durationMs: Date.now() - this.refreshStartTime,
            ageMs: this.currentSnapshotAgeMs(),
            failureCount: this.refreshFailureCount
          },
          'statistics snapshot build appears stuck, resetting'
        );
        this.refreshPromise = null;
        this.refreshStartTime = null;
      } else {
        return this.refreshPromise;
      }
    }

    this.refreshStartTime = Date.now();
    this.refreshPromise = this.buildAndStore();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
      this.refreshStartTime = null;
    }
  }

  public markDirty(): void {
    this.dirty = true;
  }

  public async saveSnapshot(snapshot: T): Promise<void> {
    await this.storeSnapshot(snapshot);
  }

  public async readWithStatus(
    now = Date.now(),
    options: { skipRefresh?: boolean } = {}
  ): Promise<{ snapshot: T | null; pending: boolean }> {
    const snapshot = await this.read();
    const stale = this.isStale(now);
    
    // Check if refresh is stuck (running too long)
    const refreshStartTime = this.refreshStartTime;
    const isRefreshStuck =
      this.refreshPromise !== null &&
      refreshStartTime !== null &&
      now - refreshStartTime > this.buildTimeoutMs;
    
    if (isRefreshStuck) {
      logger.warn(
        {
          key: this.key,
          label: this.label,
          target: this.label,
          durationMs: now - refreshStartTime,
          ageMs: this.currentSnapshotAgeMs(now),
          failureCount: this.refreshFailureCount
        },
        'detected stuck statistics snapshot build, resetting'
      );
      this.refreshPromise = null;
      this.refreshStartTime = null;
      this.dirty = true; // Mark as dirty to trigger a new build
    }
    
    if (stale && !options.skipRefresh) {
      this.maybeRefresh();
    }

    return { snapshot, pending: stale || this.refreshPromise !== null || snapshot === null };
  }

  private async read(): Promise<T | null> {
    const raw = await this.store.get(this.key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as T;
      const generatedAt = Date.parse(parsed.generatedAt);
      if (Number.isFinite(generatedAt)) {
        this.lastGeneratedAt = generatedAt;
        this.dirty = false;
      }
      return parsed;
    } catch (error) {
      logger.warn({ err: error, key: this.key }, 'failed to parse cached statistics snapshot');
      return null;
    }
  }

  private async buildAndStore(): Promise<boolean> {
    const startTime = Date.now();
    try {
      // Wrap builder in timeout to prevent infinite hangs
      const snapshot = await Promise.race([
        this.builder(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Statistics snapshot build timeout')), this.buildTimeoutMs)
        )
      ]);
      await this.storeSnapshot(snapshot);
      this.refreshFailureCount = 0;
      const durationMs = Date.now() - startTime;
      logger.info(
        {
          key: this.key,
          label: this.label,
          target: this.label,
          durationMs,
          ageMs: this.currentSnapshotAgeMs()
        },
        'statistics snapshot built and stored successfully'
      );
      return true;
    } catch (error) {
      this.refreshFailureCount += 1;
      const durationMs = Date.now() - startTime;
      logger.warn(
        {
          err: error,
          key: this.key,
          label: this.label,
          target: this.label,
          durationMs,
          ageMs: this.currentSnapshotAgeMs(),
          failureCount: this.refreshFailureCount
        },
        'failed to refresh statistics snapshot'
      );
      return false;
    }
  }

  private async storeSnapshot(snapshot: T): Promise<void> {
    const serialised = JSON.stringify(snapshot);
    await this.store.set(this.key, serialised, this.ttlMs);
    const generatedAt = Date.parse(snapshot.generatedAt);
    if (Number.isFinite(generatedAt)) {
      this.lastGeneratedAt = generatedAt;
      this.dirty = false;
    }
  }

  private isStale(_now: number): boolean {
    if (this.dirty) {
      return true;
    }
    if (!this.lastGeneratedAt) {
      return true;
    }
    return false;
  }

  private maybeRefresh(): void {
    if (!this.isStale(Date.now())) {
      return;
    }
    if (this.refreshPromise) {
      // Check if refresh is stuck
      if (this.refreshStartTime && Date.now() - this.refreshStartTime > this.buildTimeoutMs) {
        logger.warn(
          {
            key: this.key,
            label: this.label,
            target: this.label,
            durationMs: Date.now() - this.refreshStartTime,
            ageMs: this.currentSnapshotAgeMs(),
            failureCount: this.refreshFailureCount
          },
          'statistics snapshot build appears stuck in maybeRefresh, resetting'
        );
        this.refreshPromise = null;
        this.refreshStartTime = null;
      } else {
        return;
      }
    }

    this.refreshStartTime = Date.now();
    this.refreshPromise = this.buildAndStore().finally(() => {
      this.refreshPromise = null;
      this.refreshStartTime = null;
    });
  }

  private currentSnapshotAgeMs(now = Date.now()): number | undefined {
    if (!this.lastGeneratedAt) {
      return undefined;
    }
    return Math.max(0, now - this.lastGeneratedAt);
  }
}

export interface RecordRequestOptions {
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

export interface RequestStatisticsOptions {
  redis?: Redis;
  coverageRefreshIntervalMs?: number;
  coverageCacheTtlMs?: number;
  maxCacheCoverageEntries?: number;
  maxGeohashCoverageEntries?: number;
  staleRefreshQueue?: StaleRefreshQueueMetricsProvider;
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

  private readonly snapshotStore: SnapshotCacheStore;

  private readonly cacheCoverageCache: SnapshotCache<CacheCoverageSnapshot>;

  private readonly geohashCoverageCache: SnapshotCache<GeohashCoverageSnapshot>;

  private readonly statisticsCache: SnapshotCache<StatisticsSnapshot>;

  private readonly staleRefreshQueue?: StaleRefreshQueueMetricsProvider;

  private readonly maxCacheCoverageEntries: number;

  private readonly cacheCoverageCompactionThreshold: number;

  private readonly maxGeohashCoverageEntries: number;

  private readonly geohashCoverageCompactionThreshold: number;

  private revision = 0;

  private snapshotRevision = 0;

  private cacheCoverageRevision: number | null = null;

  private cacheCoverageSnapshot: CacheCoverageSnapshot | null = null;

  private cacheCoverageLastBuiltAt: number | null = null;

  private readonly coverageRefreshIntervalMs: number;

  private constructor(
    private readonly cacheMetrics: CacheMetricsProvider,
    private readonly storage: StatisticsStorage,
    private readonly upstreamMetrics?: UpstreamMetricsProvider,
    options: RequestStatisticsOptions = {}
  ) {
    this.staleRefreshQueue = options.staleRefreshQueue;
    const refreshIntervalMs = options.coverageRefreshIntervalMs ?? DEFAULT_COVERAGE_REFRESH_INTERVAL_MS;
    this.coverageRefreshIntervalMs = refreshIntervalMs;
    const cacheTtlMs = options.coverageCacheTtlMs ?? DEFAULT_COVERAGE_CACHE_TTL_MS;

    this.maxCacheCoverageEntries = normaliseLimit(
      options.maxCacheCoverageEntries,
      DEFAULT_CACHE_COVERAGE_MAX_ENTRIES
    );
    this.cacheCoverageCompactionThreshold = Math.floor(
      this.maxCacheCoverageEntries * COMPACTION_THRESHOLD_MULTIPLIER
    );
    this.maxGeohashCoverageEntries = normaliseLimit(
      options.maxGeohashCoverageEntries,
      DEFAULT_GEOHASH_COVERAGE_MAX_ENTRIES
    );
    this.geohashCoverageCompactionThreshold = Math.floor(
      this.maxGeohashCoverageEntries * COMPACTION_THRESHOLD_MULTIPLIER
    );

    logger.info(
      {
        refreshIntervalMs,
        cacheTtlMs,
        maxCacheCoverageEntries: this.maxCacheCoverageEntries,
        cacheCoverageCompactionThreshold: this.cacheCoverageCompactionThreshold,
        maxGeohashCoverageEntries: this.maxGeohashCoverageEntries,
        geohashCoverageCompactionThreshold: this.geohashCoverageCompactionThreshold
      },
      'initialised statistics coverage settings'
    );

    this.snapshotStore = new SnapshotCacheStore(options.redis);
    this.cacheCoverageCache = new SnapshotCache(
      this.snapshotStore,
      CACHE_COVERAGE_SNAPSHOT_KEY,
      () => this.buildCacheCoverageSnapshot(),
      cacheTtlMs,
      refreshIntervalMs,
      'cache-coverage'
    );
    this.geohashCoverageCache = new SnapshotCache(
      this.snapshotStore,
      GEOHASH_COVERAGE_SNAPSHOT_KEY,
      () => this.buildGeohashCoverageSnapshot(),
      cacheTtlMs,
      refreshIntervalMs,
      'geohash-coverage'
    );
    this.statisticsCache = new SnapshotCache(
      this.snapshotStore,
      STATISTICS_SNAPSHOT_KEY,
      () => this.buildStatisticsSnapshot(),
      cacheTtlMs,
      refreshIntervalMs,
      'statistics'
    );

    this.staleRefreshQueue?.onUpdate?.(() => {
      this.statisticsCache.markDirty();
    });
  }

  public static async create(
    cacheMetrics: CacheMetricsProvider,
    storage: StatisticsStorage,
    upstreamMetrics?: UpstreamMetricsProvider,
    options: RequestStatisticsOptions = {}
  ): Promise<RequestStatistics> {
    const stats = new RequestStatistics(cacheMetrics, storage, upstreamMetrics, options);
    await stats.restore();
    stats.cacheCoverageCache.start();
    stats.geohashCoverageCache.start();
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

      this.revision = persisted.totalRequests ?? 0;
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

      this.revision += 1;

      await this.persist();

      this.geohashCoverageCache.markDirty();
      this.statisticsCache.markDirty();
    });
  }

  public markCacheCoverageDirty(): void {
    this.cacheCoverageCache.markDirty();
  }

  public markGeohashCoverageDirty(): void {
    this.geohashCoverageCache.markDirty();
  }

  public markStatisticsDirty(): void {
    this.statisticsCache.markDirty();
  }

  public async getSnapshot(now = Date.now()): Promise<StatisticsSnapshot> {
    const { snapshot, pending } = await this.statisticsCache.readWithStatus(now, {
      skipRefresh: true
    });
    const needsRefresh = pending || this.snapshotRevision < this.revision;

    // If we have a cached snapshot (even if stale), return it immediately
    // and trigger refresh in background without blocking
    if (snapshot) {
      if (needsRefresh) {
        // Trigger refresh asynchronously without waiting
        setImmediateCallback(() => {
          void this.statisticsCache
            .refresh()
            .then((succeeded) => {
              if (succeeded) {
                this.snapshotRevision = this.revision;
              }
            })
            .catch((error) => {
              logger.warn({ err: error }, 'failed to refresh statistics snapshot in background');
            });
        });
      }
      return snapshot;
    }

    // If no cached snapshot exists, we need to build it
    // For the first build, we do it synchronously (should be fast with no data)
    // but ensure it yields to event loop to avoid blocking
    // For subsequent calls, this should not happen as cache should exist
    const rebuilt = await this.buildStatisticsSnapshot(now);
    await this.statisticsCache.saveSnapshot(rebuilt);
    this.snapshotRevision = this.revision;
    return rebuilt;
  }

  public async getGeohashCoverageSnapshot(now = Date.now()): Promise<GeohashCoverageSnapshot> {
    const { snapshot, pending } = await this.geohashCoverageCache.readWithStatus(now);
    if (snapshot) {
      return pending ? { ...snapshot, pending: true } : snapshot;
    }

    return { generatedAt: new Date(now).toISOString(), geohashCoverage: [], pending: true };
  }

  public async getCacheCoverageSnapshot(now = Date.now()): Promise<CacheCoverageSnapshot> {
    const { snapshot, pending } = await this.cacheCoverageCache.readWithStatus(now);
    if (snapshot) {
      return pending ? { ...snapshot, pending: true } : snapshot;
    }

    return { generatedAt: new Date(now).toISOString(), cacheCoverage: [], pending: true };
  }

  public async refreshCoverageCaches(now = Date.now()): Promise<void> {
    const [cacheCoverage, geohashCoverage] = await Promise.all([
      this.buildCacheCoverageSnapshot(now),
      this.buildGeohashCoverageSnapshot(now)
    ]);

    await Promise.all([
      this.cacheCoverageCache.saveSnapshot(cacheCoverage),
      this.geohashCoverageCache.saveSnapshot(geohashCoverage)
    ]);
  }

  private async buildStatisticsSnapshot(now = Date.now()): Promise<StatisticsSnapshot> {
    return this.runExclusive(async () => {
      logger.info(
        {
          memory: reportMemoryUsage(),
          amenityCount: this.amenityStats.size,
          uniqueClients: this.uniqueClients.size
        },
        'statistics snapshot build started'
      );
      this.refreshPeriodCounters(now);

      const generatedAt = new Date(now).toISOString();
      const dayStartIso = new Date(this.dayStart).toISOString();
      const weekStartIso = new Date(this.weekStart).toISOString();
      const monthStartIso = new Date(this.monthStart).toISOString();

      const amenities: AmenityStatistics[] = [];
      let globalGeohashCounts = new Map<string, number>();
      let amenityCounter = 0;

      for (const stats of this.amenityStats.values()) {
        const cacheItems = this.cacheMetrics.countCachedTiles(stats.amenity);
        for (const [hash, count] of stats.geohashCounts) {
          globalGeohashCounts.set(hash, (globalGeohashCounts.get(hash) ?? 0) + count);
        }

        if (globalGeohashCounts.size > this.geohashCoverageCompactionThreshold) {
          globalGeohashCounts = this.compactGeohashCounts(globalGeohashCounts);
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

        amenityCounter += 1;
        if (amenityCounter % COVERAGE_YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
      }

      amenities.sort((a, b) => b.requests - a.requests || a.amenity.localeCompare(b.amenity));

      globalGeohashCounts = this.compactGeohashCounts(globalGeohashCounts);

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
      const staleRefreshQueue = this.staleRefreshQueue?.describeQueue();

      // Calculate total stale tiles from cache coverage
      // Wrap in try-catch to prevent hangs from blocking the entire snapshot
      let totalStaleTiles = 0;
      try {
        const cacheCoverageStart = Date.now();
        const cacheCoverage = this.cacheMetrics.getCacheCoverage({
          maxEntries: this.maxCacheCoverageEntries
        });
        const cacheCoverageDuration = Date.now() - cacheCoverageStart;
        if (cacheCoverageDuration > 30000) {
          logger.warn(
            {
              durationMs: cacheCoverageDuration,
              entries: cacheCoverage.length
            },
            'getCacheCoverage took longer than expected'
          );
        }
        totalStaleTiles = cacheCoverage.reduce((sum, entry) => sum + (entry.staleEntries ?? 0), 0);
      } catch (error) {
        logger.warn(
          { err: error },
          'failed to get cache coverage for statistics snapshot, using 0 for totalStaleTiles'
        );
        totalStaleTiles = 0;
      }

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
        totalStaleTiles,
        cachedAmenities: this.cacheMetrics.countCachedAmenities(),
        cachedAmenityTypes: this.cacheMetrics.countCachedAmenityTypes(),
        cacheHitRate,
        averageTilesPerRequest,
        cacheStatus: { ...this.cacheStatusCounts },
        hotspots,
        amenities,
        upstreams,
        staleRefreshQueue
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

  private async aggregateCacheCoverage(
    entries: Iterable<CacheCoverageEntry>
  ): Promise<CacheCoverageEntry[]> {
    let coverage = new Map<string, CacheCoverageEntry>();
    let processed = 0;

    for (const entry of entries) {
      coverage.set(entry.geohash, mergeCacheCoverageEntry(coverage.get(entry.geohash), entry));
      processed += 1;

      if (coverage.size > this.cacheCoverageCompactionThreshold) {
        coverage = compactCoverageGeohashMap(
          coverage,
          this.maxCacheCoverageEntries,
          mergeCacheCoverageForHash
        );
      }

      if (processed % COVERAGE_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    coverage = compactCoverageGeohashMap(coverage, this.maxCacheCoverageEntries, mergeCacheCoverageForHash);

    return [...coverage.values()].sort(
      (a, b) => b.entries - a.entries || a.geohash.localeCompare(b.geohash)
    );
  }

  private compactGeohashCounts(counts: Map<string, number>): Map<string, number> {
    return compactCoverageGeohashMap(counts, this.maxGeohashCoverageEntries, mergeGeohashCount);
  }

  private async buildCacheCoverageSnapshot(now = Date.now()): Promise<CacheCoverageSnapshot> {
    const start = Date.now();
    const storedRevision = await this.snapshotStore.get(CACHE_COVERAGE_REVISION_KEY);
    const nextRevision = storedRevision ? Number(storedRevision) : null;
    
    // Only skip rebuild if revision hasn't changed AND we have a recent snapshot
    // This allows periodic rebuilds to catch tiles that became stale over time
    const timeSinceLastBuild = this.cacheCoverageLastBuiltAt ? now - this.cacheCoverageLastBuiltAt : Infinity;
    const shouldSkipRebuild =
      Number.isFinite(nextRevision) &&
      this.cacheCoverageSnapshot &&
      this.cacheCoverageRevision === nextRevision &&
      timeSinceLastBuild < this.coverageRefreshIntervalMs;
    
    if (shouldSkipRebuild) {
      return this.cacheCoverageSnapshot!;
    }
    
    const generatedAt = new Date(now).toISOString();
    logger.info({ memory: reportMemoryUsage() }, 'cache coverage snapshot build started');
    const coverageEntries = this.cacheMetrics.getCacheCoverage({
      maxEntries: this.maxCacheCoverageEntries
    });
    logger.info(
      { memory: reportMemoryUsage(), inputEntries: coverageEntries.length },
      'cache coverage snapshot input loaded'
    );
    const cacheCoverage = await this.aggregateCacheCoverage(coverageEntries);

    logger.info(
      {
        inputEntries: coverageEntries.length,
        outputEntries: cacheCoverage.length,
        maxEntries: this.maxCacheCoverageEntries,
        compactionThreshold: this.cacheCoverageCompactionThreshold,
        durationMs: Date.now() - start
      },
      'cache coverage snapshot built'
    );

    const snapshot = { generatedAt, cacheCoverage };
    if (Number.isFinite(nextRevision)) {
      this.cacheCoverageRevision = nextRevision;
    }
    this.cacheCoverageSnapshot = snapshot;
    this.cacheCoverageLastBuiltAt = now;
    return snapshot;
  }

  private async captureGeohashCoverageState(_now: number): Promise<AmenityCoverageState[]> {
    return this.runExclusive(async () => {
      return [...this.amenityStats.values()].map((stats) => ({
        amenity: stats.amenity,
        requests: stats.requests,
        geohashCounts: [...stats.geohashCounts.entries()]
      }));
    });
  }

  private async buildGeohashCoverageSnapshot(now = Date.now()): Promise<GeohashCoverageSnapshot> {
    const start = Date.now();
    logger.info({ memory: reportMemoryUsage() }, 'geohash coverage snapshot build started');
    const amenityState = await this.captureGeohashCoverageState(now);
    logger.info(
      { memory: reportMemoryUsage(), ...summarizeAmenityState(amenityState) },
      'geohash coverage snapshot input captured'
    );
    const { amenityCoverage } = await this.buildGeohashCoverage(amenityState);
    const generatedAt = new Date(now).toISOString();

    logger.info(
      {
        amenityCount: amenityState.length,
        outputEntries: amenityCoverage.reduce((total, entry) => total + entry.geohashCoverage.length, 0),
        maxEntries: this.maxGeohashCoverageEntries,
        compactionThreshold: this.geohashCoverageCompactionThreshold,
        durationMs: Date.now() - start
      },
      'geohash coverage snapshot built'
    );

    return { generatedAt, geohashCoverage: amenityCoverage };
  }

  private async buildGeohashCoverage(
    amenityState: AmenityCoverageState[]
  ): Promise<{
    amenityCoverage: AmenityGeohashCoverage[];
    globalGeohashCounts: Map<string, number>;
  }> {
    const amenityCoverageWithCounts: Array<AmenityGeohashCoverage & { requests: number }> = [];
    let globalGeohashCounts = new Map<string, number>();

    let amenityCounter = 0;
    for (const stats of amenityState) {
      const geohashCoverage: GeohashCoverageEntry[] = [];

      let coverageCounter = 0;
      let amenityCounts = new Map<string, number>();
      for (const [hash, count] of stats.geohashCounts) {
        amenityCounts.set(hash, (amenityCounts.get(hash) ?? 0) + count);

        coverageCounter += 1;
        if (amenityCounts.size > this.geohashCoverageCompactionThreshold) {
          amenityCounts = this.compactGeohashCounts(amenityCounts);
        }

        if (coverageCounter % COVERAGE_YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
      }

      amenityCounts = this.compactGeohashCounts(amenityCounts);

      for (const [hash, count] of amenityCounts) {
        const percentage = stats.requests > 0 ? (count / stats.requests) * 100 : 0;
        geohashCoverage.push({
          geohash: hash,
          percentage: Number(percentage.toFixed(2)),
          requests: count
        });
        globalGeohashCounts.set(hash, (globalGeohashCounts.get(hash) ?? 0) + count);
      }

      geohashCoverage.sort((a, b) => b.requests - a.requests);

      if (globalGeohashCounts.size > this.geohashCoverageCompactionThreshold) {
        globalGeohashCounts = this.compactGeohashCounts(globalGeohashCounts);
      }

      amenityCoverageWithCounts.push({
        amenity: stats.amenity,
        geohashCoverage,
        requests: stats.requests
      });

      amenityCounter += 1;
      if (amenityCounter % COVERAGE_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    globalGeohashCounts = this.compactGeohashCounts(globalGeohashCounts);

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

export type StatsWorkerCommand =
  | { type: 'record'; payload: RecordRequestOptions }
  | { type: 'refresh'; target: StatisticsRefreshTarget }
  | { type: 'markDirty'; target: StatisticsRefreshTarget }
  | { type: 'staleRefreshUpdate'; overview: StaleRefreshQueueOverview }
  | {
      type: 'staleRefreshTask';
      amenity: string;
      groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>;
      planOptions: {
        coarsePrecision: number;
        finePrecision: number;
        targetTilesPerRequest?: number;
      };
      statsPayload: RecordRequestOptions;
    };

export type StatsWorkerNotification = { type: 'ready' };

export type StatisticsRefreshTarget =
  | 'all'
  | 'statistics'
  | 'cacheCoverage'
  | 'geohashCoverage';

type RefreshThrottleTarget = Exclude<StatisticsRefreshTarget, 'all'>;

const REFRESH_THROTTLE_TARGETS: RefreshThrottleTarget[] = [
  'statistics',
  'cacheCoverage',
  'geohashCoverage'
];

export interface StatisticsWorkerOptions {
  config: AppConfig;
  redis: Redis;
  redisUrl: string;
  coverageRefreshIntervalMs?: number;
  coverageCacheTtlMs?: number;
  maxCacheCoverageEntries?: number;
  maxGeohashCoverageEntries?: number;
  workerPath?: URL;
  useWorker?: boolean;
}

export class StatisticsWorkerClient {
  private readonly worker: Worker | null;

  private readonly readyPromise: Promise<void>;

  private readonly snapshotStore: SnapshotCacheStore;

  private readonly refreshIntervalMs: number;

  private readonly useWorker: boolean;

  private inlineStatistics: RequestStatistics | null = null;

  private inlineStaleRefreshMetrics: SharedStaleRefreshMetrics | null = null;

  private inlineStaleRefreshQueue: StaleRefreshQueue | null = null;

  private inlineStore: TileStore | null = null;

  private readonly config: AppConfig;

  private readonly redis: Redis;

  private pendingRecordPosts = 0;

  private readonly refreshCooldownMs = MIN_REFRESH_TRIGGER_INTERVAL_MS;

  private readonly lastRefreshTriggerAt: Record<RefreshThrottleTarget, number> = {
    statistics: 0,
    cacheCoverage: 0,
    geohashCoverage: 0
  };

  private readonly suppressedRefreshCount: Record<RefreshThrottleTarget, number> = {
    statistics: 0,
    cacheCoverage: 0,
    geohashCoverage: 0
  };

  constructor(options: StatisticsWorkerOptions) {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const workerScript =
      options.workerPath ?? new URL(`./statsWorker.${extension}`, import.meta.url);

    this.config = options.config;
    this.redis = options.redis;

    this.refreshIntervalMs =
      options.coverageRefreshIntervalMs ?? DEFAULT_COVERAGE_REFRESH_INTERVAL_MS;
    this.snapshotStore = new SnapshotCacheStore(options.redis);
    this.useWorker =
      options.useWorker ??
      options.redis instanceof (IORedis as unknown as new (...args: never[]) => Redis);

    if (!this.useWorker) {
      this.worker = null;
      this.readyPromise = this.startInline(options);
      return;
    }

    const workerData = {
      config: options.config,
      redisUrl: options.redisUrl,
      coverageRefreshIntervalMs: options.coverageRefreshIntervalMs,
      coverageCacheTtlMs: options.coverageCacheTtlMs,
      maxCacheCoverageEntries: options.maxCacheCoverageEntries,
      maxGeohashCoverageEntries: options.maxGeohashCoverageEntries
    };

    if (extension === 'ts' && !options.workerPath) {
      const loaderPreamble = `import { register } from 'tsx/esm/api'; register(); await import(${JSON.stringify(
        workerScript.href
      )});`;
      const workerOptions: WorkerOptions & { type: 'module'; eval: true } = {
        workerData,
        type: 'module',
        eval: true
      };
      this.worker = new Worker(loaderPreamble, workerOptions);
    } else {
      const execArgv = extension === 'ts' ? [...process.execArgv, '--import', 'tsx'] : undefined;
      const workerOptions: WorkerOptions & { type: 'module'; execArgv?: string[] } = {
        workerData,
        type: 'module',
        execArgv
      };
      this.worker = new Worker(workerScript, workerOptions);
    }

    this.worker.on('error', (error) => {
      logger.error({ err: error }, 'statistics worker errored');
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error({ code }, 'statistics worker exited unexpectedly');
      }
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const handleMessage = (message: StatsWorkerNotification) => {
        if (message?.type === 'ready') {
          resolve();
        }
      };

      this.worker!.once('message', handleMessage);
      this.worker!.once('error', (error) => reject(error));
      this.worker!.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`statistics worker exited with code ${code}`));
        }
      });
    });
  }

  public ready(): Promise<void> {
    return this.readyPromise;
  }

  private async startInline(options: StatisticsWorkerOptions): Promise<void> {
    this.inlineStaleRefreshMetrics = new SharedStaleRefreshMetrics();
    this.inlineStaleRefreshQueue = new StaleRefreshQueue();
    const store = new TileStore(options.redis, {
      ttlSeconds: options.config.cacheTtlSeconds,
      swrSeconds: options.config.swrSeconds
    });
    this.inlineStore = store;

    await store.restorePresence();
    const { createUpstreamMetricsProvider } = await import('./upstream.js');
    const upstreamMetrics = await createUpstreamMetricsProvider(options.config, options.redis);

    this.inlineStatistics = await RequestStatistics.create(
      store,
      new RedisStatisticsStorage(options.redis),
      upstreamMetrics,
      {
        redis: options.redis,
        staleRefreshQueue: this.inlineStaleRefreshMetrics,
        coverageRefreshIntervalMs: options.coverageRefreshIntervalMs,
        coverageCacheTtlMs: options.coverageCacheTtlMs,
        maxCacheCoverageEntries: options.maxCacheCoverageEntries,
        maxGeohashCoverageEntries: options.maxGeohashCoverageEntries
      }
    );

    this.inlineStaleRefreshQueue.onUpdate(() => {
      const overview = this.inlineStaleRefreshQueue?.describeQueue();
      if (overview) {
        this.inlineStaleRefreshMetrics?.update(overview);
      }
    });
  }

  private static parseSnapshotAgeMs(
    snapshot: { generatedAt: string } | null,
    now: number
  ): number | undefined {
    if (!snapshot) {
      return undefined;
    }
    const generatedAt = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedAt)) {
      return undefined;
    }
    return Math.max(0, now - generatedAt);
  }

  private getAffectedRefreshTargets(target: StatisticsRefreshTarget): RefreshThrottleTarget[] {
    switch (target) {
      case 'statistics':
        return ['statistics'];
      case 'cacheCoverage':
      case 'geohashCoverage':
        return ['cacheCoverage', 'geohashCoverage'];
      case 'all':
      default:
        return REFRESH_THROTTLE_TARGETS;
    }
  }

  private consumeRefreshBudget(
    target: StatisticsRefreshTarget,
    now: number
  ): { allowed: boolean; waitMs: number; affectedTargets: RefreshThrottleTarget[] } {
    const affectedTargets = this.getAffectedRefreshTargets(target);
    let waitMs = 0;

    for (const affectedTarget of affectedTargets) {
      const nextAllowedAt = this.lastRefreshTriggerAt[affectedTarget] + this.refreshCooldownMs;
      if (now < nextAllowedAt) {
        waitMs = Math.max(waitMs, nextAllowedAt - now);
      }
    }

    if (waitMs > 0) {
      for (const affectedTarget of affectedTargets) {
        this.suppressedRefreshCount[affectedTarget] += 1;
      }
      return { allowed: false, waitMs, affectedTargets };
    }

    for (const affectedTarget of affectedTargets) {
      this.lastRefreshTriggerAt[affectedTarget] = now;
      this.suppressedRefreshCount[affectedTarget] = 0;
    }

    return { allowed: true, waitMs: 0, affectedTargets };
  }

  public recordRequest(payload: RecordRequestOptions): void {
    if (!this.useWorker) {
      void this.readyPromise
        .then(() => this.inlineStatistics?.recordRequest(payload))
        .catch((error) => {
          logger.warn({ err: error }, 'failed to record request in inline statistics worker');
        });
      return;
    }

    this.pendingRecordPosts += 1;
    void this.readyPromise
      .then(() => {
        const command: StatsWorkerCommand = { type: 'record', payload };
        if (!this.worker) {
          logger.warn('statistics worker not initialized');
          return;
        }
        this.worker.postMessage(command);
      })
      .catch((error) => {
        logger.warn({ err: error }, 'failed to post record command to statistics worker');
      })
      .finally(() => {
        this.pendingRecordPosts = Math.max(0, this.pendingRecordPosts - 1);
      });
  }

  public refresh(
    target: StatisticsRefreshTarget = 'all',
    reason = 'manual',
    metadata: Record<string, unknown> = {}
  ): void {
    const now = Date.now();
    const budget = this.consumeRefreshBudget(target, now);
    if (!budget.allowed) {
      const primaryTarget = budget.affectedTargets[0];
      if (
        primaryTarget &&
        (this.suppressedRefreshCount[primaryTarget] === 1 ||
          this.suppressedRefreshCount[primaryTarget] % 25 === 0)
      ) {
        logger.warn(
          {
            target,
            affectedTargets: budget.affectedTargets,
            reason,
            waitMs: budget.waitMs,
            cooldownMs: this.refreshCooldownMs,
            suppressedCount: this.suppressedRefreshCount[primaryTarget],
            ...metadata
          },
          'statistics refresh request skipped due to cooldown'
        );
      }
      return;
    }

    if (!this.useWorker) {
      void this.readyPromise
        .then(async () => {
          if (!this.inlineStatistics) return;
          switch (target) {
            case 'statistics':
              this.inlineStatistics.markStatisticsDirty();
              await this.inlineStatistics.getSnapshot();
              return;
            case 'cacheCoverage':
            case 'geohashCoverage':
              this.inlineStatistics.markCacheCoverageDirty();
              this.inlineStatistics.markGeohashCoverageDirty();
              await this.inlineStatistics.refreshCoverageCaches();
              return;
            case 'all':
            default:
              this.inlineStatistics.markStatisticsDirty();
              this.inlineStatistics.markCacheCoverageDirty();
              this.inlineStatistics.markGeohashCoverageDirty();
              await Promise.all([
                this.inlineStatistics.getSnapshot(),
                this.inlineStatistics.refreshCoverageCaches()
              ]);
          }
        })
        .catch((error) => {
          logger.warn({ err: error, target, reason, ...metadata }, 'failed to refresh inline statistics');
        });
      return;
    }

    void this.readyPromise
      .then(() => {
        const command: StatsWorkerCommand = { type: 'refresh', target };
        if (!this.worker) {
          logger.warn('statistics worker not initialized');
          return;
        }
        this.worker.postMessage(command);
      })
      .catch((error) => {
        logger.warn(
          { err: error, target, reason, ...metadata },
          'failed to post refresh command to statistics worker'
        );
      });
  }

  public markDirty(target: StatisticsRefreshTarget = 'all'): void {
    if (!this.useWorker) {
      void this.readyPromise
        .then(() => {
          if (!this.inlineStatistics) return;
          switch (target) {
            case 'statistics':
              this.inlineStatistics.markStatisticsDirty();
              return;
            case 'cacheCoverage':
              this.inlineStatistics.markCacheCoverageDirty();
              return;
            case 'geohashCoverage':
              this.inlineStatistics.markGeohashCoverageDirty();
              return;
            case 'all':
            default:
              this.inlineStatistics.markStatisticsDirty();
              this.inlineStatistics.markCacheCoverageDirty();
              this.inlineStatistics.markGeohashCoverageDirty();
          }
        })
        .catch((error) => {
          logger.warn({ err: error }, 'failed to mark inline statistics dirty');
        });
      return;
    }

    void this.readyPromise
      .then(() => {
        const command: StatsWorkerCommand = { type: 'markDirty', target };
        if (!this.worker) {
          logger.warn('statistics worker not initialized');
          return;
        }
        this.worker.postMessage(command);
      })
      .catch((error) => {
        logger.warn({ err: error }, 'failed to post mark dirty command to statistics worker');
      });
  }

  public markCacheCoverageDirty(): void {
    this.markDirty('cacheCoverage');
  }

  public markGeohashCoverageDirty(): void {
    this.markDirty('geohashCoverage');
  }

  public markStatisticsDirty(): void {
    this.markDirty('statistics');
  }

  public enqueueStaleRefreshTask(task: {
    amenity: string;
    groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>;
    statsPayload: RecordRequestOptions;
  }): void {
    const planOptions = {
      coarsePrecision: this.config.staleRefreshCoarsePrecision,
      finePrecision: this.config.tilePrecision,
      targetTilesPerRequest: this.config.staleRefreshTargetTilesPerRequest
    };

    if (!this.useWorker) {
      void this.readyPromise
        .then(() =>
          this.inlineStaleRefreshQueue?.enqueue({
            amenity: task.amenity,
            groups: task.groups,
            planOptions,
            run: async (groups) => {
              await this.runStaleRefreshTask({ amenity: task.amenity, groups });
            },
            onSettled: async () => {
              await this.inlineStatistics?.recordRequest(task.statsPayload);
            }
          })
        )
        .catch((error) => {
          logger.warn({ err: error }, 'failed to enqueue inline stale refresh task');
        });
      return;
    }

    void this.readyPromise
      .then(() => {
        const command: StatsWorkerCommand = {
          type: 'staleRefreshTask',
          amenity: task.amenity,
          groups: task.groups,
          planOptions,
          statsPayload: task.statsPayload
        };
        this.worker?.postMessage(command);
      })
      .catch((error) => {
        logger.warn({ err: error }, 'failed to post stale refresh task to statistics worker');
      });
  }

  public updateStaleRefreshOverview(overview: StaleRefreshQueueOverview): void {
    if (!this.useWorker) {
      this.inlineStaleRefreshMetrics?.update(overview);
      return;
    }

    void this.readyPromise
      .then(() => {
        const command: StatsWorkerCommand = { type: 'staleRefreshUpdate', overview };
        if (!this.worker) {
          logger.warn('statistics worker not initialized');
          return;
        }
        this.worker.postMessage(command);
      })
      .catch((error) => {
        logger.warn({ err: error }, 'failed to post stale refresh overview to statistics worker');
      });
  }

  public getPendingRecordPosts(): number {
    return this.pendingRecordPosts;
  }

  public async getStatisticsSnapshot(now = Date.now()): Promise<{
    snapshot: StatisticsSnapshot | null;
    pending: boolean;
  }> {
    if (!this.useWorker) {
      await this.readyPromise;
      const snapshot = await this.inlineStatistics?.getSnapshot(now);
      return { snapshot: snapshot ?? null, pending: false };
    }

    const result = await readCachedSnapshot<StatisticsSnapshot>(
      this.snapshotStore,
      STATISTICS_SNAPSHOT_KEY,
      now,
      { refreshIntervalMs: this.refreshIntervalMs }
    );

    if (result.pending) {
      const ageMs = StatisticsWorkerClient.parseSnapshotAgeMs(result.snapshot, now);
      this.refresh('statistics', 'statistics snapshot pending', ageMs !== undefined ? { ageMs } : {});
    }

    return result;
  }

  public async getCacheCoverageSnapshot(now = Date.now()): Promise<CacheCoverageSnapshot> {
    if (!this.useWorker) {
      await this.readyPromise;
      const snapshot = await this.inlineStatistics?.getCacheCoverageSnapshot(now);
      return snapshot ?? { generatedAt: new Date(now).toISOString(), cacheCoverage: [], pending: true };
    }

    const result = await readCachedSnapshot<CacheCoverageSnapshot>(
      this.snapshotStore,
      CACHE_COVERAGE_SNAPSHOT_KEY,
      now,
      { refreshIntervalMs: this.refreshIntervalMs }
    );

    if (result.pending) {
      const ageMs = StatisticsWorkerClient.parseSnapshotAgeMs(result.snapshot, now);
      this.refresh('cacheCoverage', 'cache coverage snapshot pending', ageMs !== undefined ? { ageMs } : {});
    }

    if (result.snapshot) {
      return result.pending ? { ...result.snapshot, pending: true } : result.snapshot;
    }

    return { generatedAt: new Date(now).toISOString(), cacheCoverage: [], pending: true };
  }

  public async getGeohashCoverageSnapshot(now = Date.now()): Promise<GeohashCoverageSnapshot> {
    if (!this.useWorker) {
      await this.readyPromise;
      const snapshot = await this.inlineStatistics?.getGeohashCoverageSnapshot(now);
      return snapshot ?? { generatedAt: new Date(now).toISOString(), geohashCoverage: [], pending: true };
    }

    const result = await readCachedSnapshot<GeohashCoverageSnapshot>(
      this.snapshotStore,
      GEOHASH_COVERAGE_SNAPSHOT_KEY,
      now,
      { refreshIntervalMs: this.refreshIntervalMs }
    );

    if (result.pending) {
      const ageMs = StatisticsWorkerClient.parseSnapshotAgeMs(result.snapshot, now);
      this.refresh(
        'geohashCoverage',
        'geohash coverage snapshot pending',
        ageMs !== undefined ? { ageMs } : {}
      );
    }

    if (result.snapshot) {
      return result.pending ? { ...result.snapshot, pending: true } : result.snapshot;
    }

    return { generatedAt: new Date(now).toISOString(), geohashCoverage: [], pending: true };
  }

  public async stop(): Promise<void> {
    await this.readyPromise.catch(() => {});
    if (this.worker) {
      await this.worker.terminate();
    }
  }

  private async runStaleRefreshTask(task: {
    amenity: string;
    groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>;
  }): Promise<void> {
    if (!this.inlineStatistics || !this.inlineStore) {
      return;
    }

    const { fetchTile } = await import('./upstream.js');
    const { filterElementsByBbox } = await import('./store.js');

    for (const group of task.groups) {
      const representative = group.tiles[0];
      if (!representative) continue;

      await this.inlineStore
        .withRefreshLock(representative, task.amenity, async () => {
          const response = await fetchTile(this.config, group.bounds, task.amenity, {
            redis: this.redis
          });
          const entries = group.tiles.map((fine) => ({
            tile: fine,
            response: { ...response, elements: filterElementsByBbox(response.elements, fine.bounds) }
          }));
          await this.inlineStore?.writeTiles(entries, task.amenity);
        })
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to run inline stale refresh task');
        });
    }

    this.inlineStatistics.markCacheCoverageDirty();
  }
}
