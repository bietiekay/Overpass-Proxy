import { describe, expect, it } from 'vitest';

import { TokenBucket } from '../../rateLimit.js';

describe('TokenBucket', () => {
  it('allows limited requests', () => {
    const bucket = new TokenBucket({ capacity: 2, refillRate: 1 });
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('refills over time', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 100 });
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bucket.tryRemove()).toBe(true);
  });
});
