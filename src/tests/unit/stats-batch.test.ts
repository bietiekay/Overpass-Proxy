import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { CacheStatus, PersistedStatisticsState, StatisticsStorage } from '../../stats.js';
import { RequestStatistics, STATISTICS_SNAPSHOT_KEY } from '../../stats.js';
import type { StatsBatch } from '../../statsAggregation.js';

class MemoryStorage implements StatisticsStorage {
  state: PersistedStatisticsState | null = null;
  saves = 0;
  async load(): Promise<PersistedStatisticsState | null> { return this.state; }
  async save(state: PersistedStatisticsState): Promise<void> { this.state = state; this.saves++; }
}

const metrics = {
  countCachedTiles: () => 0, countCachedAmenities: () => 0,
  countCachedAmenityTypes: () => 0, countTotalCachedTiles: () => 0,
  getCacheCoverage: () => []
};
const status = (value: CacheStatus, requests = 1): Record<CacheStatus, number> => ({
  HIT: value === 'HIT' ? requests : 0, MISS: value === 'MISS' ? requests : 0, STALE: value === 'STALE' ? requests : 0
});

const batch = (id: string, dayStart: number, requests: number, timestamp: number): StatsBatch => ({
  batchId: id, totalRequests: requests, totalTiles: requests * 2,
  totalClients: { values: ['client-a', 'client-b'] }, cacheStatusCounts: status('HIT', requests),
  periods: { dayStart, dayRequests: requests, weekStart: dayStart, weekRequests: requests,
    monthStart: dayStart, monthRequests: requests },
  amenities: [{ amenity: 'toilets', requests, totalTiles: requests * 2,
    clients: { values: ['client-a', 'client-b'] }, geohashCounts: [['u4pr', requests]],
    geohashPrecision: 4, cacheStatusCounts: status('HIT', requests), lastRequestAt: timestamp }]
});

