interface TokenBucketOptions {
  capacity: number;
  refillRate: number; // tokens per second
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly options: TokenBucketOptions) {
    this.tokens = options.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) {
      return;
    }

    this.tokens = Math.min(this.options.capacity, this.tokens + elapsed * this.options.refillRate);
    this.lastRefill = now;
  }

  public tryRemove(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) {
      return false;
    }

    this.tokens -= cost;
    return true;
  }
}
