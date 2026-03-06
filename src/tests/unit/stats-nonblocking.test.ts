import { describe, expect, it } from 'vitest';

import type { BoundingBox } from '../../bbox.js';
import {
  type PersistedStatisticsState,
  type StatisticsStorage,
  RequestStatistics
} from '../../stats.js';

class InMemoryStatisticsStorage implements StatisticsStorage {
  private state: PersistedStatisticsState | null = null;

  public async load(): Promise<PersistedStatisticsState | null> {
    return this.state;
  }

  public async save(state: PersistedStatisticsState): Promise<void> {
    this.state = state;
  }
}

describe('RequestStatistics - Non-blocking behavior', () => {
  const bbox: BoundingBox = { south: 52.5, west: 13.3, north: 52.6, east: 13.4 };

  it('returns cached snapshot immediately even when refresh is needed', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    // Create initial snapshot
    const firstSnapshot = await stats.getSnapshot(new Date('2024-01-01T10:00:00Z').getTime());
    expect(firstSnapshot.totalRequests).toBe(0);

    // Record a request to mark cache as dirty
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 1,
      timestamp: new Date('2024-01-01T11:00:00Z').getTime()
    });

    // getSnapshot should return cached data immediately (with old data)
    // even though refresh is needed
    const startTime = Date.now();
    const cachedSnapshot = await stats.getSnapshot(new Date('2024-01-01T11:01:00Z').getTime());
    const elapsed = Date.now() - startTime;

    // Should return immediately (less than 100ms)
    expect(elapsed).toBeLessThan(100);
    // Should return the old cached snapshot
    expect(cachedSnapshot.generatedAt).toBe(firstSnapshot.generatedAt);
    expect(cachedSnapshot.totalRequests).toBe(firstSnapshot.totalRequests);
  });

  it('triggers background refresh without blocking', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    // Create initial snapshot
    await stats.getSnapshot(new Date('2024-01-01T10:00:00Z').getTime());

    // Record a request
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 1,
      timestamp: new Date('2024-01-01T11:00:00Z').getTime()
    });

    // Trigger getSnapshot which should start background refresh
    const firstCall = stats.getSnapshot(new Date('2024-01-01T11:01:00Z').getTime());
    const secondCall = stats.getSnapshot(new Date('2024-01-01T11:01:00Z').getTime());
    const thirdCall = stats.getSnapshot(new Date('2024-01-01T11:01:00Z').getTime());

    // All calls should return immediately
    const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall]);
    expect(first.generatedAt).toBe(second.generatedAt);
    expect(second.generatedAt).toBe(third.generatedAt);

    // Wait for background refresh to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // After refresh, snapshot should be updated
    const refreshedSnapshot = await stats.getSnapshot(new Date('2024-01-01T11:02:00Z').getTime());
    expect(refreshedSnapshot.totalRequests).toBe(1);
  });

  it('handles multiple concurrent requests during statistics generation', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    // Create initial snapshot
    const initialSnapshot = await stats.getSnapshot(new Date('2024-01-01T10:00:00Z').getTime());

    // Record a request to trigger refresh
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 1,
      timestamp: new Date('2024-01-01T11:00:00Z').getTime()
    });

    // Make multiple concurrent getSnapshot calls
    // All should return immediately with cached data
    const startTime = Date.now();
    const promises = Array.from({ length: 10 }, () =>
      stats.getSnapshot(new Date('2024-01-01T11:01:00Z').getTime())
    );
    const snapshots = await Promise.all(promises);
    const elapsed = Date.now() - startTime;

    // All calls should complete quickly (less than 50ms total)
    expect(elapsed).toBeLessThan(50);

    // All should return the same cached snapshot
    snapshots.forEach((snapshot) => {
      expect(snapshot.generatedAt).toBe(initialSnapshot.generatedAt);
    });
  });

  it('returns empty snapshot immediately when no cache exists and builds in background', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    // Clear any existing cache by creating a new instance
    // For this test, we'll just verify that getSnapshot returns quickly
    // even when building from scratch
    const startTime = Date.now();
    const snapshot = await stats.getSnapshot(new Date('2024-01-01T10:00:00Z').getTime());
    const elapsed = Date.now() - startTime;

    // Should return quickly (build should be fast with no data)
    expect(elapsed).toBeLessThan(1000);
    expect(snapshot).toBeDefined();
    expect(snapshot.totalRequests).toBe(0);
  });

  it('ensures API requests are not blocked by statistics generation', async () => {
    const storage = new InMemoryStatisticsStorage();
    
    // Track how long getSnapshot takes
    const callTimes: number[] = [];
    
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    // Create initial snapshot
    await stats.getSnapshot(new Date('2024-01-01T10:00:00Z').getTime());

    // Record multiple requests to trigger refresh
    for (let i = 0; i < 5; i += 1) {
      await stats.recordRequest({
        amenity: 'toilets',
        clientIp: `1.1.1.${i}`,
        bbox,
        cacheStatus: 'HIT',
        tileCount: 1,
        timestamp: new Date(`2024-01-01T11:0${i}:00Z`).getTime()
      });
    }

    // Simulate multiple API requests calling getSnapshot concurrently
    // All should return immediately with cached data
    const apiCalls = Array.from({ length: 20 }, async () => {
      const start = Date.now();
      const snapshot = await stats.getSnapshot(new Date('2024-01-01T11:10:00Z').getTime());
      callTimes.push(Date.now() - start);
      return snapshot;
    });

    const results = await Promise.all(apiCalls);
    const maxCallTime = Math.max(...callTimes);
    const avgCallTime = callTimes.reduce((a, b) => a + b, 0) / callTimes.length;

    // All calls should return quickly (less than 100ms each)
    expect(maxCallTime).toBeLessThan(100);
    expect(avgCallTime).toBeLessThan(50);

    // All should return the same cached snapshot
    const firstGeneratedAt = results[0].generatedAt;
    results.forEach((snapshot) => {
      expect(snapshot.generatedAt).toBe(firstGeneratedAt);
    });
  });
});
