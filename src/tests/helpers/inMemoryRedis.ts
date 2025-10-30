import { EventEmitter } from 'node:events';

export class InMemoryRedis extends EventEmitter {
  private store = new Map<string, string>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

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

  pipeline(): {
    set: (
      key: string,
      value: string,
      mode?: string,
      duration?: number,
      condition?: string
    ) => ReturnType<InMemoryRedis['pipeline']>;
    exec: () => Promise<Array<[Error | null, unknown]>>;
  } {
    const commands: Array<() => Promise<unknown>> = [];
    const parent = this;

    const pipeline = {
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
