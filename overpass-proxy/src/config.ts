import { env } from 'node:process';

export interface AppConfig {
  port: number;
  upstreamUrl: string;
  redisUrl: string;
  cacheTtlSeconds: number;
  swrSeconds: number;
  tilePrecision: number;
  maxTilesPerRequest: number;
  nodeEnv: string;
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const loadConfig = (): AppConfig => {
  const cacheTtl = toNumber(env.CACHE_TTL_SECONDS, 24 * 60 * 60);
  const swr = Math.max(30, Math.floor(cacheTtl / 10));

  return {
    port: toNumber(env.PORT, 8080),
    upstreamUrl: env.UPSTREAM_URL ?? 'https://overpass-api.de/api/interpreter',
    redisUrl: env.REDIS_URL ?? 'redis://redis:6379',
    cacheTtlSeconds: cacheTtl,
    swrSeconds: toNumber(env.SWR_SECONDS, swr),
    tilePrecision: toNumber(env.TILE_PRECISION, 5),
    maxTilesPerRequest: toNumber(env.MAX_TILES_PER_REQUEST, 1024),
    nodeEnv: env.NODE_ENV ?? 'production'
  };
};
