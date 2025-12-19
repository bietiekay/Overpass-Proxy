import { describe, expect, it, vi } from 'vitest';

import { StaleRefreshQueue } from '../../staleRefreshQueue.js';

const meta = { tileGroups: 1, tiles: 1 };

describe('StaleRefreshQueue', () => {
  it('continues after a task timeout', async () => {
    vi.useFakeTimers();

    try {
      const queue = new StaleRefreshQueue(50);
      const completed: string[] = [];

      queue.enqueue(() => new Promise(() => {}), meta);
      queue.enqueue(async () => {
        completed.push('second');
      }, meta);

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