describe('batched request statistics', () => {
  it('merges exact counters and client sets while deferring persistence until flush', async () => {
    const storage = new MemoryStorage();
    const stats = await RequestStatistics.create(metrics, storage, undefined, { persistenceIntervalMs: 60_000 });
    const day = Date.UTC(2025, 0, 2);
    await stats.recordBatch(batch('one', day, 2, day + 1));
    await stats.recordBatch(batch('one', day, 2, day + 1));
    await stats.recordBatch(batch('two', day, 3, day + 2));
    expect(storage.saves).toBe(0);
    await stats.flushPersistence();
    expect(storage.saves).toBe(1);
    expect(storage.state?.totalRequests).toBe(5);
    expect(storage.state?.totalTiles).toBe(10);
    expect(storage.state?.cacheStatusCounts.HIT).toBe(5);
    expect(storage.state?.amenities[0]?.requests).toBe(5);
    expect(storage.state?.amenities[0]?.clients).toEqual(['client-a', 'client-b']);
    await stats.close();
  });

  it('coarsens all amenity request maps under one global geohash budget', async () => {
    const storage = new MemoryStorage();
    const stats = await RequestStatistics.create(metrics, storage, undefined, {
      maxTrackedAmenities: 4, maxTotalRequestGeohashEntries: 32
    });
    const day = Date.UTC(2025, 0, 2);
    const manyHashes = Array.from({ length: 64 }, (_, i) => [`u4pr${i.toString(32)}`, 1] as [string, number]);
    const payload = batch('many', day, 256, day + 1);
    payload.amenities = Array.from({ length: 4 }, (_, i) => ({
      amenity: `amenity-${i}`, requests: 64, totalTiles: 64, clients: { values: [] },
      geohashCounts: manyHashes, geohashPrecision: 5,
      cacheStatusCounts: status('HIT', 64), lastRequestAt: day + 1
    }));
    await stats.recordBatch(payload);
    await stats.flushPersistence();
    expect(storage.state?.amenities.reduce((total, amenity) => total + amenity.geohashCounts.length, 0))
      .toBeLessThanOrEqual(160);
    expect(storage.state?.amenities.reduce((total, amenity) =>
      total + amenity.geohashCounts.reduce((sum, [, count]) => sum + count, 0), 0)).toBe(256);
    const snapshot = await stats.getSnapshot(day + 1000);
    expect(snapshot.totalRequests).toBe(256);
    await stats.close();
  });

  it('merges raw batch clients with exact legacy persisted client values', async () => {
    const storage = new MemoryStorage();
    const start = Date.UTC(2025, 0, 2);
    storage.state = {
      dayStart: start, weekStart: start, monthStart: start, totalRequests: 0,
      totalRequestsDay: 0, totalRequestsWeek: 0, totalRequestsMonth: 0, totalTiles: 0,
      uniqueClients: ['client-a'], cacheStatusCounts: { HIT: 0, MISS: 0, STALE: 0 }, amenities: []
    };
    const stats = await RequestStatistics.create(metrics, storage);
    const payload = batch('legacy-client', start, 1, start + 1);
    payload.totalClients.values = ['client-a'];
    await stats.recordBatch(payload);
    const snapshot = await stats.getSnapshot(start + 2);
    expect(snapshot.totalUniqueClients).toBe(1);
    await stats.close();
  });

  it('keeps production snapshots on cadence after explicit dirty refresh requests', async () => {
    let metricRefreshes = 0;
    const stats = await RequestStatistics.create({
      ...metrics,
      refreshMetrics: async () => { metricRefreshes++; }
    }, new MemoryStorage(), undefined, {
      snapshotRefreshIntervalMs: 600_000,
      coverageRefreshIntervalMs: 600_000
    });
    const first = await stats.getSnapshot();
    stats.markStatisticsDirty();
    expect((await stats.getSnapshot()).generatedAt).toBe(first.generatedAt);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(metricRefreshes).toBe(1);

    await stats.refreshCoverageCaches();
    const afterInitialCoverageBuild = metricRefreshes;
    stats.markCacheCoverageDirty();
    stats.markGeohashCoverageDirty();
    await stats.refreshCoverageCaches();
    expect(metricRefreshes).toBe(afterInitialCoverageBuild);
    await stats.close();
  });

  it('holds the global build gate through snapshot persistence', async () => {
    let releaseWrite: (() => void) | undefined;
    let notifyWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });
    const redis = {
      get: async () => null,
      set: async (key: string) => {
        if (key === STATISTICS_SNAPSHOT_KEY) {
          notifyWriteStarted?.();
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        return 'OK';
      }
    } as unknown as Redis;
    let metricRefreshes = 0;
    const stats = await RequestStatistics.create({
      ...metrics,
      refreshMetrics: async () => { metricRefreshes++; }
    }, new MemoryStorage(), undefined, {
      redis, snapshotRefreshIntervalMs: 600_000, coverageRefreshIntervalMs: 600_000
    });

    const firstBuild = stats.getSnapshot();
    await writeStarted;
    const secondBuild = stats.refreshCoverageCaches();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const refreshCountWhileWriteBlocked = metricRefreshes;
    releaseWrite?.();
    await Promise.all([firstBuild, secondBuild]);
    expect(refreshCountWhileWriteBlocked).toBe(1);
    expect(metricRefreshes).toBe(2);
    await stats.close();
  });

  it('counts failed attempts toward cadence and ignores stale Redis timestamps', async () => {
    vi.useFakeTimers();
    const snapshots = new Map<string, string>();
    const redis = {
      get: async (key: string) => snapshots.get(key) ?? null,
      set: async (key: string, value: string) => { snapshots.set(key, value); return 'OK'; }
    } as unknown as Redis;
    let failUpstream = false;
    let describeCalls = 0;
    const stats = await RequestStatistics.create(metrics, new MemoryStorage(), {
      describeUpstreams: () => {
        describeCalls++;
        if (failUpstream) throw new Error('temporary upstream metrics failure');
        return [];
      }
    }, { redis, snapshotRefreshIntervalMs: 600_000, coverageRefreshIntervalMs: 600_000 });
    try {
      const initial = await stats.getSnapshot();
      expect(describeCalls).toBe(1);

      failUpstream = true;
      await vi.advanceTimersByTimeAsync(600_001);
      stats.markStatisticsDirty();
      await stats.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(describeCalls).toBe(2);

      snapshots.set(STATISTICS_SNAPSHOT_KEY, JSON.stringify({
        ...initial, generatedAt: new Date(0).toISOString()
      }));
      await vi.advanceTimersByTimeAsync(10_000);
      await stats.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(describeCalls).toBe(2);

      failUpstream = false;
      await vi.advanceTimersByTimeAsync(590_001);
      await stats.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(describeCalls).toBe(3);
    } finally {
      await stats.close();
      vi.useRealTimers();
    }
  });

  it('keeps upstream health in the fallback after a Redis snapshot disappears', async () => {
    const snapshots = new Map<string, string>();
    const redis = {
      get: async (key: string) => snapshots.get(key) ?? null,
      set: async (key: string, value: string) => { snapshots.set(key, value); return 'OK'; }
    } as unknown as Redis;
    const stats = await RequestStatistics.create(metrics, new MemoryStorage(), {
      describeUpstreams: () => [{
        upstream: 'primary', status: 'available', reason: '', requestsToday: 0,
        dayStart: new Date().toISOString()
      }]
    }, { redis, snapshotRefreshIntervalMs: 600_000 });
    try {
      await stats.getSnapshot();
      snapshots.delete(STATISTICS_SNAPSHOT_KEY);
      const fallback = await stats.getSnapshot();
      expect(fallback.upstreams.map((entry) => entry.upstream)).toEqual(['primary']);
    } finally {
      await stats.close();
    }
  });
});
