import type { FastifyInstance } from 'fastify';
import type { TileStore } from './store.js';

/** Fixed-size, process-local counters. No request data or history is retained. */
export class BasicStatistics {
  private readonly startedAt = Date.now();
  private readonly started = performance.now();
  private requests = 0;
  private clientErrors = 0;
  private serverErrors = 0;
  private hit = 0;
  private miss = 0;
  private stale = 0;
  private uncached = 0;

  public register(app: FastifyInstance): void {
    app.addHook('onResponse', async (request, reply) => {
      // Exclude statistics polling, administration, and preflight requests.
      if (request.routeOptions.url !== '/api/interpreter' || request.method === 'OPTIONS') return;
      this.requests++;
      if (reply.statusCode >= 500) this.serverErrors++;
      else if (reply.statusCode >= 400) this.clientErrors++;
      switch (reply.getHeader('X-Cache')) {
        case 'HIT': this.hit++; break;
        case 'MISS': this.miss++; break;
        case 'STALE': this.stale++; break;
        default: this.uncached++;
      }
    });
  }

  public snapshot(store: TileStore) {
    return {
      mode: 'basic',
      generatedAt: new Date().toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((performance.now() - this.started) / 1000),
      totalRequests: this.requests,
      clientErrors: this.clientErrors,
      serverErrors: this.serverErrors,
      cacheStatus: { HIT: this.hit, MISS: this.miss, STALE: this.stale },
      unclassifiedRequests: this.uncached,
      cacheHitRate: this.requests === 0 ? 0 : Number(((this.hit / this.requests) * 100).toFixed(2)),
      // Reuse the operational presence counters restored at startup and updated on cache operations.
      totalCachedTiles: store.countTotalCachedTiles(),
      cachedAmenities: store.countCachedAmenities(),
      cachedAmenityTypes: store.countCachedAmenityTypes()
    };
  }
}
