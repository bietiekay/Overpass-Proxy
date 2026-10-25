import { createHash } from 'node:crypto';

/** Exact for small populations; bounded HyperLogLog (4096 registers, ~1.6% error) thereafter. */
export class DistinctCounter {
  private exact = new Set<string>();
  private registers: Uint8Array | null = null;
  static readonly exactLimit = 1024;

  constructor(values: Iterable<string> = [], sketch?: string) {
    if (sketch) {
      const bytes = Buffer.from(sketch, 'base64');
      if (bytes.length === 4096 && bytes.every((value) => value <= 21)) {
        this.registers = new Uint8Array(bytes);
      }
    }
    for (const value of values) this.add(value);
  }

  add(value: string): void {
    if (!this.registers) {
      this.exact.add(value);
      if (this.exact.size <= DistinctCounter.exactLimit) return;
      this.registers = new Uint8Array(4096);
      for (const client of this.exact) this.addHash(client);
      this.exact.clear();
      return;
    }
    this.addHash(value);
  }

  private addHash(value: string): void {
    const hash = createHash('sha256').update(value).digest().readUInt32BE(0);
    const bucket = hash >>> 20;
    const rank = Math.min(21, Math.clz32((hash << 12) >>> 0) + 1);
    this.registers![bucket] = Math.max(this.registers![bucket], rank);
  }

  get size(): number {
    if (!this.registers) return this.exact.size;
    let sum = 0;
    let empty = 0;
    for (const rank of this.registers) {
      sum += 2 ** -rank;
      if (rank === 0) empty++;
    }
    const estimate = (0.7213 / (1 + 1.079 / 4096)) * 4096 ** 2 / sum;
    return Math.round(estimate <= 2.5 * 4096 && empty > 0
      ? 4096 * Math.log(4096 / empty) : estimate);
  }

  merge(other: DistinctCounter): void {
    if (!other.registers) {
      for (const value of other.exact) this.add(value);
      return;
    }
    if (!this.registers) {
      this.registers = new Uint8Array(4096);
      for (const value of this.exact) this.addHash(value);
      this.exact.clear();
    }
    for (let i = 0; i < 4096; i++) {
      this.registers[i] = Math.max(this.registers[i], other.registers[i]);
    }
  }

  clear(): void { this.exact.clear(); this.registers = null; }
  values(): string[] { return [...this.exact]; }
  sketch(): string | undefined {
    return this.registers ? Buffer.from(this.registers).toString('base64') : undefined;
  }
}
