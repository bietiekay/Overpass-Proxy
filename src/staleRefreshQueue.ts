import type { BoundingBox } from './bbox.js';
import type { TileInfo } from './tiling.js';

import { boundsForHash, tilesForBoundingBox } from './tiling.js';
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
  task: StaleRefreshTask;
};

type ActiveEntry = QueueEntry & { startedAt: number };

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const COARSE_GEOHASH_PRECISION = 4;

export type StaleRefreshGroup = {
  bounds: BoundingBox;
  tiles: TileInfo[];
};

export type StaleRefreshTask = {
  amenity: string;
  groups: StaleRefreshGroup[];
  run: (groups: StaleRefreshGroup[]) => Promise<void>;
  onSettled?: () => void | Promise<void>;
};

export class StaleRefreshQueue implements StaleRefreshQueueMetricsProvider {
  private tail: Promise<void> = Promise.resolve();

  private queued: QueueEntry[] = [];

  private active: ActiveEntry | null = null;

  private lastSettledAt: number | null = null;

  private readonly listeners = new Set<() => void>();

  constructor(private readonly taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS) {}

  public enqueue(task: StaleRefreshTask): void {
    const tileGroups = task.groups.length;
    const tiles = task.groups.reduce((total, group) => total + group.tiles.length, 0);
    const entry: QueueEntry = {
      enqueuedAt: Date.now(),
      tileGroups,
      tiles,
      task
    };

    this.queued.push(entry);
    this.notify();

    this.tail = this.tail
      .catch((error) => {
        logger.warn({ err: error }, 'failed stale refresh queue task');
      })
      .then(async () => {
        const nextEntry = this.takeNextEntry();
        if (!nextEntry) {
          return;
        }
        this.active = { ...nextEntry, startedAt: Date.now() };
        this.notify();

        try {
          await this.runWithTimeout(() => nextEntry.task.run(nextEntry.task.groups));
        } catch (error) {
          if (this.isTimeoutError(error)) {
            logger.warn(
              { err: error, timeoutMs: this.taskTimeoutMs },
              'stale refresh task timed out'
            );
          } else {
            logger.warn({ err: error }, 'failed to refresh stale tiles in background');
          }
        } finally {
          await this.runSettledHandlers(nextEntry);
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

  private async runWithTimeout(task: () => Promise<void>): Promise<void> {
    if (this.taskTimeoutMs <= 0) {
      await task();
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task(),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(
              `Stale refresh task timed out after ${this.taskTimeoutMs}ms`
            );
            error.name = 'StaleRefreshTaskTimeout';
            reject(error);
          }, this.taskTimeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === 'StaleRefreshTaskTimeout';
  }

  private takeNextEntry(): QueueEntry | null {
    if (this.queued.length === 0) {
      return null;
    }

    const baseEntry = this.queued[0];
    if (!baseEntry) {
      return null;
    }

    const amenity = baseEntry.task.amenity;
    const matching = this.queued.filter((entry) => entry.task.amenity === amenity);
    if (matching.length <= 1) {
      this.queued = this.queued.filter((entry) => entry !== baseEntry);
      return baseEntry;
    }

    const merged = this.mergeEntries(matching);
    this.queued = this.queued.filter((entry) => entry.task.amenity !== amenity);
    return merged;
  }

  private mergeEntries(entries: QueueEntry[]): QueueEntry {
    const allGroups = entries.flatMap((entry) => entry.task.groups);
    const mergedGroups = this.mergeGroupsByPrefix(allGroups);
    const tileGroups = mergedGroups.length;
    const tiles = mergedGroups.reduce((total, group) => total + group.tiles.length, 0);
    const enqueuedAt = Math.min(...entries.map((entry) => entry.enqueuedAt));
    const callbacks = entries.map((entry) => entry.task.onSettled).filter(Boolean) as Array<
      () => void | Promise<void>
    >;
    const baseTask = entries[0]?.task;
    if (!baseTask) {
      throw new Error('Cannot merge empty stale refresh queue');
    }

    return {
      enqueuedAt,
      tileGroups,
      tiles,
      task: {
        amenity: baseTask.amenity,
        groups: mergedGroups,
        run: baseTask.run,
        onSettled: callbacks.length
          ? async () => {
              for (const callback of callbacks) {
                await callback();
              }
            }
          : undefined
      }
    };
  }

  private mergeGroupsByPrefix(groups: StaleRefreshGroup[]): StaleRefreshGroup[] {
    const tilesByHash = new Map<string, TileInfo>();
    for (const group of groups) {
      for (const tile of group.tiles) {
        tilesByHash.set(tile.hash, tile);
      }
    }

    const tilesByPrefix = new Map<string, TileInfo[]>();
    for (const tile of tilesByHash.values()) {
      const prefix = tile.hash.slice(0, Math.min(COARSE_GEOHASH_PRECISION, tile.hash.length));
      const bucket = tilesByPrefix.get(prefix) ?? [];
      bucket.push(tile);
      tilesByPrefix.set(prefix, bucket);
    }

    const mergedGroups: StaleRefreshGroup[] = [];
    for (const [prefix, tiles] of tilesByPrefix) {
      if (tiles.length >= 2 && prefix.length === COARSE_GEOHASH_PRECISION) {
        const finePrecision = Math.max(
          COARSE_GEOHASH_PRECISION,
          ...tiles.map((tile) => tile.hash.length)
        );
        const bounds = boundsForHash(prefix);
        mergedGroups.push({
          bounds,
          tiles: tilesForBoundingBox(bounds, finePrecision)
        });
      } else {
        for (const tile of tiles) {
          mergedGroups.push({ bounds: tile.bounds, tiles: [tile] });
        }
      }
    }

    return mergedGroups;
  }

  private async runSettledHandlers(entry: QueueEntry): Promise<void> {
    if (!entry.task.onSettled) {
      return;
    }

    try {
      await entry.task.onSettled();
    } catch (error) {
      logger.warn({ err: error }, 'failed stale refresh queue settled handler');
    }
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
