import { describe, expect, it } from 'vitest';
import { StatsAggregation } from '../../statsAggregation.js';
import type { RecordRequestOptions } from '../../stats.js';

const request = (amenity: string, clientIp: string, timestamp: number, hashes: string[]): RecordRequestOptions => ({
  amenity, clientIp, bbox: { north: 1, south: 0, east: 1, west: 0 }, cacheStatus: 'HIT', tileCount: hashes.length,
  timestamp, tiles: hashes.map((hash) => ({ hash, bounds: { north: 1, south: 0, east: 1, west: 0 } }))
});

describe('bounded statistics ingress aggregation', () => {
  it('preserves exact request totals, per-request hash distinctness, IP values, and period deltas across batches', () => {
    const aggregation = new StatsAggregation();
    const day = Date.now();
    aggregation.add(request('toilets', '192.0.2.1', day, ['u4pruyd', 'u4pruyd', 'u4pruyf']));
    const first = aggregation.takeBatch();
    expect(first?.totalRequests).toBe(1);
    expect(first?.totalTiles).toBe(3);
    expect(first?.totalClients.values).toEqual(['192.0.2.1']);
    expect(first?.amenities[0]?.geohashCounts.reduce((sum, [, count]) => sum + count, 0)).toBe(2);
    expect(first?.periods.dayRequests).toBe(1);

    aggregation.add(request('toilets', '192.0.2.1', day + 1, ['u4pruyd']));
    const second = aggregation.takeBatch();
    expect(second?.periods.dayRequests).toBe(1);
    expect(second?.amenities[0]?.clients.values).toEqual(['192.0.2.1']);
  });

  it('bounds tracked amenities and global geohashes while retaining exact request and hash contribution totals', () => {
    const aggregation = new StatsAggregation({ maxAmenities: 2, maxGeohashes: 100 });
    const timestamp = Date.now();
    const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';
    for (let amenity = 0; amenity < 20; amenity++) {
      const hashes = Array.from({ length: 64 }, (_, index) => `u4pr${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`);
      aggregation.add(request(`amenity-${amenity}`, `client-${amenity}`, timestamp, hashes));
    }
    const batch = aggregation.takeBatch();
    expect(batch?.totalRequests).toBe(20);
    expect(batch?.amenities.length).toBeLessThanOrEqual(3);
    expect(batch?.amenities.reduce((sum, item) => sum + item.geohashCounts.length, 0)).toBeLessThanOrEqual(100);
    expect(batch?.amenities.reduce((sum, item) => sum + item.requests, 0)).toBe(20);
    expect(batch?.amenities.reduce((sum, item) => sum + item.geohashCounts.reduce((count, [, n]) => count + n, 0), 0)).toBe(20 * 64);
  });
});
