import { EventEmitter } from 'node:events';

export class InMemoryRedis extends EventEmitter {
  private store = new Map<string, string>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private expiry = new Map<string, number>();

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
      const expiresAt = Date.now() + duration;
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.timeouts.delete(key);
        this.expiry.delete(key);
      }, duration).unref();
      this.timeouts.set(key, timeout);
      this.expiry.set(key, expiresAt);
    } else {
      this.expiry.delete(key);
    }

    return 'OK';
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.store.get(key) ?? null);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const existed = this.store.delete(key);
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
    this.expiry.delete(key);
    return existed ? 1 : 0;
  }

  async incrby(key: string, increment: number): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    const next = current + increment;
    this.store.set(key, String(next));
    return next;
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async decrby(key: string, decrement: number): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    const next = current - decrement;
    this.store.set(key, String(next));
    return next;
  }

  async pttl(key: string): Promise<number> {
    if (!this.store.has(key)) {
      return -2;
    }

    const expiresAt = this.expiry.get(key);
    if (!expiresAt) {
      return -1;
    }

    return Math.max(0, expiresAt - Date.now());
  }

  async quit(): Promise<'OK'> {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.expiry.clear();
    this.store.clear();
    return 'OK';
  }

  async flushall(): Promise<'OK'> {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.expiry.clear();
    this.store.clear();
    return 'OK';
  }

  async scan(cursor: string | number, ...args: Array<string | number>): Promise<[string, string[]]> {
    const startIndex = Number(cursor ?? 0);
    let matchPattern = '*';
    let count = Infinity;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === 'MATCH' && typeof args[i + 1] === 'string') {
        matchPattern = args[i + 1] as string;
        i += 1;
      } else if (arg === 'COUNT' && typeof args[i + 1] === 'number') {
        count = args[i + 1] as number;
        i += 1;
      }
    }

    const regex = new RegExp('^' + matchPattern.replace(/\*/g, '.*') + '$');
    const allKeys = Array.from(this.store.keys()).filter((key) => regex.test(key));

    const slice = allKeys.slice(startIndex, startIndex + count);
    const nextCursor = startIndex + count >= allKeys.length ? '0' : String(startIndex + count);
    return [nextCursor, slice];
  }

  pipeline(): {
    exists: (key: string) => ReturnType<InMemoryRedis['pipeline']>;
    set: (
      key: string,
      value: string,
      mode?: string,
      duration?: number,
      condition?: string
    ) => ReturnType<InMemoryRedis['pipeline']>;
    del: (key: string) => ReturnType<InMemoryRedis['pipeline']>;
    exec: () => Promise<Array<[Error | null, unknown]>>;
  } {
    const commands: Array<() => Promise<unknown>> = [];
    const parent = this;

    const pipeline = {
      exists(key: string) {
        commands.push(() => parent.exists(key));
        return pipeline;
      },
      set(
        key: string,
        value: string,
        mode?: string,
        duration?: number,
        condition?: string
      ) {
        commands.push(() => parent.set(key, value, mode, duration, condition));
        return pipeline;
      },
      del(key: string) {
        commands.push(() => parent.del(key));
        return pipeline;
      },
      async exec() {
        const results: Array<[Error | null, unknown]> = [];
        for (const command of commands) {
          try {
            const result = await command();
            results.push([null, result]);
          } catch (error) {
            results.push([error as Error, undefined]);
          }
        }
        return results;
      }
    } as const;

    return pipeline;
  }
}
