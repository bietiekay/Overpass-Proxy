import { EventEmitter } from 'node:events';

export class InMemoryRedis extends EventEmitter {
  private store = new Map<string, string>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  async set(key: string, value: string, mode?: string, duration?: number, condition?: string): Promise<'OK' | null> {
    if (condition === 'NX' && this.store.has(key)) {
      return null;
    }

    this.store.set(key, value);
    if (mode === 'PX' && typeof duration === 'number') {
      const existing = this.timeouts.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.timeouts.delete(key);
      }, duration).unref();
      this.timeouts.set(key, timeout);
    }

    return 'OK';
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.store.get(key) ?? null);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    const existed = this.store.delete(key);
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
    return existed ? 1 : 0;
  }

  async quit(): Promise<'OK'> {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.store.clear();
    return 'OK';
  }

  async flushall(): Promise<'OK'> {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.store.clear();
    return 'OK';
  }

  pipeline(): InMemoryPipeline {
    return new InMemoryPipeline(this);
  }
}

class InMemoryPipeline {
  private commands: Array<() => Promise<'OK' | null>> = [];

  constructor(private readonly redis: InMemoryRedis) {}

  set(key: string, value: string, mode?: string, duration?: number, condition?: string): this {
    this.commands.push(() => this.redis.set(key, value, mode, duration, condition));
    return this;
  }

  async exec(): Promise<Array<[Error | null, 'OK' | null]>> {
    const results: Array<[Error | null, 'OK' | null]> = [];
    for (const command of this.commands) {
      try {
        const result = await command();
        results.push([null, result]);
      } catch (error) {
        results.push([error as Error, null]);
      }
    }
    this.commands = [];
    return results;
  }
}
