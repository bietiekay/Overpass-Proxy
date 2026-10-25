import ngeohash from 'ngeohash';
import { createHash } from 'node:crypto';
import { DistinctCounter } from './distinctCounter.js';
import type { CacheStatus, RecordRequestOptions } from './stats.js';
import { startOfDayMs, startOfMonthMs, startOfWeekMs } from './time.js';

export interface SerializedDistinctCounter { values: string[]; sketch?: string; }
export interface StatsAmenityDelta {
  amenity: string;
  requests: number;
  totalTiles: number;
  clients: SerializedDistinctCounter;
  geohashCounts: Array<[string, number]>;
  geohashPrecision: number;
  cacheStatusCounts: Record<CacheStatus, number>;
  lastRequestAt: number;
}
export interface StatsBatch {
  batchId: string;
  totalRequests: number;
  totalTiles: number;
  totalClients: SerializedDistinctCounter;
  cacheStatusCounts: Record<CacheStatus, number>;
  periods: { dayStart: number; weekStart: number; monthStart: number; dayRequests: number; weekRequests: number; monthRequests: number };
  amenities: StatsAmenityDelta[];
}
interface MutableAmenity extends Omit<StatsAmenityDelta, 'clients' | 'geohashCounts'> {
  clients: DistinctCounter;
  geohashCounts: Map<string, number>;
}

const statuses = (): Record<CacheStatus, number> => ({ HIT: 0, MISS: 0, STALE: 0 });
const serialise = (counter: DistinctCounter): SerializedDistinctCounter => {
  const sketch = counter.sketch();
  return { values: counter.values(), ...(sketch ? { sketch } : {}) };
};
const encodeBounds = (bbox: RecordRequestOptions['bbox']): string | null => {
  const lat = (bbox.north + bbox.south) / 2;
  const lon = (bbox.east + bbox.west) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try { return ngeohash.encode(lat, lon, 4); } catch { return null; }
};
/** Bounded, lossy only in spatial precision; request and tile counters remain exact. */
export class StatsAggregation {
  private totalRequests = 0;
  private totalTiles = 0;
  private readonly clients = new DistinctCounter();
  private readonly cacheStatusCounts = statuses();
  private periods: StatsBatch['periods'];
  private readonly amenities = new Map<string, MutableAmenity>();
  private geoEntries = 0;
  private sequence = 0;
  private readonly maxAmenities: number;
  private readonly maxGeohashes: number;

  constructor(options: { maxAmenities?: number; maxGeohashes?: number } = {}) {
    const envAmenities = Number(process.env.STATS_MAX_AMENITIES ?? 256);
    const envGeohashes = Number(process.env.STATS_MAX_PENDING_GEOHASHES ?? 20_000);
    this.maxAmenities = Math.max(1, Math.floor(options.maxAmenities ?? (Number.isFinite(envAmenities) ? envAmenities : 256)));
    this.maxGeohashes = Math.max(32 * (this.maxAmenities + 1), Math.floor(options.maxGeohashes ?? (Number.isFinite(envGeohashes) ? envGeohashes : 20_000)));
    const now = Date.now();
    this.periods = { dayStart: startOfDayMs(now), dayRequests: 0, weekStart: startOfWeekMs(now), weekRequests: 0, monthStart: startOfMonthMs(now), monthRequests: 0 };
  }

  get isEmpty(): boolean { return this.totalRequests === 0; }
  get pendingCount(): number { return this.totalRequests; }

  add(options: RecordRequestOptions): void {
    const now = options.timestamp ?? Date.now();
    const day = startOfDayMs(now), week = startOfWeekMs(now), month = startOfMonthMs(now);
    if (day > this.periods.dayStart) { this.periods.dayStart = day; this.periods.dayRequests = 0; }
    if (week > this.periods.weekStart) { this.periods.weekStart = week; this.periods.weekRequests = 0; }
    if (month > this.periods.monthStart) { this.periods.monthStart = month; this.periods.monthRequests = 0; }
    if (day === this.periods.dayStart) this.periods.dayRequests++;
    if (week === this.periods.weekStart) this.periods.weekRequests++;
    if (month === this.periods.monthStart) this.periods.monthRequests++;
    const rawClient = !options.clientIp || options.clientIp.trim().length === 0 ? 'unknown' : options.clientIp;
    const client = rawClient.length <= 128 ? rawClient : createHash('sha256').update(rawClient).digest('hex');
    this.totalRequests++; this.totalTiles += options.tileCount; this.clients.add(client); this.cacheStatusCounts[options.cacheStatus]++;

    let amenity = options.amenity.slice(0, 256).trim().toLowerCase() || 'unknown';
    if (!this.amenities.has(amenity) && this.amenities.size >= this.maxAmenities) amenity = '[other amenities]';
    let delta = this.amenities.get(amenity);
    if (!delta) {
      delta = { amenity, requests: 0, totalTiles: 0, clients: new DistinctCounter(), geohashCounts: new Map(), geohashPrecision: 12, cacheStatusCounts: statuses(), lastRequestAt: now };
      this.amenities.set(amenity, delta);
    }
    delta.requests++; delta.totalTiles += options.tileCount; delta.lastRequestAt = now; delta.cacheStatusCounts[options.cacheStatus]++;
    delta.clients.add(client);
    const hashes = new Set<string>();
    if (options.tiles?.length) {
      for (const tile of options.tiles) if (/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/i.test(tile.hash)) hashes.add(tile.hash.toLowerCase());
    } else {
      const hash = encodeBounds(options.bbox); if (hash) hashes.add(hash);
    }
    for (const hash of hashes) {
      const key = hash.slice(0, delta.geohashPrecision);
      if (!delta.geohashCounts.has(key)) this.geoEntries++;
      delta.geohashCounts.set(key, (delta.geohashCounts.get(key) ?? 0) + 1);
    }
    if (this.geoEntries > this.maxGeohashes) this.compactGlobalGeohashes();
  }

  takeBatch(): StatsBatch | null {
    if (this.isEmpty) return null;
    const batch: StatsBatch = { batchId: `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`, totalRequests: this.totalRequests, totalTiles: this.totalTiles, totalClients: serialise(this.clients), cacheStatusCounts: { ...this.cacheStatusCounts }, periods: { ...this.periods }, amenities: [...this.amenities.values()].map((item) => ({ ...item, clients: serialise(item.clients), cacheStatusCounts: { ...item.cacheStatusCounts }, geohashCounts: [...item.geohashCounts] })) };
    this.clear();
    return batch;
  }

  clear(): void {
    this.totalRequests = 0; this.totalTiles = 0; this.clients.clear(); Object.assign(this.cacheStatusCounts, statuses()); this.amenities.clear(); this.geoEntries = 0;
    this.periods.dayRequests = 0; this.periods.weekRequests = 0; this.periods.monthRequests = 0;
  }

  private compactGlobalGeohashes(): void {
    while (this.geoEntries > this.maxGeohashes) {
      let changed = false;
      for (const item of this.amenities.values()) {
        if (item.geohashPrecision <= 1) continue;
        changed = true;
        const oldSize = item.geohashCounts.size;
        item.geohashPrecision--;
        const next = new Map<string, number>();
        for (const [hash, count] of item.geohashCounts) { const key = hash.slice(0, item.geohashPrecision); next.set(key, (next.get(key) ?? 0) + count); }
        item.geohashCounts = next;
        this.geoEntries += next.size - oldSize;
      }
      if (!changed) break;
    }
  }
}
