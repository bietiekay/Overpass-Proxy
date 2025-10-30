import { env } from 'node:process';

export interface AppConfig {
  port: number;
  upstreamUrls: string[];
  redisUrl: string;
  cacheTtlSeconds: number;
  swrSeconds: number;
  tilePrecision: number;
  upstreamTilePrecision: number;
  maxTilesPerRequest: number;
  nodeEnv: string;
  upstreamFailureCooldownSeconds: number;
  transparentOnly: boolean;
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalised = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalised)) {
    return false;
  }

  return fallback;
};

export const loadConfig = (): AppConfig => {
  const cacheTtl = toNumber(env.CACHE_TTL_SECONDS, 24 * 60 * 60);
  const swr = Math.max(30, Math.floor(cacheTtl / 10));
  const tilePrecision = toNumber(env.TILE_PRECISION, 5);
  // target ~2 levels coarser to get ~32x coverage (to cover ~50 tiles minimum)
  const upstreamTilePrecision = toNumber(env.UPSTREAM_TILE_PRECISION, Math.max(2, tilePrecision - 2));

  const parseUpstreamUrls = (raw: string | undefined): string[] => {
    if (!raw) {
      return [];
    }

    return raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  };

  const upstreamUrls = parseUpstreamUrls(env.UPSTREAM_URLS);
  if (upstreamUrls.length === 0) {
    upstreamUrls.push(env.UPSTREAM_URL ?? 'https://overpass-api.de/api/interpreter');
  }

  return {
    port: toNumber(env.PORT, 8080),
    upstreamUrls,
    redisUrl: env.REDIS_URL ?? 'redis://redis:6379',
    cacheTtlSeconds: cacheTtl,
    swrSeconds: toNumber(env.SWR_SECONDS, swr),
    tilePrecision,
    upstreamTilePrecision,
    maxTilesPerRequest: toNumber(env.MAX_TILES_PER_REQUEST, 1024),
    nodeEnv: env.NODE_ENV ?? 'production',
    upstreamFailureCooldownSeconds: toNumber(env.UPSTREAM_FAILURE_COOLDOWN_SECONDS, 60),
    transparentOnly: toBoolean(env.TRANSPARENT_ONLY, false)
  };
};
