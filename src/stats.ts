import IORedis, { type Redis } from 'ioredis';
import ngeohash from 'ngeohash';
import { setImmediate as setImmediateCallback } from 'node:timers';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import { DistinctCounter } from './distinctCounter.js';
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
import { StatsAggregation, type StatsBatch } from './statsAggregation.js';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface CacheMetricsProvider {
  refreshMetrics?(): Promise<void>;
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
  clients: DistinctCounter;
  geohashCounts: Map<string, number>;
  geohashPrecision: number;
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
  clientCountApproximate?: boolean;
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
  clientCountsApproximate?: boolean;
  groupedAmenities?: boolean;
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
const BUILD_TIMESLICE_MS = 8;
export const DEFAULT_CACHE_COVERAGE_MAX_ENTRIES = 25000;
export const DEFAULT_GEOHASH_COVERAGE_MAX_ENTRIES = 10000;
export const COMPACTION_THRESHOLD_MULTIPLIER = 1.25;
const MIN_STATS_COVERAGE_GEOHASH_PRECISION = 3;

export const STATISTICS_SNAPSHOT_KEY = 'statistics:snapshot';
export const CACHE_COVERAGE_SNAPSHOT_KEY = 'statistics:cacheCoverageSnapshot';
export const GEOHASH_COVERAGE_SNAPSHOT_KEY = 'statistics:geohashCoverageSnapshot';
const MIN_REFRESH_TRIGGER_INTERVAL_MS = 5_000;
const envInteger = (name: string, fallback: number, minimum = 0): number => {
  const parsed = Number(process.env[name]);
  return Math.max(minimum, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
};

const yieldToEventLoop = async (): Promise<void> =>
  new Promise((resolve) => setImmediateCallback(resolve));

class YieldController {
  private nextYieldDeadline = Date.now() + BUILD_TIMESLICE_MS;

  public async maybeYield(): Promise<void> {
    if (Date.now() < this.nextYieldDeadline) {
      return;
    }

    await yieldToEventLoop();
    this.nextYieldDeadline = Date.now() + BUILD_TIMESLICE_MS;
  }
}

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

  private lastGeneratedAt: number | null = null;

  private lastAttemptAt: number | null = null;

  private lastCompletedAt: number | null = null;

  private dirty = false;

  private refreshFailureCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: SnapshotCacheStore,
    private readonly key: string,
    private readonly builder: (now?: number) => Promise<T>,
    private readonly ttlMs: number,
    private readonly refreshIntervalMs: number,
    private readonly label: string,
    private readonly buildGate: SnapshotBuildGate
  ) {
  }

  public start(): void {
    if (this.refreshIntervalMs > 0) {
      this.timer = setInterval(() => this.maybeRefresh(), this.refreshIntervalMs);
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async refresh(now?: number): Promise<boolean> {
    if (!this.isDueToRefresh(Date.now())) return false;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.buildAndStore(now);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  public isRefreshDue(now = Date.now()): boolean {
    return this.isDueToRefresh(now);
  }

  public async buildInitial(now: number): Promise<T> {
    return this.buildGate.run(this.key, async () => {
      this.lastAttemptAt = Date.now();
      const snapshot = await this.builder(now);
      await this.storeSnapshot(snapshot);
      return snapshot;
    });
  }

  public hasBuildInFlight(): boolean {
    return this.buildGate.hasInFlight(this.key);
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
    
    if (stale && !options.skipRefresh) {
      this.maybeRefresh();
    }

    return { snapshot, pending: stale || this.dirty || this.refreshPromise !== null || snapshot === null };
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
        // Reading an old persisted snapshot must not cancel an explicit rebuild request.
      }
      return parsed;
    } catch (error) {
      logger.warn({ err: error, key: this.key }, 'failed to parse cached statistics snapshot');
      return null;
    }
  }

  private async buildAndStore(now?: number): Promise<boolean> {
    const startTime = Date.now();
    try {
      await this.buildGate.run(this.key, async () => {
        this.lastAttemptAt = Date.now();
        const built = await this.builder(now);
        await this.storeSnapshot(built);
        return built;
      });
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
    this.lastCompletedAt = Date.now();
  }

  private isStale(now: number): boolean {
    if (!this.lastGeneratedAt) {
      return true;
    }
    if (this.refreshIntervalMs <= 0) return this.dirty;
    return this.isDueToRefresh(now);
  }

  private isDueToRefresh(now: number): boolean {
    if (this.refreshIntervalMs <= 0) return true;
    const latestRefresh = Math.max(
      this.lastGeneratedAt ?? 0,
      this.lastAttemptAt ?? 0,
      this.lastCompletedAt ?? 0
    );
    return latestRefresh === 0 || now - latestRefresh >= this.refreshIntervalMs;
  }

  private maybeRefresh(): void {
    if (!this.isStale(Date.now()) || !this.isDueToRefresh(Date.now())) {
      return;
    }
    if (this.refreshPromise) return;

    this.refreshPromise = this.buildAndStore().finally(() => {
      this.refreshPromise = null;
    });
  }

  private currentSnapshotAgeMs(now = Date.now()): number | undefined {
    if (!this.lastGeneratedAt) {
      return undefined;
    }
    return Math.max(0, now - this.lastGeneratedAt);
  }
}

class SnapshotBuildGate {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  public run<T>(key: string, build: () => Promise<T>): Promise<T> {
    const current = this.inFlight.get(key) as Promise<T> | undefined;
    if (current) return current;
    const result = this.tail.then(build);
    const settled = result.then(() => undefined, () => undefined);
    this.tail = settled;
    this.inFlight.set(key, result);
    void result.finally(() => {
      if (this.inFlight.get(key) === result) this.inFlight.delete(key);
    }).catch(() => undefined);
    return result;
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
  clientSketch?: string;
  geohashCounts: Array<[string, number]>;
  geohashPrecision?: number;
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
  uniqueClientSketch?: string;
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
  maxTrackedAmenities?: number;
  maxRequestGeohashEntries?: number;
  maxTotalRequestGeohashEntries?: number;
  persistenceIntervalMs?: number;
  snapshotRefreshIntervalMs?: number;
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

  private uniqueClients = new DistinctCounter();

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

  private readonly maxTrackedAmenities: number;
  private readonly maxRequestGeohashEntries: number;
  private readonly maxTotalRequestGeohashEntries: number;
  private requestGeohashPrecision = 12;
  private readonly persistenceIntervalMs: number;
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;
  private persistenceDirty = false;
  private persistenceFlushPromise: Promise<void> | null = null;
  private readonly snapshotBuildGate = new SnapshotBuildGate();
  private readonly recentBatchIds = new Set<string>();
  private statisticsRefreshQueued = false;

  private revision = 0;

  private cacheCoverageRevision: number | null = null;

  private cacheCoverageSnapshot: CacheCoverageSnapshot | null = null;

  private cacheCoverageLastBuiltAt: number | null = null;

  private totalStaleTiles = 0;

  private readonly coverageRefreshIntervalMs: number;

  private constructor(
    private readonly cacheMetrics: CacheMetricsProvider,
    private readonly storage: StatisticsStorage,
    private readonly upstreamMetrics?: UpstreamMetricsProvider,
    options: RequestStatisticsOptions = {}
  ) {
    this.staleRefreshQueue = options.staleRefreshQueue;
    this.maxTrackedAmenities = Math.max(1, Math.floor(options.maxTrackedAmenities ?? 256));
    this.maxRequestGeohashEntries = Math.max(32, Math.floor(options.maxRequestGeohashEntries ?? 2048));
    this.maxTotalRequestGeohashEntries = Math.max(
      32 * (this.maxTrackedAmenities + 1),
      Math.floor(options.maxTotalRequestGeohashEntries ?? 20000)
    );
    this.persistenceIntervalMs = Math.max(0, Math.floor(options.persistenceIntervalMs ?? 0));
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
      (at) => this.buildCacheCoverageSnapshot(at),
      cacheTtlMs,
      refreshIntervalMs,
      'cache-coverage',
      this.snapshotBuildGate
    );
    this.geohashCoverageCache = new SnapshotCache(
      this.snapshotStore,
      GEOHASH_COVERAGE_SNAPSHOT_KEY,
      (at) => this.buildGeohashCoverageSnapshot(at),
      cacheTtlMs,
      refreshIntervalMs,
      'geohash-coverage',
      this.snapshotBuildGate
    );
    this.statisticsCache = new SnapshotCache(
      this.snapshotStore,
      STATISTICS_SNAPSHOT_KEY,
      (at) => this.buildStatisticsSnapshot(at),
      cacheTtlMs,
      options.snapshotRefreshIntervalMs ?? 0,
      'statistics',
      this.snapshotBuildGate
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
    if (stats.persistenceIntervalMs > 0) {
      stats.persistenceTimer = setInterval(() => {
        void stats.flushPersistence().catch((error) => {
          logger.warn({ err: error }, 'failed to flush request statistics persistence');
        });
      }, stats.persistenceIntervalMs);
      stats.persistenceTimer.unref();
    }
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
      this.uniqueClients = new DistinctCounter(
        persisted.uniqueClients,
        persisted.uniqueClientSketch
      );
      this.cacheStatusCounts.HIT = persisted.cacheStatusCounts.HIT ?? 0;
      this.cacheStatusCounts.MISS = persisted.cacheStatusCounts.MISS ?? 0;
      this.cacheStatusCounts.STALE = persisted.cacheStatusCounts.STALE ?? 0;
      this.amenityStats.clear();
      for (const amenity of persisted.amenities) {
        const stats: AmenityStatsInternal = {
          amenity: amenity.amenity,
          requests: amenity.requests,
          totalTiles: amenity.totalTiles,
          clients: new DistinctCounter(amenity.clients, amenity.clientSketch),
          geohashCounts: new Map(amenity.geohashCounts),
          geohashPrecision: amenity.geohashPrecision ?? 12,
          cacheStatusCounts: {
            HIT: amenity.cacheStatusCounts.HIT ?? 0,
            MISS: amenity.cacheStatusCounts.MISS ?? 0,
            STALE: amenity.cacheStatusCounts.STALE ?? 0
          },
          lastRequestAt: amenity.lastRequestAt ?? 0
        };
        this.compactRequestGeohashes(stats, true);
        const target = this.getAmenityStats(stats.amenity);
        target.requests += stats.requests;
        target.totalTiles += stats.totalTiles;
        target.clients.merge(stats.clients);
        target.lastRequestAt = Math.max(target.lastRequestAt, stats.lastRequestAt);
        for (const status of ['HIT', 'MISS', 'STALE'] as const) {
          target.cacheStatusCounts[status] += stats.cacheStatusCounts[status];
        }
        target.geohashPrecision = Math.min(target.geohashPrecision, stats.geohashPrecision);
        for (const [hash, count] of stats.geohashCounts) {
          target.geohashCounts.set(hash, (target.geohashCounts.get(hash) ?? 0) + count);
        }
        this.compactRequestGeohashes(target, true);
      }

      this.enforceGlobalRequestGeohashLimit();
      this.revision = persisted.totalRequests ?? 0;
    } catch (error) {
      logger.warn({ err: error }, 'failed to restore request statistics from storage');
    }
  }

  private getAmenityStats(amenity: string): AmenityStatsInternal {
    if (!this.amenityStats.has(amenity) && this.amenityStats.size >= this.maxTrackedAmenities) {
      amenity = '[other amenities]';
    }
    let stats = this.amenityStats.get(amenity);
    if (!stats) {
      stats = {
        amenity,
        requests: 0,
        totalTiles: 0,
        clients: new DistinctCounter(),
        geohashCounts: new Map<string, number>(),
        geohashPrecision: 12,
        cacheStatusCounts: zeroCacheStatus(),
        lastRequestAt: 0
      };
      this.amenityStats.set(amenity, stats);
    }
    return stats;
  }

  private compactRequestGeohashes(stats: AmenityStatsInternal, normalise = false): void {
    if (normalise) {
      const next = new Map<string, number>();
      for (const [hash, count] of stats.geohashCounts) {
        const key = hash.slice(0, stats.geohashPrecision);
        next.set(key, (next.get(key) ?? 0) + count);
      }
      stats.geohashCounts = next;
    }
    // Lower precision permanently so subsequent requests merge into the same cells.
    while (stats.geohashCounts.size > this.maxRequestGeohashEntries && stats.geohashPrecision > 1) {
      stats.geohashPrecision -= 1;
      const next = new Map<string, number>();
      for (const [hash, count] of stats.geohashCounts) {
        const key = hash.slice(0, stats.geohashPrecision);
        next.set(key, (next.get(key) ?? 0) + count);
      }
      stats.geohashCounts = next;
    }
  }

  private enforceGlobalRequestGeohashLimit(): void {
    for (const stats of this.amenityStats.values()) {
      this.requestGeohashPrecision = Math.min(this.requestGeohashPrecision, stats.geohashPrecision);
    }
    for (const stats of this.amenityStats.values()) {
      if (stats.geohashPrecision > this.requestGeohashPrecision) {
        const next = new Map<string, number>();
        for (const [hash, count] of stats.geohashCounts) {
          const key = hash.slice(0, this.requestGeohashPrecision);
          next.set(key, (next.get(key) ?? 0) + count);
        }
        stats.geohashCounts = next;
        stats.geohashPrecision = this.requestGeohashPrecision;
      }
    }
    const totalEntries = (): number => {
      let total = 0;
      for (const stats of this.amenityStats.values()) total += stats.geohashCounts.size;
      return total;
    };
    while (totalEntries() > this.maxTotalRequestGeohashEntries && this.requestGeohashPrecision > 1) {
      this.requestGeohashPrecision -= 1;
      for (const stats of this.amenityStats.values()) {
        const next = new Map<string, number>();
        for (const [hash, count] of stats.geohashCounts) {
          const key = hash.slice(0, this.requestGeohashPrecision);
          next.set(key, (next.get(key) ?? 0) + count);
        }
        stats.geohashCounts = next;
        stats.geohashPrecision = Math.min(stats.geohashPrecision, this.requestGeohashPrecision);
      }
    }
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
      amenityStats.geohashPrecision = Math.min(amenityStats.geohashPrecision, this.requestGeohashPrecision);
      amenityStats.requests += 1;
      amenityStats.totalTiles += options.tileCount;
      amenityStats.clients.add(clientIp);
      amenityStats.cacheStatusCounts[options.cacheStatus] += 1;
      amenityStats.lastRequestAt = now;

      const geohashes =
        options.tiles && options.tiles.length > 0
          ? new Set(options.tiles.map((tile) => tile.hash))
          : new Set<string>([geohashForBoundingBox(options.bbox) ?? undefined].filter(Boolean) as string[]);

      for (const rawHash of geohashes) {
        const geohash = rawHash.slice(0, Math.min(amenityStats.geohashPrecision, this.requestGeohashPrecision));
        amenityStats.geohashCounts.set(
          geohash,
          (amenityStats.geohashCounts.get(geohash) ?? 0) + 1
        );
      }

      this.compactRequestGeohashes(amenityStats);
      this.enforceGlobalRequestGeohashLimit();
      this.revision += 1;

      if (this.persistenceIntervalMs === 0) await this.persist();
      else this.persistenceDirty = true;

      this.geohashCoverageCache.markDirty();
      this.statisticsCache.markDirty();
    });
  }

  public async recordBatch(batch: StatsBatch): Promise<void> {
    await this.runExclusive(async () => {
      if (this.recentBatchIds.has(batch.batchId)) return;
      const period = batch.periods;
      if (period.dayStart >= this.dayStart) {
        if (period.dayStart > this.dayStart) {
          this.dayStart = period.dayStart;
          this.totalRequestsDay = period.dayRequests;
        } else this.totalRequestsDay += period.dayRequests;
      }
      if (period.weekStart >= this.weekStart) {
        if (period.weekStart > this.weekStart) {
          this.weekStart = period.weekStart;
          this.totalRequestsWeek = period.weekRequests;
        } else this.totalRequestsWeek += period.weekRequests;
      }
      if (period.monthStart >= this.monthStart) {
        if (period.monthStart > this.monthStart) {
          this.monthStart = period.monthStart;
          this.totalRequestsMonth = period.monthRequests;
        } else this.totalRequestsMonth += period.monthRequests;
      }
      this.totalRequests += batch.totalRequests;
      this.totalTiles += batch.totalTiles;
      const clients = new DistinctCounter(batch.totalClients.values, batch.totalClients.sketch);
      this.uniqueClients.merge(clients);
      for (const status of ['HIT', 'MISS', 'STALE'] as const) {
        this.cacheStatusCounts[status] += batch.cacheStatusCounts[status] ?? 0;
      }
      for (const delta of batch.amenities) {
        const stats = this.getAmenityStats(delta.amenity);
        stats.requests += delta.requests;
        stats.totalTiles += delta.totalTiles;
        stats.clients.merge(new DistinctCounter(delta.clients.values, delta.clients.sketch));
        stats.lastRequestAt = Math.max(stats.lastRequestAt, delta.lastRequestAt);
        for (const status of ['HIT', 'MISS', 'STALE'] as const) {
          stats.cacheStatusCounts[status] += delta.cacheStatusCounts[status] ?? 0;
        }
        stats.geohashPrecision = Math.min(stats.geohashPrecision, delta.geohashPrecision);
        for (const [hash, count] of delta.geohashCounts) {
          const key = hash.slice(0, Math.min(stats.geohashPrecision, this.requestGeohashPrecision));
          stats.geohashCounts.set(key, (stats.geohashCounts.get(key) ?? 0) + count);
        }
        this.compactRequestGeohashes(stats, true);
      }
      this.enforceGlobalRequestGeohashLimit();
      this.revision += batch.totalRequests;
      this.recentBatchIds.add(batch.batchId);
      if (this.recentBatchIds.size > 1024) {
        const oldest = this.recentBatchIds.values().next().value;
        if (oldest) this.recentBatchIds.delete(oldest);
      }
      if (this.persistenceIntervalMs === 0) await this.persist();
      else this.persistenceDirty = true;
      this.geohashCoverageCache.markDirty();
      this.statisticsCache.markDirty();
    });
  }

  public async flushPersistence(): Promise<void> {
    if (!this.persistenceDirty) return;
    if (this.persistenceFlushPromise) return this.persistenceFlushPromise;
    const flushing = this.runExclusive(async () => {
      if (!this.persistenceDirty) return;
      this.persistenceDirty = !(await this.persist());
    });
    this.persistenceFlushPromise = flushing;
    try { await flushing; } finally {
      if (this.persistenceFlushPromise === flushing) this.persistenceFlushPromise = null;
    }
  }

  public async close(): Promise<void> {
    if (this.persistenceTimer) clearInterval(this.persistenceTimer);
    this.persistenceTimer = null;
    this.cacheCoverageCache.stop();
    this.geohashCoverageCache.stop();
    this.statisticsCache.stop();
    await this.flushPersistence();
  }

  public async dispose(): Promise<void> {
    await this.close();
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
    const needsRefresh = pending;

    // If we have a cached snapshot (even if stale), return it immediately
    // and trigger refresh in background without blocking
    if (snapshot) {
      if (needsRefresh && !this.statisticsRefreshQueued) {
        // Trigger refresh asynchronously without waiting
        this.statisticsRefreshQueued = true;
        setImmediateCallback(() => {
          void this.statisticsCache.refresh().catch((error) => {
            logger.warn({ err: error }, 'failed to refresh statistics snapshot in background');
          }).finally(() => {
            this.statisticsRefreshQueued = false;
          });
        });
      }
      return snapshot;
    }

    if (!this.statisticsCache.isRefreshDue() && !this.statisticsCache.hasBuildInFlight()) {
      return this.buildStatisticsFallback(now);
    }
    try {
      return await this.statisticsCache.buildInitial(now);
    } catch (error) {
      logger.warn({ err: error }, 'failed to build initial statistics snapshot');
      return this.buildStatisticsFallback(now);
    }
  }

  private buildStatisticsFallback(now: number): StatisticsSnapshot {
    let upstreams: UpstreamStatisticsEntry[] = [];
    try {
      upstreams = this.upstreamMetrics?.describeUpstreams() ?? [];
    } catch (error) {
      logger.warn({ err: error }, 'failed to read upstream health for fallback statistics snapshot');
    }
    return {
      generatedAt: new Date(now).toISOString(),
      dayStart: new Date(this.dayStart).toISOString(),
      weekStart: new Date(this.weekStart).toISOString(),
      monthStart: new Date(this.monthStart).toISOString(),
      totalRequests: this.totalRequests,
      totalRequestsDay: this.totalRequestsDay,
      totalRequestsWeek: this.totalRequestsWeek,
      totalRequestsMonth: this.totalRequestsMonth,
      totalUniqueClients: this.uniqueClients.size,
      clientCountsApproximate: this.uniqueClients.sketch() !== undefined,
      groupedAmenities: this.amenityStats.has('[other amenities]'),
      totalTilesRequested: this.totalTiles,
      totalCachedTiles: this.cacheMetrics.countTotalCachedTiles(),
      totalStaleTiles: this.totalStaleTiles,
      cachedAmenities: this.cacheMetrics.countCachedAmenities(),
      cachedAmenityTypes: this.cacheMetrics.countCachedAmenityTypes(),
      cacheHitRate: calculateHitRate(this.cacheStatusCounts, this.totalRequests),
      averageTilesPerRequest: this.totalRequests > 0
        ? Number((this.totalTiles / this.totalRequests).toFixed(2)) : 0,
      cacheStatus: { ...this.cacheStatusCounts },
      hotspots: [],
      amenities: [],
      upstreams,
      staleRefreshQueue: this.staleRefreshQueue?.describeQueue()
    };
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
    await Promise.all([
      this.cacheCoverageCache.refresh(now),
      this.geohashCoverageCache.refresh(now)
    ]);
  }

  private async buildStatisticsSnapshot(now = Date.now()): Promise<StatisticsSnapshot> {
    await this.cacheMetrics.refreshMetrics?.();
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
      const yieldController = new YieldController();

      for (const stats of this.amenityStats.values()) {
        const cacheItems = stats.amenity === '[other amenities]'
          ? Math.max(0, this.cacheMetrics.countTotalCachedTiles() - [...this.amenityStats.keys()]
            .filter((amenity) => amenity !== '[other amenities]')
            .reduce((sum, amenity) => sum + this.cacheMetrics.countCachedTiles(amenity), 0))
          : this.cacheMetrics.countCachedTiles(stats.amenity);
        for (const [hash, count] of stats.geohashCounts) {
          globalGeohashCounts.set(hash, (globalGeohashCounts.get(hash) ?? 0) + count);
          await yieldController.maybeYield();
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
          clientCountApproximate: stats.clients.sketch() !== undefined,
          cacheItems,
          cacheHitRate,
          averageTilesPerRequest,
          cacheStatus: { ...stats.cacheStatusCounts },
          lastRequestAt:
            stats.lastRequestAt > 0 ? new Date(stats.lastRequestAt).toISOString() : undefined
        });
        await yieldController.maybeYield();
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
        clientCountsApproximate: this.uniqueClients.sketch() !== undefined,
        groupedAmenities: this.amenityStats.has('[other amenities]'),
        totalTilesRequested: this.totalTiles,
        totalCachedTiles: this.cacheMetrics.countTotalCachedTiles(),
        totalStaleTiles: this.totalStaleTiles,
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

  private async persist(): Promise<boolean> {
    try {
      await this.storage.save(this.serialise());
      return true;
    } catch (error) {
      logger.warn({ err: error }, 'failed to persist request statistics');
      return false;
    }
  }

  private async aggregateCacheCoverage(
    entries: Iterable<CacheCoverageEntry>
  ): Promise<CacheCoverageEntry[]> {
    let coverage = new Map<string, CacheCoverageEntry>();
    let processed = 0;
    const yieldController = new YieldController();

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
        await yieldController.maybeYield();
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
    await this.cacheMetrics.refreshMetrics?.();
    const coverageEntries = this.cacheMetrics.getCacheCoverage({
      maxEntries: this.maxCacheCoverageEntries
    });
    logger.info(
      { memory: reportMemoryUsage(), inputEntries: coverageEntries.length },
      'cache coverage snapshot input loaded'
    );
    const cacheCoverage = await this.aggregateCacheCoverage(coverageEntries);
    this.totalStaleTiles = cacheCoverage.reduce(
      (sum, entry) => sum + (entry.staleEntries ?? 0),
      0
    );

    logger.info(
      {
        inputEntries: coverageEntries.length,
        outputEntries: cacheCoverage.length,
        maxEntries: this.maxCacheCoverageEntries,
        compactionThreshold: this.cacheCoverageCompactionThreshold,
        totalStaleTiles: this.totalStaleTiles,
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
    const yieldController = new YieldController();
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
          await yieldController.maybeYield();
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
        await yieldController.maybeYield();
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
      uniqueClients: this.uniqueClients.values(),
      uniqueClientSketch: this.uniqueClients.sketch(),
      cacheStatusCounts: { ...this.cacheStatusCounts },
      amenities: [...this.amenityStats.values()].map((stats) => ({
        amenity: stats.amenity,
        requests: stats.requests,
        totalTiles: stats.totalTiles,
        clients: stats.clients.values(),
        clientSketch: stats.clients.sketch(),
        geohashCounts: [...stats.geohashCounts.entries()],
        geohashPrecision: stats.geohashPrecision,
        cacheStatusCounts: { ...stats.cacheStatusCounts },
        lastRequestAt: stats.lastRequestAt
      }))
    };
  }
}

export type StatsWorkerCommand =
  | { type: 'recordBatch'; batch: StatsBatch }
  | { type: 'notifications'; notificationId: number; dirtyTargets: StatisticsRefreshTarget[]; refreshTargets: StatisticsRefreshTarget[] }
  | { type: 'shutdown'; batches?: StatsBatch[] }
  | { type: 'refresh'; target: StatisticsRefreshTarget }
  | { type: 'markDirty'; target: StatisticsRefreshTarget }
  | { type: 'staleRefreshUpdate'; overview: StaleRefreshQueueOverview }
  | { type: 'staleRefreshTask'; amenity: string; groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>; planOptions: { coarsePrecision: number; finePrecision: number; targetTilesPerRequest?: number } }
  ;

export type StatsWorkerNotification = { type: 'ready' } | { type: 'ack'; batchId: string } | { type: 'notificationAck'; notificationId: number } | { type: 'stopped' };

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
  /** Reuse the request store when running without a worker. */
  store?: TileStore;
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
  private readonly statisticsEnabled: boolean;

  private readonly redis: Redis;

  private readonly aggregation = new StatsAggregation();
  private inFlightBatch: StatsBatch | null = null;
  private inlineFlushPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempts = 0;
  private stopped = false;
  private workerUnavailable = false;
  private readonly pendingDirtyTargets = new Set<StatisticsRefreshTarget>();
  private readonly pendingRefreshTargets = new Set<StatisticsRefreshTarget>();
  private notificationFlushPending = false;
  private notificationDrainPromise: Promise<void> | null = null;
  private notificationSequence = 0;
  private notificationInFlight: number | null = null;

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
    this.statisticsEnabled = options.config.statisticsEnabled;
    this.redis = options.redis;

    this.refreshIntervalMs =
      options.coverageRefreshIntervalMs ?? envInteger('STATS_SNAPSHOT_INTERVAL_MS', 10 * 60 * 1000);
    this.snapshotStore = new SnapshotCacheStore(options.redis);
    this.useWorker =
      options.useWorker ??
      options.redis instanceof (IORedis as unknown as new (...args: never[]) => Redis);

    if (!this.useWorker) {
      this.worker = null;
      this.readyPromise = this.startInline(options);
      this.startFlushTimers();
      return;
    }

    const workerData = {
      config: options.config,
      redisUrl: options.redisUrl,
      coverageRefreshIntervalMs: options.coverageRefreshIntervalMs ?? this.refreshIntervalMs,
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
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) logger.error({ code }, 'statistics worker exited unexpectedly');
      if (!this.stopped) this.failPending(new Error(`statistics worker exited with code ${code} before shutdown`));
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const handleMessage = (message: StatsWorkerNotification) => {
        if (message?.type === 'ready') {
          resolve();
        } else if (message?.type === 'ack') {
          this.handleBatchAck(message.batchId);
        } else if (message?.type === 'notificationAck') {
          this.handleNotificationAck(message.notificationId);
        }
      };

      this.worker!.once('message', handleMessage);
      this.worker!.once('error', (error) => reject(error));
      this.worker!.once('exit', (code) => {
        reject(new Error(`statistics worker exited with code ${code} before ready`));
      });
    });
    this.worker.on('message', (message: StatsWorkerNotification) => {
      if (message?.type === 'ack') this.handleBatchAck(message.batchId);
      else if (message?.type === 'notificationAck') this.handleNotificationAck(message.notificationId);
    });
    this.startFlushTimers();
  }

  private startFlushTimers(): void {
    this.flushTimer = setInterval(() => this.flush(), envInteger('STATS_BATCH_INTERVAL_MS', 1000, 50));
    this.flushTimer.unref();
    if (this.useWorker) {
      this.retryTimer = setInterval(() => {
        if (this.inFlightBatch && this.worker && this.retryAttempts < 3) {
          this.retryAttempts++;
          this.worker.postMessage({ type: 'recordBatch', batch: this.inFlightBatch } satisfies StatsWorkerCommand);
        } else if (this.inFlightBatch && this.retryAttempts === 3) {
          this.retryAttempts++;
          logger.warn({ batchId: this.inFlightBatch.batchId }, 'statistics batch ACK is delayed; retaining one bounded in-flight batch');
        }
      }, envInteger('STATS_BATCH_RETRY_MS', 5000, 250));
      this.retryTimer.unref();
    }
  }

  private queueNotification(kind: 'dirty' | 'refresh', target: StatisticsRefreshTarget): void {
    (kind === 'dirty' ? this.pendingDirtyTargets : this.pendingRefreshTargets).add(target);
    if (this.notificationFlushPending) return;
    this.notificationFlushPending = true;
    void this.readyPromise.then(() => {
      this.notificationFlushPending = false;
      if (this.notificationDrainPromise) return;
      if (this.useWorker && this.notificationInFlight !== null) return;
      const dirty = [...this.pendingDirtyTargets];
      const refresh = [...this.pendingRefreshTargets];
      this.pendingDirtyTargets.clear(); this.pendingRefreshTargets.clear();
      this.notificationDrainPromise = (async () => {
        if (this.useWorker) {
          const notificationId = ++this.notificationSequence;
          this.notificationInFlight = notificationId;
          this.worker?.postMessage({ type: 'notifications', notificationId, dirtyTargets: dirty, refreshTargets: refresh } satisfies StatsWorkerCommand);
        } else if (this.inlineStatistics) {
          for (const item of dirty) {
            if (item === 'all' || item === 'statistics') this.inlineStatistics.markStatisticsDirty();
            if (item === 'all' || item === 'cacheCoverage') this.inlineStatistics.markCacheCoverageDirty();
            if (item === 'all' || item === 'geohashCoverage') this.inlineStatistics.markGeohashCoverageDirty();
          }
          for (const item of refresh) {
            if (item === 'statistics') { this.inlineStatistics.markStatisticsDirty(); await this.inlineStatistics.getSnapshot(); }
            else if (item === 'cacheCoverage' || item === 'geohashCoverage') { this.inlineStatistics.markCacheCoverageDirty(); this.inlineStatistics.markGeohashCoverageDirty(); await this.inlineStatistics.refreshCoverageCaches(); }
            else { this.inlineStatistics.markStatisticsDirty(); this.inlineStatistics.markCacheCoverageDirty(); this.inlineStatistics.markGeohashCoverageDirty(); await Promise.all([this.inlineStatistics.getSnapshot(), this.inlineStatistics.refreshCoverageCaches()]); }
          }
        }
      })().catch((error) => logger.warn({ err: error }, 'failed to process coalesced statistics notifications')).finally(() => {
        this.notificationDrainPromise = null;
        if (this.useWorker && this.notificationInFlight !== null) return;
        const dirtyTarget = this.pendingDirtyTargets.values().next().value as StatisticsRefreshTarget | undefined;
        const refreshTarget = this.pendingRefreshTargets.values().next().value as StatisticsRefreshTarget | undefined;
        if (dirtyTarget) this.queueNotification('dirty', dirtyTarget);
        else if (refreshTarget) this.queueNotification('refresh', refreshTarget);
      });
    }).catch((error) => {
      this.notificationFlushPending = false;
      logger.warn({ err: error }, 'statistics notification worker is unavailable');
    });
  }

  private handleNotificationAck(notificationId: number): void {
    if (notificationId !== this.notificationInFlight) return;
    this.notificationInFlight = null;
    const dirtyTarget = this.pendingDirtyTargets.values().next().value as StatisticsRefreshTarget | undefined;
    const refreshTarget = this.pendingRefreshTargets.values().next().value as StatisticsRefreshTarget | undefined;
    if (dirtyTarget) this.queueNotification('dirty', dirtyTarget);
    else if (refreshTarget) this.queueNotification('refresh', refreshTarget);
  }

  public ready(): Promise<void> {
    return this.readyPromise;
  }

  private async startInline(options: StatisticsWorkerOptions): Promise<void> {
    this.inlineStaleRefreshMetrics = new SharedStaleRefreshMetrics();
    this.inlineStaleRefreshQueue = new StaleRefreshQueue();
    const store = options.store ?? new TileStore(options.redis, {
      metricsOnly: true,
      metricsMaxCoverageEntries: options.maxCacheCoverageEntries,
      metricsRefreshIntervalMs: Math.min(30000, options.coverageRefreshIntervalMs ?? this.refreshIntervalMs),
      ttlSeconds: options.config.cacheTtlSeconds,
      swrSeconds: options.config.swrSeconds
    });
    this.inlineStore = store;

    await store.refreshMetrics();
    const { createUpstreamMetricsProvider } = await import('./upstream.js');
    const upstreamMetrics = await createUpstreamMetricsProvider(options.config, options.redis);

    this.inlineStatistics = await RequestStatistics.create(
      store,
      new RedisStatisticsStorage(options.redis),
      upstreamMetrics,
      {
        redis: options.redis,
        staleRefreshQueue: this.inlineStaleRefreshMetrics,
        coverageRefreshIntervalMs: options.coverageRefreshIntervalMs ?? this.refreshIntervalMs,
        coverageCacheTtlMs: options.coverageCacheTtlMs,
        maxCacheCoverageEntries: options.maxCacheCoverageEntries,
        maxGeohashCoverageEntries: options.maxGeohashCoverageEntries,
        maxTrackedAmenities: envInteger('STATS_MAX_AMENITIES', 256, 1),
        maxTotalRequestGeohashEntries: envInteger('STATS_MAX_REQUEST_GEOHASHES', 20_000, 32),
        persistenceIntervalMs: envInteger('STATS_PERSIST_INTERVAL_MS', 30_000),
        snapshotRefreshIntervalMs: this.refreshIntervalMs
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
    if (this.stopped || !this.statisticsEnabled) return;
    this.aggregation.add(payload);
    if (this.aggregation.pendingCount + (this.inFlightBatch?.totalRequests ?? 0) >= envInteger('STATS_FLUSH_THRESHOLD', 128, 1)) this.flush();
  }

  private failPending(error: Error): void {
    logger.warn({ err: error }, 'statistics worker unavailable; dropping bounded pending statistics');
    this.workerUnavailable = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.aggregation.clear();
    this.inFlightBatch = null;
    this.notificationInFlight = null;
    this.pendingDirtyTargets.clear();
    this.pendingRefreshTargets.clear();
  }

  private handleBatchAck(batchId: string): void {
    if (!this.inFlightBatch || this.inFlightBatch.batchId !== batchId) return;
    this.inFlightBatch = null;
    this.retryAttempts = 0;
    this.flush();
  }

  private flush(): void {
    if (this.stopped || this.workerUnavailable || this.inFlightBatch || this.aggregation.isEmpty) return;
    if (!this.useWorker) {
      const batch = this.aggregation.takeBatch();
      if (!batch) return;
      this.inFlightBatch = batch;
      this.inlineFlushPromise = this.readyPromise.then(() => this.inlineStatistics?.recordBatch(batch)).then(() => {}).catch((error) => {
        logger.warn({ err: error }, 'failed to apply inline statistics batch');
      }).finally(() => {
        this.inFlightBatch = null;
        this.inlineFlushPromise = null;
        this.flush();
      });
      return;
    }
    if (!this.worker) return;
    const batch = this.aggregation.takeBatch();
    if (!batch) return;
    this.inFlightBatch = batch;
    void this.readyPromise.then(() => {
      if (this.inFlightBatch?.batchId === batch.batchId) this.worker?.postMessage({ type: 'recordBatch', batch } satisfies StatsWorkerCommand);
    }).catch((error) => this.failPending(error));
  }

  public refresh(
    target: StatisticsRefreshTarget = 'all',
    reason = 'manual',
    metadata: Record<string, unknown> = {}
  ): void {
    if (!this.statisticsEnabled) return;
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

    this.queueNotification('refresh', target);
  }

  public markDirty(target: StatisticsRefreshTarget = 'all'): void {
    if (!this.statisticsEnabled) return;
    this.queueNotification('dirty', target);
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
    const { amenity, groups, statsPayload } = task;
    this.recordRequest(statsPayload);
    const planOptions = {
      coarsePrecision: this.config.staleRefreshCoarsePrecision,
      finePrecision: this.config.tilePrecision,
      targetTilesPerRequest: this.config.staleRefreshTargetTilesPerRequest
    };

    if (!this.useWorker) {
      void this.readyPromise
        .then(async () => {
          this.inlineStaleRefreshQueue?.enqueue({
            amenity,
            groups,
            planOptions,
            coalesceKey: 'inline-stale-tile-refresh',
            run: async (groups, signal) => {
              await this.runStaleRefreshTask({ amenity, groups }, signal);
            }
          });
        })
        .catch((error) => {
          logger.warn({ err: error }, 'failed to enqueue inline stale refresh task');
        });
      return;
    }
    void this.readyPromise.then(() => {
      this.worker?.postMessage({ type: 'staleRefreshTask', amenity, groups, planOptions } satisfies StatsWorkerCommand);
    }).catch((error) => logger.warn({ err: error }, 'failed to post stale refresh task to statistics worker'));
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
    return Number(this.inFlightBatch !== null) + Number(!this.aggregation.isEmpty);
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
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    const shutdownTimers = new Set<ReturnType<typeof setTimeout>>();
    const timeout = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      shutdownTimers.add(timer);
      timer.unref();
    });
    try {
      if (this.worker) {
        if (!this.workerUnavailable) {
          try {
            await Promise.race([this.readyPromise, timeout(1500)]);
            const batches = [this.inFlightBatch, this.aggregation.takeBatch()].filter((batch): batch is StatsBatch => batch !== null);
            await Promise.race([
              new Promise<void>((resolve) => {
                const onMessage = (message: StatsWorkerNotification) => {
                  if (message?.type !== 'stopped') return;
                  this.worker?.off('message', onMessage);
                  resolve();
                };
                this.worker?.on('message', onMessage);
                this.worker?.postMessage({ type: 'shutdown', ...(batches.length ? { batches } : {}) } satisfies StatsWorkerCommand);
              }),
              timeout(3000)
            ]);
          } catch (error) {
            logger.warn({ err: error }, 'statistics worker final flush did not complete');
          }
        }
        await this.worker.terminate();
      } else {
        try {
          const settled = await Promise.race([
            Promise.all([this.readyPromise, this.inlineStaleRefreshQueue?.stop(), this.inlineFlushPromise]).then(() => true),
            timeout(3000).then(() => false)
          ]);
          if (!settled) throw new Error('inline statistics batch did not settle before shutdown timeout');
          const batch = this.aggregation.takeBatch();
          if (batch) await Promise.race([this.inlineStatistics?.recordBatch(batch), timeout(3000)]);
          await Promise.race([this.inlineStatistics?.close(), timeout(3000)]);
        } catch (error) {
          logger.warn({ err: error }, 'inline statistics final flush did not complete');
        }
      }
    } finally {
      for (const timer of shutdownTimers) clearTimeout(timer);
    }
  }

  private async runStaleRefreshTask(task: {
    amenity: string;
    groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>;
  }, signal?: AbortSignal): Promise<void> {
    if (!this.inlineStatistics || !this.inlineStore) {
      return;
    }

    const { fetchTile } = await import('./upstream.js');
    const { filterElementsByBbox } = await import('./store.js');

    for (const group of task.groups) {
      if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
      const representative = group.tiles[0];
      if (!representative) continue;

      await this.inlineStore
        .withRefreshLock(representative, task.amenity, async () => {
          if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
          const response = await fetchTile(this.config, group.bounds, task.amenity, {
            redis: this.redis,
            signal
          });
          if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
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

    if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
    this.inlineStatistics.markCacheCoverageDirty();
  }
}
