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
        planOptions: { coarsePrecision: 3, finePrecision: 6 },
        run: () => new Promise(() => {})
      });
      queue.enqueue({
        amenity: 'toilets',
        groups,
        planOptions: { coarsePrecision: 3, finePrecision: 6 },
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

  it('coalesces only compatible tasks at enqueue and settles each request', async () => {
    vi.useFakeTimers();
    try {
      const queue = new StaleRefreshQueue(1000);
      let calls = 0;
      let settled = 0;
      let processedHashes: string[] = [];
      const bounds = { south: 0, west: 0, north: 1, east: 1 };
      const groups = [{ bounds, tiles: [{ hash: 'u4pruy', bounds }] }];
      const additionalGroups = [{ bounds, tiles: [{ hash: 'u4pruv', bounds }] }];
      const opts = { coarsePrecision: 3, finePrecision: 6 };
      const run = vi.fn(async (mergedGroups) => {
        calls++;
        processedHashes = mergedGroups.flatMap((group) => group.tiles.map((tile) => tile.hash));
      });
      queue.enqueue({
        amenity: 'toilets', groups, planOptions: opts,
        coalesceKey: 'same-executor', run, onSettled: () => { settled++; }
      });
      queue.enqueue({
        amenity: 'toilets', groups: additionalGroups, planOptions: opts,
        coalesceKey: 'same-executor', run, onSettled: () => { settled++; }
      });
      expect(queue.describeQueue().queuedRequests).toBe(1);
      await vi.runAllTimersAsync();
      expect(calls).toBe(1);
      expect(processedHashes).toEqual(['u4pruv', 'u4pruy']);
      expect(settled).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps tasks with different fetch-plan options separate', async () => {
    const queue = new StaleRefreshQueue(1000);
    const bounds = { south: 0, west: 0, north: 1, east: 1 };
    const groups = [{ bounds, tiles: [{ hash: 'u4pruy', bounds }] }];
    const run = vi.fn(async () => {});
    queue.enqueue({ amenity: 'toilets', groups, coalesceKey: 'executor', planOptions: { coarsePrecision: 3, finePrecision: 6 }, run });
    queue.enqueue({ amenity: 'toilets', groups, coalesceKey: 'executor', planOptions: { coarsePrecision: 4, finePrecision: 6 }, run });
    expect(queue.describeQueue().queuedRequests).toBe(2);
  });

  it('keeps tasks with different coalesce keys separate', () => {
    const queue = new StaleRefreshQueue(1000);
    const bounds = { south: 0, west: 0, north: 1, east: 1 };
    const groups = [{ bounds, tiles: [{ hash: 'u4pruy', bounds }] }];
    const run = vi.fn(async () => {});
    const planOptions = { coarsePrecision: 3, finePrecision: 6 };
    queue.enqueue({ amenity: 'toilets', groups, coalesceKey: 'executor-a', planOptions, run });
    queue.enqueue({ amenity: 'toilets', groups, coalesceKey: 'executor-b', planOptions, run });
    expect(queue.describeQueue().queuedRequests).toBe(2);
  });

  it('aborts timed out work before it can write and continues the queue', async () => {
    vi.useFakeTimers();
    try {
      const queue = new StaleRefreshQueue(20);
      let writes = 0;
      let secondRan = false;
      const bounds = { south: 0, west: 0, north: 1, east: 1 };
      const groups = [{ bounds, tiles: [{ hash: 'u4pruy', bounds }] }];
      queue.enqueue({ amenity: 'toilets', groups, planOptions: { coarsePrecision: 3, finePrecision: 6 },
        coalesceKey: 'cancellable', run: async (_groups, signal) => {
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          if (!signal?.aborted) writes++;
        }
      });
      queue.enqueue({ amenity: 'toilets', groups, planOptions: { coarsePrecision: 3, finePrecision: 6 }, run: async () => { secondRan = true; } });
      await vi.advanceTimersByTimeAsync(25);
      await vi.runAllTimersAsync();
      expect(writes).toBe(0);
      expect(secondRan).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('aborts and drains active work while settling discarded queued work on stop', async () => {
    const queue = new StaleRefreshQueue(0);
    const bounds = { south: 0, west: 0, north: 1, east: 1 };
    const groups = [{ bounds, tiles: [{ hash: 'u4pruy', bounds }] }];
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let abortObserved = false;
    let activeSettled = false;
    let queuedSettled = false;
    let queuedRan = false;
    const planOptions = { coarsePrecision: 3, finePrecision: 6 };

    queue.enqueue({
      amenity: 'toilets', groups, coalesceKey: 'active', planOptions,
      run: async (_groups, signal) => {
        startedResolve();
        signal?.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        await new Promise<void>(() => {});
      },
      onSettled: () => { activeSettled = true; }
    });
    await started;
    queue.enqueue({
      amenity: 'toilets', groups, coalesceKey: 'queued', planOptions,
      run: async () => { queuedRan = true; },
      onSettled: () => { queuedSettled = true; }
    });

    await queue.stop();
    expect(abortObserved).toBe(true);
    expect(activeSettled).toBe(true);
    expect(queuedSettled).toBe(true);
    expect(queuedRan).toBe(false);
    expect(queue.describeQueue().inFlight).toBeUndefined();
  });
});
