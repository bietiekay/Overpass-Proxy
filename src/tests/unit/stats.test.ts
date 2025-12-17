import { describe, expect, it } from 'vitest';

import type { BoundingBox } from '../../bbox.js';
import { tilesForBoundingBox } from '../../tiling.js';
import {
  CacheCoverageOverflowError,
  type PersistedStatisticsState,
  type StatisticsStorage,
  RequestStatistics
} from '../../stats.js';

const BASE32_SYMBOLS = 32;

class InMemoryStatisticsStorage implements StatisticsStorage {
  private state: PersistedStatisticsState | null = null;

  public async load(): Promise<PersistedStatisticsState | null> {
    return this.state;
  }

  public async save(state: PersistedStatisticsState): Promise<void> {
    this.state = state;
  }
}

describe('RequestStatistics', () => {
  const bbox: BoundingBox = { south: 52.5, west: 13.3, north: 52.6, east: 13.4 };

  it('aggregates request metrics', async () => {
    const cacheCounts = new Map<string, number>([['toilets', 5]]);
    const cachedAmenities = new Map<string, number>([['toilets', 5]]);
    const tiles = tilesForBoundingBox(bbox, 5);
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create({
      countCachedTiles: (amenity) => cacheCounts.get(amenity) ?? 0,
      countCachedAmenities: () => [...cachedAmenities.values()].reduce((sum, value) => sum + value, 0),
      countCachedAmenityTypes: () => cachedAmenities.size,
      countTotalCachedTiles: () => [...cacheCounts.values()].reduce((sum, value) => sum + value, 0),
      getCacheCoverage: () => []
    }, storage);

    await stats.recordRequest({
      amenity: 'Toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 12,
      tiles,
      timestamp: new Date('2024-01-01T10:00:00Z').getTime()
    });
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '2.2.2.2',
      bbox,
      cacheStatus: 'MISS',
      tileCount: 8,
      tiles,
      timestamp: new Date('2024-01-01T11:00:00Z').getTime()
    });
    await stats.recordRequest({
      amenity: 'drinking_water',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'STALE',
      tileCount: 6,
      tiles,
      timestamp: new Date('2024-01-01T12:00:00Z').getTime()
    });

    const snapshot = await stats.getSnapshot(new Date('2024-01-01T13:00:00Z').getTime());
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.totalRequestsDay).toBe(3);
    expect(snapshot.totalRequestsWeek).toBe(3);
    expect(snapshot.totalRequestsMonth).toBe(3);
    expect(snapshot.totalUniqueClients).toBe(2);
    expect(snapshot.totalTilesRequested).toBe(26);
    expect(snapshot.totalCachedTiles).toBe(5);
    expect(snapshot.cachedAmenities).toBe(5);
    expect(snapshot.cachedAmenityTypes).toBe(1);
    expect(snapshot.cacheHitRate).toBeCloseTo(33.33, 2);
    expect(snapshot.amenities).toHaveLength(2);
    expect(snapshot.hotspots.length).toBeGreaterThanOrEqual(1);

    const toilets = snapshot.amenities.find((entry) => entry.amenity === 'toilets');
    expect(toilets?.requests).toBe(2);
    expect(toilets?.uniqueClients).toBe(2);
    expect(toilets?.cacheItems).toBe(5);
    expect(toilets?.cacheHitRate).toBe(50);
    expect(toilets?.cacheStatus.HIT).toBe(1);
    expect(toilets?.cacheStatus.MISS).toBe(1);
    expect(toilets?.averageTilesPerRequest).toBe(10);

    const geohashSnapshot = await stats.getGeohashCoverageSnapshot(
      new Date('2024-01-01T13:00:00Z').getTime()
    );
    const toiletsCoverage = geohashSnapshot.geohashCoverage.find(
      (entry) => entry.amenity === 'toilets'
    );
    expect(toiletsCoverage?.geohashCoverage[0]?.geohash.length).toBeGreaterThanOrEqual(5);
    expect(toiletsCoverage?.geohashCoverage.length).toBe(tiles.length);
  });

  it('resets daily counters across day boundaries', async () => {
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

    const firstDay = new Date('2024-01-01T23:30:00Z').getTime();
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 5,
      timestamp: firstDay
    });

    const snapshot = await stats.getSnapshot(new Date('2024-01-02T01:00:00Z').getTime());
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.totalRequestsDay).toBe(0);
    expect(snapshot.totalRequestsWeek).toBe(1);
    expect(snapshot.totalRequestsMonth).toBe(1);
    expect(snapshot.amenities).toHaveLength(1);
    expect(snapshot.hotspots).toHaveLength(1);
  });

  it('restores persisted state', async () => {
    const storage = new InMemoryStatisticsStorage();
    const firstInstance = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    await firstInstance.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 3,
      timestamp: new Date('2024-01-01T08:00:00Z').getTime()
    });

    const secondInstance = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => []
      },
      storage
    );

    const snapshot = await secondInstance.getSnapshot(
      new Date('2024-01-01T09:00:00Z').getTime()
    );
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.totalRequestsDay).toBe(1);
    expect(snapshot.totalRequestsWeek).toBe(1);
    expect(snapshot.totalRequestsMonth).toBe(1);
    expect(snapshot.amenities[0]?.amenity).toBe('toilets');
  });

  it('tracks weekly and monthly request counters', async () => {
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

    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 1,
      timestamp: new Date('2024-01-05T10:00:00Z').getTime()
    });

    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'MISS',
      tileCount: 1,
      timestamp: new Date('2024-01-08T09:00:00Z').getTime()
    });

    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'MISS',
      tileCount: 1,
      timestamp: new Date('2024-02-02T09:00:00Z').getTime()
    });

    const snapshot = await stats.getSnapshot(new Date('2024-02-02T10:00:00Z').getTime());

    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.totalRequestsWeek).toBe(1);
    expect(snapshot.totalRequestsMonth).toBe(1);
  });

  it('exposes cache coverage snapshots separately', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => [
          { geohash: 'u0qj0', entries: 2, amenityItems: 5, staleEntries: 0, staleAmenityItems: 0 },
          { geohash: 'u33d0', entries: 3, amenityItems: 6, staleEntries: 0, staleAmenityItems: 0 }
        ]
      },
      storage
    );

    const snapshot = await stats.getCacheCoverageSnapshot(new Date('2024-01-01T00:00:00Z').getTime());
    expect(snapshot.generatedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(snapshot.cacheCoverage[0]?.geohash).toBe('u33d0');
    expect(snapshot.cacheCoverage[0]?.entries).toBe(3);
    expect(snapshot.cacheCoverage[1]?.geohash).toBe('u0qj0');
    expect(snapshot.optimised).toBe(true);
    expect(snapshot.minPrecision).toBe(1);
    expect(snapshot.maxPrecision).toBe(5);
  });

  it('merges geohash coverage to parents when all children are present', async () => {
    const storage = new InMemoryStatisticsStorage();
    const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () =>
          [...base32].map((symbol, index) => ({
            geohash: `u0qj${symbol}`,
            entries: index + 1,
            amenityItems: (index + 1) * 2,
            staleEntries: index % 2,
            staleAmenityItems: index % 2 ? index + 1 : 0
          }))
      },
      storage
    );

    const snapshot = await stats.getCacheCoverageSnapshot(new Date('2024-01-01T00:00:00Z').getTime());

    expect(snapshot.cacheCoverage).toHaveLength(1);
    expect(snapshot.cacheCoverage[0]).toEqual({
      geohash: 'u0qj',
      entries: expect.any(Number),
      amenityItems: expect.any(Number),
      staleEntries: expect.any(Number),
      staleAmenityItems: expect.any(Number)
    });
    expect(snapshot.cacheCoverage[0]?.entries).toBe(528);
    expect(snapshot.cacheCoverage[0]?.amenityItems).toBe(1056);
    expect(snapshot.cacheCoverage[0]?.staleEntries).toBe(16);
    expect(snapshot.cacheCoverage[0]?.staleAmenityItems).toBe(272);
    expect(snapshot.minPrecision).toBe(1);
    expect(snapshot.maxPrecision).toBe(4);
  });

  it('respects a minimum precision when optimising cache coverage', async () => {
    const storage = new InMemoryStatisticsStorage();
    const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () =>
          [...base32].map((symbol, index) => ({
            geohash: `u0qj${symbol}`,
            entries: index + 1,
            amenityItems: (index + 1) * 2,
            staleEntries: 0,
            staleAmenityItems: 0
          }))
      },
      storage
    );

    const snapshot = await stats.getCacheCoverageSnapshot(new Date('2024-01-01T00:00:00Z').getTime(), {
      minPrecision: 5
    });

    expect(snapshot.cacheCoverage).toHaveLength(BASE32_SYMBOLS);
    expect(snapshot.minPrecision).toBe(5);
    expect(snapshot.maxPrecision).toBe(5);
  });

  it('rejects oversized cache coverage snapshots', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () =>
          Array.from({ length: 11 }, (_value, index) => ({
            geohash: `u0qj${index.toString(32)}`,
            entries: 1,
            amenityItems: 1,
            staleEntries: 0,
            staleAmenityItems: 0
          }))
      },
      storage,
      undefined,
      { maxCacheCoverageEntries: 10 }
    );

    await expect(
      stats.getCacheCoverageSnapshot(new Date('2024-01-01T00:00:00Z').getTime(), { minPrecision: 5 })
    ).rejects.toBeInstanceOf(CacheCoverageOverflowError);
  });

  it('exposes geohash coverage snapshots separately', async () => {
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

    const tiles = tilesForBoundingBox(bbox, 5);

    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'MISS',
      tileCount: 1,
      tiles,
      timestamp: new Date('2024-01-01T12:00:00Z').getTime()
    });

    const snapshot = await stats.getGeohashCoverageSnapshot(
      new Date('2024-01-01T13:00:00Z').getTime()
    );

    expect(snapshot.generatedAt).toBe('2024-01-01T13:00:00.000Z');
    const toiletsCoverage = snapshot.geohashCoverage.find((entry) => entry.amenity === 'toilets');
    expect(toiletsCoverage?.geohashCoverage[0]?.geohash.length).toBeGreaterThanOrEqual(5);
    expect(toiletsCoverage?.geohashCoverage.length).toBe(tiles.length);
  });

  it('keeps statistics snapshots lean by omitting cache coverage', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0,
        countCachedAmenities: () => 0,
        countCachedAmenityTypes: () => 0,
        countTotalCachedTiles: () => 0,
        getCacheCoverage: () => [
          { geohash: 'u0qj0', entries: 2, amenityItems: 5, staleEntries: 0, staleAmenityItems: 0 }
        ]
      },
      storage
    );

    const snapshot = await stats.getSnapshot();
    expect('cacheCoverage' in snapshot).toBe(false);
    expect('geohashCoverage' in snapshot).toBe(false);
  });
});
