import { describe, expect, it, vi } from 'vitest';

import { StaleRefreshQueue } from '../../staleRefreshQueue.js';

describe('StaleRefreshQueue', () => {
  it('continues after a task timeout', async () => {
    vi.useFakeTimers();

    try {
      const queue = new StaleRefreshQueue(50);
      const completed: string[] = [];
      const groups = [
        {
          bounds: { south: 0, west: 0, north: 1, east: 1 },
          tiles: [{ hash: 'u4pruy', bounds: { south: 0, west: 0, north: 1, east: 1 } }]
        }
      ];

      queue.enqueue({
        amenity: 'toilets',
        groups,
        run: () => new Promise(() => {})
      });
      queue.enqueue({
        amenity: 'toilets',
        groups,
        run: async () => {
          completed.push('second');
        }
      });

      await vi.advanceTimersByTimeAsync(60);
      await vi.runAllTicks();
      await vi.runAllTimersAsync();

      expect(completed).toEqual(['second']);
      const overview = queue.describeQueue();
      expect(overview.queuedRequests).toBe(0);
      expect(overview.inFlight).toBeUndefined();
      expect(overview.lastSettledAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
