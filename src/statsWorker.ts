import { parentPort, workerData } from 'node:worker_threads';
import { Redis } from 'ioredis';

import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import {
  DEFAULT_COVERAGE_REFRESH_INTERVAL_MS,
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
      ttlSeconds: data.config.cacheTtlSeconds,
      swrSeconds: data.config.swrSeconds
    });

    await store.restorePresence();
    const upstreamMetrics = await createUpstreamMetricsProvider(data.config, redis);
    const staleRefreshQueue = new StaleRefreshQueue();

    const refreshIntervalMs =
      data.coverageRefreshIntervalMs ?? DEFAULT_COVERAGE_REFRESH_INTERVAL_MS;

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
        maxGeohashCoverageEntries: data.maxGeohashCoverageEntries
      }
    );

    const refreshStatisticsSnapshot = async (): Promise<void> => {
      await statistics.getSnapshot();
    };

    await refreshStatisticsSnapshot();
    if (refreshIntervalMs > 0) {
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
          await statistics.getSnapshot();
          return;
        case 'cacheCoverage':
        case 'geohashCoverage':
          await statistics.refreshCoverageCaches();
          return;
        case 'all':
        default:
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
      groups: Array<{ bounds: BoundingBox; tiles: TileInfo[] }>
    ): void => {
      staleRefreshQueue.enqueue({
        amenity,
        groups,
        run: async (mergedGroups) => {
          for (const group of mergedGroups) {
            const representative = group.tiles[0];
            if (!representative) continue;

            await store
              .withRefreshLock(representative, amenity, async () => {
                const response = await fetchTile(data.config, group.bounds, amenity, {
                  redis: redis ?? undefined
                });
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

          statistics.markCacheCoverageDirty();
        }
      });
    };

    const handleCommand = async (command: StatsWorkerCommand): Promise<void> => {
      switch (command.type) {
        case 'record':
          await statistics.recordRequest(command.payload);
          return;
        case 'refresh':
          await handleRefresh(command.target);
          return;
        case 'markDirty':
          handleMarkDirty(command.target);
          return;
        case 'staleRefreshTask':
          enqueueStaleRefresh(command.amenity, command.groups);
          await statistics.recordRequest(command.statsPayload);
          return;
        case 'staleRefreshUpdate':
          logger.warn('stale refresh update command is ignored in worker-mode queue');
          return;
        default:
          logger.warn({ command }, 'statistics worker received unknown command');
      }
    };

    parentPort.on('message', (command: StatsWorkerCommand) => {
      void handleCommand(command).catch((error) => {
        logger.warn({ err: error, command }, 'statistics worker command failed');
      });
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
