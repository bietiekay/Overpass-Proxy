import { parentPort, workerData } from 'node:worker_threads';
import { Redis } from 'ioredis';

import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import {
  RequestStatistics,
  RedisStatisticsStorage,
  type StatsWorkerCommand,
  type StatsWorkerNotification,
  type StatisticsRefreshTarget
} from './stats.js';
import { TileStore, filterElementsByBbox } from './store.js';
import type { TileInfo } from './tiling.js';
import { StaleRefreshQueue } from './staleRefreshQueue.js';
import { fetchTile, createUpstreamMetricsProvider } from './upstream.js';
import type { BoundingBox } from './bbox.js';

interface StatisticsWorkerData {
  config: AppConfig;
  redisUrl: string;
  coverageRefreshIntervalMs?: number;
  coverageCacheTtlMs?: number;
  maxCacheCoverageEntries?: number;
  maxGeohashCoverageEntries?: number;
}

const envInteger = (name: string, fallback: number, minimum = 0): number => {
  const parsed = Number(process.env[name]);
  return Math.max(minimum, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
};

const shutdownRedis = async (redis: Redis | null): Promise<void> => {
  if (!redis) {
    return;
  }

  try {
    await redis.quit();
  } catch (error) {
    logger.warn({ err: error }, 'failed to shut down statistics worker Redis client');
  }
};

const bootstrap = async (): Promise<void> => {
  if (!parentPort) {
    throw new Error('statistics worker missing parent port');
  }

  let redis: Redis | null = null;

  try {
    const data = workerData as StatisticsWorkerData;
    redis = new Redis(data.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    await redis.connect();

    const store = new TileStore(redis, {
      metricsOnly: true,
      metricsMaxCoverageEntries: data.maxCacheCoverageEntries,
      metricsRefreshIntervalMs: Math.min(30000, Math.max(0, data.coverageRefreshIntervalMs ?? 300000)),
      ttlSeconds: data.config.cacheTtlSeconds,
      swrSeconds: data.config.swrSeconds
    });

    await store.refreshMetrics();
    const upstreamMetrics = await createUpstreamMetricsProvider(data.config, redis);
    const staleRefreshQueue = new StaleRefreshQueue();

    const refreshIntervalMs =
      data.coverageRefreshIntervalMs ?? envInteger('STATS_SNAPSHOT_INTERVAL_MS', 10 * 60 * 1000);

    const statistics = await RequestStatistics.create(
      store,
      new RedisStatisticsStorage(redis),
      upstreamMetrics,
      {
        redis,
        staleRefreshQueue,
        coverageRefreshIntervalMs: data.coverageRefreshIntervalMs,
        coverageCacheTtlMs: data.coverageCacheTtlMs,
        maxCacheCoverageEntries: data.maxCacheCoverageEntries,
        maxGeohashCoverageEntries: data.maxGeohashCoverageEntries,
        maxTrackedAmenities: envInteger('STATS_MAX_AMENITIES', 256, 1),
        maxTotalRequestGeohashEntries: envInteger('STATS_MAX_REQUEST_GEOHASHES', 20_000, 32),
        persistenceIntervalMs: envInteger('STATS_PERSIST_INTERVAL_MS', 30_000),
        snapshotRefreshIntervalMs: data.coverageRefreshIntervalMs ?? envInteger('STATS_SNAPSHOT_INTERVAL_MS', 10 * 60 * 1000)
      }
    );

    const refreshStatisticsSnapshot = async (): Promise<void> => {
      statistics.markStatisticsDirty();
      await statistics.getSnapshot();
    };

    if (data.config.statisticsEnabled) await refreshStatisticsSnapshot();
    if (data.config.statisticsEnabled && refreshIntervalMs > 0) {
      setInterval(() => {
        void refreshStatisticsSnapshot().catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to refresh statistics snapshot');
        });
      }, refreshIntervalMs).unref();
    }

    const notifyReady: StatsWorkerNotification = { type: 'ready' };
    parentPort.postMessage(notifyReady);

    const handleRefresh = async (target: StatisticsRefreshTarget): Promise<void> => {
      switch (target) {
        case 'statistics':
          statistics.markStatisticsDirty();
          await statistics.getSnapshot();
          return;
        case 'cacheCoverage':
        case 'geohashCoverage':
          await statistics.refreshCoverageCaches();
          return;
        case 'all':
        default:
          statistics.markStatisticsDirty();
          await Promise.all([statistics.getSnapshot(), statistics.refreshCoverageCaches()]);
          return;
      }
    };

    const handleMarkDirty = (target: StatisticsRefreshTarget): void => {
      switch (target) {
        case 'statistics':
          statistics.markStatisticsDirty();
          return;
        case 'cacheCoverage':
          statistics.markCacheCoverageDirty();
          return;
        case 'geohashCoverage':
          statistics.markGeohashCoverageDirty();
          return;
        case 'all':
        default:
          statistics.markStatisticsDirty();
          statistics.markCacheCoverageDirty();
          statistics.markGeohashCoverageDirty();
          return;
      }
    };

    const enqueueStaleRefresh = (
      amenity: string,
      groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>,
      planOptions: {
        coarsePrecision: number;
        finePrecision: number;
        targetTilesPerRequest?: number;
      }
    ): void => {
      staleRefreshQueue.enqueue({
        amenity,
        groups,
        planOptions,
        coalesceKey: 'stats-worker-stale-tile-refresh',
        run: async (mergedGroups, signal) => {
          for (const group of mergedGroups) {
            if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
            const representative = group.tiles[0];
            if (!representative) continue;

            await store
              .withRefreshLock(representative, amenity, async () => {
                if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
                const response = await fetchTile(data.config, group.bounds, amenity, {
                  redis: redis ?? undefined,
                  signal
                });
                if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
                const entries = group.tiles.map((fine) => ({
                  tile: fine,
                  response: {
                    ...response,
                    elements: filterElementsByBbox(response.elements, fine.bounds)
                  }
                }));
                await store.writeTiles(entries, amenity);
              })
              .catch((error: unknown) => {
                logger.warn({ err: error }, 'failed stale refresh task in worker');
              });
          }
          if (signal?.aborted) throw signal.reason ?? new Error('Stale refresh aborted');
          statistics.markCacheCoverageDirty();
        }
      });
    };

    const handleCommand = async (command: StatsWorkerCommand): Promise<void> => {
      switch (command.type) {
        case 'recordBatch':
          if (!appliedBatchIds.has(command.batch.batchId)) {
            await statistics.recordBatch(command.batch);
            appliedBatchIds.add(command.batch.batchId);
            if (appliedBatchIds.size > 512) appliedBatchIds.delete(appliedBatchIds.values().next().value!);
          }
          parentPort!.postMessage({ type: 'ack', batchId: command.batch.batchId });
          return;
        case 'shutdown':
          for (const batch of command.batches ?? []) {
            if (appliedBatchIds.has(batch.batchId)) continue;
            await statistics.recordBatch(batch);
            appliedBatchIds.add(batch.batchId);
          }
          await statistics.close();
          parentPort!.postMessage({ type: 'stopped' });
          await shutdownRedis(redis);
          return;
        case 'notifications':
          try {
            for (const target of command.dirtyTargets) handleMarkDirty(target);
            for (const target of command.refreshTargets) await handleRefresh(target);
          } catch (error) {
            logger.warn({ err: error, notificationId: command.notificationId }, 'statistics notification command failed');
          } finally {
            parentPort!.postMessage({ type: 'notificationAck', notificationId: command.notificationId });
          }
          return;
        case 'refresh':
          await handleRefresh(command.target);
          return;
        case 'markDirty':
          handleMarkDirty(command.target);
          return;
        case 'staleRefreshTask':
          enqueueStaleRefresh(command.amenity, command.groups, command.planOptions);
          return;
        case 'staleRefreshUpdate':
          logger.warn('stale refresh update command is ignored in worker-mode queue');
          return;
        default:
          logger.warn({ command }, 'statistics worker received unknown command');
      }
    };

    const appliedBatchIds = new Set<string>();
    let batchQueue = Promise.resolve();
    parentPort.on('message', (command: StatsWorkerCommand) => {
      const run = () => handleCommand(command).catch((error) => {
        logger.warn({ err: error, command }, 'statistics worker command failed');
      });
      if (command.type === 'recordBatch') {
        batchQueue = batchQueue.then(run);
      } else if (command.type === 'shutdown') {
        void batchQueue.then(run);
      } else {
        void run();
      }
    });

    parentPort.on('close', () => {
      void shutdownRedis(redis);
    });

    process.on('SIGTERM', () => {
      void shutdownRedis(redis);
    });

    process.on('SIGINT', () => {
      void shutdownRedis(redis);
    });
  } catch (error) {
    logger.error({ err: error }, 'statistics worker failed to start');
    await shutdownRedis(redis);
    process.exitCode = 1;
  }
};

void bootstrap();
