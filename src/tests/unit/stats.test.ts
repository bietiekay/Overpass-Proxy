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

describe('RequestStatistics', () => {
  const bbox: BoundingBox = { south: 52.5, west: 13.3, north: 52.6, east: 13.4 };

  it('aggregates request metrics', async () => {
    const cacheCounts = new Map<string, number>([['toilets', 5]]);
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create({
      countCachedTiles: (amenity) => cacheCounts.get(amenity) ?? 0
    }, storage);

    await stats.recordRequest({
      amenity: 'Toilets',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'HIT',
      tileCount: 12,
      timestamp: new Date('2024-01-01T10:00:00Z').getTime()
    });
    await stats.recordRequest({
      amenity: 'toilets',
      clientIp: '2.2.2.2',
      bbox,
      cacheStatus: 'MISS',
      tileCount: 8,
      timestamp: new Date('2024-01-01T11:00:00Z').getTime()
    });
    await stats.recordRequest({
      amenity: 'drinking_water',
      clientIp: '1.1.1.1',
      bbox,
      cacheStatus: 'STALE',
      tileCount: 6,
      timestamp: new Date('2024-01-01T12:00:00Z').getTime()
    });

    const snapshot = await stats.getSnapshot(new Date('2024-01-01T13:00:00Z').getTime());
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.totalUniqueClients).toBe(2);
    expect(snapshot.totalTilesRequested).toBe(26);
    expect(snapshot.amenities).toHaveLength(2);
    expect(snapshot.hotspots.length).toBeGreaterThanOrEqual(1);

    const toilets = snapshot.amenities.find((entry) => entry.amenity === 'toilets');
    expect(toilets?.requests).toBe(2);
    expect(toilets?.uniqueClients).toBe(2);
    expect(toilets?.cacheItems).toBe(5);
    expect(toilets?.cacheStatus.HIT).toBe(1);
    expect(toilets?.cacheStatus.MISS).toBe(1);
    expect(toilets?.averageTilesPerRequest).toBe(10);
    const coverageSum = toilets?.geohashCoverage.reduce((sum, entry) => sum + entry.percentage, 0) ?? 0;
    expect(Math.round(coverageSum)).toBe(100);
  });

  it('resets when day changes', async () => {
    const storage = new InMemoryStatisticsStorage();
    const stats = await RequestStatistics.create(
      {
        countCachedTiles: () => 0
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
    expect(snapshot.totalRequests).toBe(0);
    expect(snapshot.amenities).toHaveLength(0);
    expect(snapshot.hotspots).toHaveLength(0);
  });

  it('restores persisted state', async () => {
    const storage = new InMemoryStatisticsStorage();
    const firstInstance = await RequestStatistics.create(
      {
        countCachedTiles: () => 0
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
        countCachedTiles: () => 0
      },
      storage
    );

    const snapshot = await secondInstance.getSnapshot(
      new Date('2024-01-01T09:00:00Z').getTime()
    );
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.amenities[0]?.amenity).toBe('toilets');
  });
});
