import { describe, expect, it } from 'vitest';

import { DistinctCounter } from '../../distinctCounter.js';

describe('DistinctCounter', () => {
  it('keeps small populations exact, including duplicates and restored values', () => {
    const counter = new DistinctCounter(['a', 'a', 'b']);
    expect(counter.size).toBe(2);
    expect(counter.sketch()).toBeUndefined();
    expect(new DistinctCounter(counter.values()).size).toBe(2);
  });

  it('bounds large populations and preserves estimates across restore and merge', () => {
    const counter = new DistinctCounter();
    const other = new DistinctCounter();
    for (let i = 0; i < 100000; i++) {
      counter.add(`client-${i}`);
      other.add(`client-${i + 50000}`);
    }
    expect(counter.values()).toEqual([]);
    expect(Buffer.from(counter.sketch()!, 'base64')).toHaveLength(4096);
    expect(counter.size).toBeGreaterThan(97000);
    expect(counter.size).toBeLessThan(103000);
    const restored = new DistinctCounter([], counter.sketch());
    expect(restored.size).toBe(counter.size);
    restored.merge(other);
    expect(restored.size).toBeGreaterThan(145000);
    expect(restored.size).toBeLessThan(155000);
    const exact = new DistinctCounter(['client-0']);
    exact.merge(counter);
    expect(exact.size).toBe(counter.size);
  });
});
