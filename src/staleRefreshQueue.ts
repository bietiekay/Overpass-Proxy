import type { BoundingBox } from './bbox.js';
import type { TileInfo } from './tiling.js';

import { planTileFetches } from './fetchPlan.js';
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

export type StaleRefreshGroup = {
  bounds: BoundingBox;
  tiles: TileInfo[];
};

export type StaleRefreshPlanOptions = {
  coarsePrecision: number;
  finePrecision: number;
  targetTilesPerRequest?: number;
};

export type StaleRefreshTask = {
  amenity: string;
  groups: StaleRefreshGroup[];
  planOptions: StaleRefreshPlanOptions;
  run: (groups: StaleRefreshGroup[], signal?: AbortSignal) => Promise<void>;
  /** Tasks sharing this key promise that one executor can perform the combined work. */
  coalesceKey?: string;
  onSettled?: () => void | Promise<void>;
};

type QueueEntry = {
  enqueuedAt: number;
  tileGroups: number;
  tiles: number;
  task: StaleRefreshTask;
  settled: Array<() => void | Promise<void>>;
};

type ActiveEntry = QueueEntry & { startedAt: number };

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

export class StaleRefreshQueue implements StaleRefreshQueueMetricsProvider {
  private queued: QueueEntry[] = [];
  private active: ActiveEntry | null = null;
  private activeController: AbortController | null = null;
  private pumping = false;
  private stopped = false;
  private drainPromise: Promise<void> | null = null;
  private lastSettledAt: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS) {}

  public enqueue(task: StaleRefreshTask): void {
    if (this.stopped) {
      if (task.onSettled) {
        void this.runSettledHandlers({
          enqueuedAt: Date.now(),
          tileGroups: 0,
          tiles: 0,
          task,
          settled: [task.onSettled]
        });
      }
      return;
    }
    const groups = this.normalizeGroups(task.groups, task.planOptions);
    const key = this.compatibilityKey(task.amenity, task.planOptions, task.coalesceKey);
    const existing = task.coalesceKey === undefined
      ? undefined
      : this.queued.find((entry) =>
          this.compatibilityKey(
            entry.task.amenity,
            entry.task.planOptions,
            entry.task.coalesceKey
          ) === key
        );

    if (existing) {
      const mergedGroups = this.normalizeGroups(
        [...existing.task.groups, ...groups],
        task.planOptions
      );
      existing.task = { ...existing.task, groups: mergedGroups };
      existing.tileGroups = mergedGroups.length;
      existing.tiles = mergedGroups.reduce((sum, group) => sum + group.tiles.length, 0);
      if (task.onSettled) {
        existing.settled.push(task.onSettled);
      }
    } else {
      const entry: QueueEntry = {
        enqueuedAt: Date.now(),
        tileGroups: groups.length,
        tiles: groups.reduce((sum, group) => sum + group.tiles.length, 0),
        task: { ...task, groups },
        settled: task.onSettled ? [task.onSettled] : []
      };
      this.queued.push(entry);
    }

    this.notify();
    this.schedulePump();
  }

  public describeQueue(): StaleRefreshQueueOverview {
    const oldest = this.active?.enqueuedAt ?? this.queued[0]?.enqueuedAt ?? null;
    const latest =
      this.queued[this.queued.length - 1]?.enqueuedAt ?? this.active?.enqueuedAt ?? null;

    return {
      queuedRequests: this.queued.length,
      queuedTileGroups: this.queued.reduce((sum, entry) => sum + entry.tileGroups, 0),
      queuedTiles: this.queued.reduce((sum, entry) => sum + entry.tiles, 0),
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

  public async stop(): Promise<void> {
    this.stopped = true;
    const discarded = this.queued.splice(0);
    if (discarded.length > 0) {
      this.notify();
    }
    this.activeController?.abort(new Error('Stale refresh queue stopped'));
    for (const entry of discarded) {
      await this.runSettledHandlers(entry);
    }
    await this.drainPromise;
  }

  private compatibilityKey(
    amenity: string,
    plan: StaleRefreshPlanOptions,
    coalesceKey?: string
  ): string {
    return JSON.stringify([
      amenity,
      plan.coarsePrecision,
      plan.finePrecision,
      plan.targetTilesPerRequest ?? null,
      coalesceKey
    ]);
  }

  private schedulePump(): void {
    if (this.pumping) {
      return;
    }

    this.pumping = true;
    queueMicrotask(() => {
      this.drainPromise = this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued.length > 0) {
        const entry = this.queued.shift()!;
        this.active = { ...entry, startedAt: Date.now() };
        this.notify();

        const controller = new AbortController();
        this.activeController = controller;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const abort = new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason ?? new Error('Stale refresh aborted'));
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          const work = entry.task.run(entry.task.groups, controller.signal);
          if (this.taskTimeoutMs > 0) {
            await Promise.race([
              work,
              abort,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  const error = new Error(
                    `Stale refresh task timed out after ${this.taskTimeoutMs}ms`
                  );
                  error.name = 'StaleRefreshTaskTimeout';
                  controller.abort(error);
                  reject(error);
                }, this.taskTimeoutMs);
              })
            ]);
          } else {
            await Promise.race([work, abort]);
          }
        } catch (error) {
          const timeout = error instanceof Error && error.name === 'StaleRefreshTaskTimeout';
          logger.warn(
            { err: error, timeoutMs: this.taskTimeoutMs },
            timeout
              ? 'stale refresh task timed out'
              : 'failed to refresh stale tiles in background'
          );
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (onAbort) {
            controller.signal.removeEventListener('abort', onAbort);
          }
          if (this.activeController === controller) {
            this.activeController = null;
          }
          for (const callback of entry.settled) {
            try {
              await callback();
            } catch (error) {
              logger.warn({ err: error }, 'failed stale refresh queue settled handler');
            }
          }
          this.active = null;
          this.lastSettledAt = Date.now();
          this.notify();
        }
      }
    } finally {
      this.pumping = false;
      if (this.queued.length > 0 && !this.stopped) {
        this.schedulePump();
      }
    }
  }

  private async runSettledHandlers(entry: QueueEntry): Promise<void> {
    for (const callback of entry.settled) {
      try {
        await callback();
      } catch (error) {
        logger.warn({ err: error }, 'failed stale refresh queue settled handler');
      }
    }
  }

  private normalizeGroups(
    groups: StaleRefreshGroup[],
    options: StaleRefreshPlanOptions
  ): StaleRefreshGroup[] {
    const byHash = new Map<string, TileInfo>();
    for (const group of groups) {
      for (const tile of group.tiles) {
        byHash.set(tile.hash, tile);
      }
    }

    return planTileFetches(Array.from(byHash.values()), options);
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
