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
  upstreamBackoffBaseSeconds: number;
  upstreamBackoffMaxSeconds: number;
  upstreamEwmaAlpha: number;
  upstreamStickinessTtlSeconds: number;
  upstreamProbeIntervalSeconds: number;
  upstreamProbeJitterSeconds: number;
  upstreamProbeTimeoutSeconds: number;
  upstreamRequestTimeoutSeconds: number;
  transparentOnly: boolean;
  upstreamDailyLimit: number;
  trustProxy: boolean;
  upstreamOrigin: string;
  upstreamReferer: string;
  serveStaleFromCache: boolean;
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
  const failureCooldownSeconds = toNumber(env.UPSTREAM_FAILURE_COOLDOWN_SECONDS, 60);
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
    upstreamFailureCooldownSeconds: failureCooldownSeconds,
    upstreamBackoffBaseSeconds: toNumber(env.UPSTREAM_BACKOFF_BASE_SECONDS, failureCooldownSeconds),
    upstreamBackoffMaxSeconds: toNumber(env.UPSTREAM_BACKOFF_MAX_SECONDS, 600),
    upstreamEwmaAlpha: Math.min(1, Math.max(0.01, toNumber(env.UPSTREAM_EWMA_ALPHA, 0.3))),
    upstreamStickinessTtlSeconds: Math.max(0, toNumber(env.UPSTREAM_STICKINESS_TTL_SECONDS, 300)),
    upstreamProbeIntervalSeconds: Math.max(0, toNumber(env.UPSTREAM_PROBE_INTERVAL_SECONDS, 60)),
    upstreamProbeJitterSeconds: Math.max(0, toNumber(env.UPSTREAM_PROBE_JITTER_SECONDS, 15)),
    upstreamProbeTimeoutSeconds: Math.max(1, toNumber(env.UPSTREAM_PROBE_TIMEOUT_SECONDS, 5)),
    upstreamRequestTimeoutSeconds: Math.max(
      1,
      toNumber(env.UPSTREAM_REQUEST_TIMEOUT_SECONDS, Math.min(30, failureCooldownSeconds))
    ),
    transparentOnly: toBoolean(env.TRANSPARENT_ONLY, false),
    upstreamDailyLimit: toNumber(env.UPSTREAM_DAILY_LIMIT, -1),
    trustProxy: toBoolean(env.TRUST_PROXY, false),
    upstreamOrigin: env.UPSTREAM_ORIGIN ?? 'https://overpass-turbo.eu',
    upstreamReferer: env.UPSTREAM_REFERER ?? 'https://overpass-turbo.eu/',
    serveStaleFromCache: toBoolean(env.SERVE_STALE_FROM_CACHE, true)
  };
};
