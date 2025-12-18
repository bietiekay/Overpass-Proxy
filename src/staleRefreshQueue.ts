import { logger } from './logger.js';

export interface StaleRefreshQueueOverview {
  queuedRequests: number;
  queuedTileGroups: number;
  queuedTiles: number;
  oldestEnqueuedAt?: string;
  latestEnqueuedAt?: string;
  lastSettledAt?: string;
  inFlight?: {
    enqueuedAt: string;
    startedAt: string;
    tileGroups: number;
    tiles: number;
  };
}

export interface StaleRefreshQueueMetricsProvider {
  describeQueue(): StaleRefreshQueueOverview;
  onUpdate?(listener: () => void): void;
}

type QueueEntry = {
  enqueuedAt: number;
  tileGroups: number;
  tiles: number;
};

type ActiveEntry = QueueEntry & { startedAt: number };

export class StaleRefreshQueue implements StaleRefreshQueueMetricsProvider {
  private tail: Promise<void> = Promise.resolve();

  private queued: QueueEntry[] = [];

  private active: ActiveEntry | null = null;

  private lastSettledAt: number | null = null;

  private readonly listeners = new Set<() => void>();

  public enqueue(task: () => Promise<void>, meta: { tileGroups: number; tiles: number }): void {
    const entry: QueueEntry = {
      enqueuedAt: Date.now(),
      tileGroups: meta.tileGroups,
      tiles: meta.tiles
    };

    this.queued.push(entry);
    this.notify();

    this.tail = this.tail
      .catch((error) => {
        logger.warn({ err: error }, 'failed stale refresh queue task');
      })
      .then(async () => {
        this.active = { ...entry, startedAt: Date.now() };
        this.queued = this.queued.filter((queuedEntry) => queuedEntry !== entry);
        this.notify();

        try {
          await task();
        } catch (error) {
          logger.warn({ err: error }, 'failed to refresh stale tiles in background');
        } finally {
          this.active = null;
          this.lastSettledAt = Date.now();
          this.notify();
        }
      });
  }

  public describeQueue(): StaleRefreshQueueOverview {
    const oldest = this.active?.enqueuedAt ?? this.queued[0]?.enqueuedAt ?? null;
    const latest =
      this.queued[this.queued.length - 1]?.enqueuedAt ?? this.active?.enqueuedAt ?? null;

    const queuedTileGroups = this.queued.reduce((sum, entry) => sum + entry.tileGroups, 0);
    const queuedTiles = this.queued.reduce((sum, entry) => sum + entry.tiles, 0);

    return {
      queuedRequests: this.queued.length,
      queuedTileGroups,
      queuedTiles,
      oldestEnqueuedAt: oldest ? new Date(oldest).toISOString() : undefined,
      latestEnqueuedAt: latest ? new Date(latest).toISOString() : undefined,
      lastSettledAt: this.lastSettledAt ? new Date(this.lastSettledAt).toISOString() : undefined,
      inFlight: this.active
        ? {
            enqueuedAt: new Date(this.active.enqueuedAt).toISOString(),
            startedAt: new Date(this.active.startedAt).toISOString(),
            tileGroups: this.active.tileGroups,
            tiles: this.active.tiles
          }
        : undefined
    };
  }

  public onUpdate(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn({ err: error }, 'stale refresh queue listener failed');
      }
    }
  }
}
