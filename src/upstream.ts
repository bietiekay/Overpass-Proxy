import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import got from 'got';
import type { Method, RetryOptions } from 'got';

import { hasJsonOutput, type BoundingBox } from './bbox.js';
import {
  CLIENT_AUTH_HEADER,
  sanitiseHeadersForLogs,
  stripHeader
} from './clientAuth.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { OverpassResponse } from './store.js';
import { startOfDayMs } from './time.js';
import type { UpstreamMetricsProvider, UpstreamStatisticsEntry } from './stats.js';

export const buildTileQuery = (bbox: BoundingBox, amenity: string): string => {
  const escapedAmenity = amenity.replace(/"/g, '\\"');
  return `[out:json][timeout:120];
(
  node["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["amenity"="${escapedAmenity}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body meta;
>;
out skel qt;`;
};

const UPSTREAM_RETRY_LIMIT = 2;
const UPSTREAM_RETRY_STATUS_CODES = [403, 408, 413, 500, 502, 503, 504];
const UPSTREAM_RETRY_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED'
];
const UPSTREAM_RETRY_METHODS: Method[] = ['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'];
const UPSTREAM_RETRY_METHODS_WITH_POST: Method[] = [...UPSTREAM_RETRY_METHODS, 'POST'];
const UPSTREAM_RETRY_BACKOFF_BASE_MS = 500;
const UPSTREAM_RETRY_BACKOFF_MAX_MS = 5000;

const buildRetryDelayMs = (attemptCount: number): number => {
  const exponential = Math.min(
    UPSTREAM_RETRY_BACKOFF_MAX_MS,
    UPSTREAM_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1)
  );
  const jitter = Math.random() * UPSTREAM_RETRY_BACKOFF_BASE_MS;
  return exponential + jitter;
};

const buildUpstreamRetryOptions = (allowPost: boolean): Partial<RetryOptions> => ({
  limit: UPSTREAM_RETRY_LIMIT,
  methods: allowPost ? UPSTREAM_RETRY_METHODS_WITH_POST : UPSTREAM_RETRY_METHODS,
  statusCodes: UPSTREAM_RETRY_STATUS_CODES,
  errorCodes: UPSTREAM_RETRY_ERROR_CODES,
  calculateDelay: ({ attemptCount, computedValue, error }) => {
    if (computedValue === 0) {
      return 0;
    }

    const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
    if (statusCode === 429) {
      return 0;
    }

    return buildRetryDelayMs(attemptCount);
  }
});

interface UpstreamState {
  backoffUntil: number;
  backoffAttempts: number;
  backoffReason?: string;
  blockedUntil: number;
  requestsToday: number;
  dayStart: number;
  ewmaLatencyMs: number;
  ewmaSuccess: number;
  totalRequests: number;
  totalFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

type PersistedUpstreamState = UpstreamState;

interface StickyEntry {
  upstream: string;
  expiresAt: number;
}

interface UpstreamPoolOptions {
  redis?: Redis;
  ewmaAlpha: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  stickinessTtlMs: number;
  dailyLimit: number;
  probeIntervalMs: number;
  probeJitterMs: number;
  probeTimeoutMs: number;
}

export interface UpstreamAvailabilitySnapshot {
  availableNow: boolean;
  exhaustedByLimit: boolean;
  availableCount: number;
  cooldownCount: number;
  blockedCount: number;
  nextAvailableInMs: number | null;
  nextAvailableAt?: string;
}

class UpstreamStateStorage {
  constructor(private readonly redis: Redis, private readonly key = 'upstreams:state') {}

  public async load(): Promise<Record<string, PersistedUpstreamState> | null> {
    try {
      const raw = await this.redis.get(this.key);
      if (!raw) {
        return null;
      }

      return JSON.parse(raw) as Record<string, PersistedUpstreamState>;
    } catch (error) {
      logger.warn({ err: error }, 'failed to load persisted upstream state');
      return null;
    }
  }

  public async save(states: Record<string, PersistedUpstreamState>): Promise<void> {
    try {
      await this.redis.set(this.key, JSON.stringify(states));
    } catch (error) {
      logger.warn({ err: error }, 'failed to persist upstream state');
    }
  }
}

class UpstreamPool {
  private readonly states = new Map<string, UpstreamState>();
  private readonly stickiness = new Map<string, StickyEntry>();
  private readonly blockDurationMs = 24 * 60 * 60 * 1000;
  private storage: UpstreamStateStorage | null;
  private initPromise: Promise<void>;
  private readonly ewmaAlpha: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly stickinessTtlMs: number;
  private readonly probeIntervalMs: number;
  private readonly probeJitterMs: number;
  private readonly probeTimeoutMs: number;
  private saveQueue: Promise<void> = Promise.resolve();
  private probeTimer?: ReturnType<typeof setTimeout>;

  constructor(urls: string[], options: UpstreamPoolOptions) {
    this.ewmaAlpha = options.ewmaAlpha;
    this.backoffBaseMs = options.backoffBaseMs;
    this.backoffMaxMs = options.backoffMaxMs;
    this.stickinessTtlMs = options.stickinessTtlMs;
    this.probeIntervalMs = options.probeIntervalMs;
    this.probeJitterMs = options.probeJitterMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
    this.storage = options.redis ? new UpstreamStateStorage(options.redis) : null;
    const start = startOfDayMs();
    for (const url of urls) {
      this.states.set(url, this.buildFreshState(start));
    }

    this.initPromise = this.restore();
    if (this.probeIntervalMs > 0) {
      this.scheduleProbeLoop();
    }
  }

  private buildFreshState(dayStart: number): UpstreamState {
    return {
      backoffUntil: 0,
      backoffAttempts: 0,
      backoffReason: undefined,
      blockedUntil: 0,
      requestsToday: 0,
      dayStart,
      ewmaLatencyMs: 0,
      ewmaSuccess: 1,
      totalRequests: 0,
      totalFailures: 0
    };
  }

  private async restore(): Promise<void> {
    if (!this.storage) {
      return;
    }
    const persisted = await this.storage.load();
    if (!persisted) {
      return;
    }

    for (const [url, state] of Object.entries(persisted)) {
      if (this.states.has(url)) {
        this.states.set(url, { ...this.buildFreshState(state.dayStart ?? startOfDayMs()), ...state });
      }
    }

    // Ensure all configured upstreams exist
    const start = startOfDayMs();
    for (const [url, state] of this.states) {
      if (!state.dayStart) {
        this.states.set(url, this.buildFreshState(start));
      }
    }
  }

  private async save(): Promise<void> {
    if (!this.storage) {
      return;
    }
    const snapshot: Record<string, PersistedUpstreamState> = {};
    for (const [url, state] of this.states) {
      snapshot[url] = { ...state };
    }
    this.saveQueue = this.saveQueue.then(() => this.storage!.save(snapshot)).catch(() => {});
    await this.saveQueue;
  }

  attachStorage(redis: Redis): void {
    if (this.storage) {
      return;
    }
    this.storage = new UpstreamStateStorage(redis);
    this.initPromise = this.restore();
  }

  get size(): number {
    return this.states.size;
  }

  private refreshState(state: UpstreamState, now: number): void {
    const currentStart = startOfDayMs(now);
    if (state.dayStart !== currentStart) {
      state.dayStart = currentStart;
      state.requestsToday = 0;
    }

    if (state.blockedUntil > 0 && state.blockedUntil <= now) {
      state.blockedUntil = 0;
    }
  }

  private markLimitReached(url: string, state: UpstreamState, now: number, dailyLimit: number): void {
    if (state.blockedUntil > now) {
      return;
    }

    state.blockedUntil = now + this.blockDurationMs;
    logger.warn(
      {
        upstream: url,
        blockedUntil: new Date(state.blockedUntil).toISOString(),
        requestsToday: state.requestsToday,
        dailyLimit
      },
      'upstream daily request limit reached'
    );
    void this.save();
  }

  private updateEwma(current: number, sample: number): number {
    if (current === 0) {
      return sample;
    }
    return this.ewmaAlpha * sample + (1 - this.ewmaAlpha) * current;
  }

  private computeWeight(state: UpstreamState): number {
    const latencyBaseline = 500;
    const latencyScore =
      state.ewmaLatencyMs > 0 ? latencyBaseline / (latencyBaseline + state.ewmaLatencyMs) : 1;
    const successScore = Math.max(0.1, Math.min(1, state.ewmaSuccess));
    return Number((latencyScore * successScore).toFixed(4));
  }

  private pickWeighted(available: Array<{ url: string; weight: number }>): string {
    const total = available.reduce((sum, entry) => sum + entry.weight, 0);
    let r = Math.random() * total;
    for (const entry of available) {
      r -= entry.weight;
      if (r <= 0) {
        return entry.url;
      }
    }
    return available[available.length - 1].url;
  }

  private cleanStickiness(now: number): void {
    for (const [key, entry] of this.stickiness) {
      if (entry.expiresAt <= now) {
        this.stickiness.delete(key);
      }
    }
  }

  private pickSticky(clientKey: string | undefined, available: Set<string>, now: number): string | null {
    if (!clientKey || this.stickinessTtlMs <= 0) {
      return null;
    }
    this.cleanStickiness(now);
    const sticky = this.stickiness.get(clientKey);
    if (sticky && available.has(sticky.upstream)) {
      return sticky.upstream;
    }
    return null;
  }

  private setSticky(clientKey: string | undefined, upstream: string, now: number): void {
    if (!clientKey || this.stickinessTtlMs <= 0) {
      return;
    }
    this.stickiness.set(clientKey, { upstream, expiresAt: now + this.stickinessTtlMs });
  }

  private async scheduleProbeLoop(): Promise<void> {
    const run = async () => {
      await this.probeOnce().catch((error) =>
        logger.debug({ err: error }, 'upstream probe tick failed')
      );
      const jitter =
        this.probeJitterMs > 0 ? Math.floor(Math.random() * this.probeJitterMs) : 0;
      this.probeTimer = setTimeout(run, this.probeIntervalMs + jitter);
      this.probeTimer.unref?.();
    };
    this.probeTimer = setTimeout(run, this.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  private async probeOnce(): Promise<void> {
    const now = Date.now();
    const targets: string[] = [];
    for (const [url, state] of this.states) {
      this.refreshState(state, now);
      if (state.backoffUntil > now) {
        targets.push(url);
      }
    }

    const maxConcurrent = 2;
    const queue = [...targets];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < maxConcurrent; i += 1) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) {
              return;
            }
            await this.probeWithTimeout(next);
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  private async probeWithTimeout(url: string): Promise<void> {
    if (this.probeTimeoutMs <= 0) {
      await this.probeUpstream(url);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.probeUpstream(url),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(`Probe timed out after ${this.probeTimeoutMs}ms`);
            error.name = 'UpstreamProbeTimeout';
            reject(error);
          }, this.probeTimeoutMs);
        })
      ]);
    } catch (error) {
      if (error instanceof Error && error.name === 'UpstreamProbeTimeout') {
        logger.debug({ err: error, upstream: url, timeoutMs: this.probeTimeoutMs }, 'probe timed out');
        this.markFailure(url, `probe timed out after ${this.probeTimeoutMs}ms`);
      } else {
        logger.debug({ err: error, upstream: url }, 'probe failed');
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async probeUpstream(url: string): Promise<void> {
    const state = this.states.get(url);
    if (!state) {
      return;
    }
    const now = Date.now();
    if (state.backoffUntil > 0 && state.backoffUntil > now) {
      // allow probes only when backoff window is active
    }

    try {
      const start = Date.now();
      const response = await got(url, {
        method: 'HEAD',
        throwHttpErrors: false,
        timeout: { request: this.probeTimeoutMs }
      });
      const duration = Date.now() - start;
      if (response.statusCode < 500 && response.statusCode !== 429) {
        state.backoffAttempts = 0;
        state.backoffUntil = 0;
        state.backoffReason = undefined;
        state.ewmaLatencyMs = this.updateEwma(state.ewmaLatencyMs, duration);
        state.ewmaSuccess = this.updateEwma(state.ewmaSuccess, 1);
        state.lastSuccessAt = now;
        await this.save();
        return;
      }
      this.markFailure(
        url,
        response.statusCode === 429
          ? 'probe received HTTP 429 Too Many Requests'
          : `probe received HTTP ${response.statusCode}`
      );
      return;
    } catch (error) {
      logger.debug({ err: error, upstream: url }, 'probe failed');
      this.markFailure(url, `probe failed: ${extractBackoffReason(error) ?? 'unknown error'}`);
      return;
    }
  }

  public async ensureReady(): Promise<void> {
    await this.initPromise;
  }

  public tryAcquire(url: string, dailyLimit: number): 'acquired' | 'limit' | 'cooldown' | 'blocked' {
    const state = this.states.get(url);
    if (!state) {
      return 'blocked';
    }

    const now = Date.now();
    this.refreshState(state, now);

    if (state.backoffUntil > now) {
      return 'cooldown';
    }

    if (state.blockedUntil > now) {
      return 'limit';
    }

    if (dailyLimit >= 0 && state.requestsToday >= dailyLimit) {
      this.markLimitReached(url, state, now, dailyLimit);
      return 'limit';
    }

    state.requestsToday += 1;
    state.totalRequests += 1;

    if (dailyLimit >= 0 && state.requestsToday >= dailyLimit) {
      this.markLimitReached(url, state, now, dailyLimit);
    }

    return 'acquired';
  }

  public isExhaustedByLimit(dailyLimit: number, now = Date.now()): boolean {
    if (dailyLimit < 0 || this.states.size === 0) {
      return false;
    }

    for (const state of this.states.values()) {
      this.refreshState(state, now);
      if (state.blockedUntil <= now && state.requestsToday < dailyLimit) {
        return false;
      }
    }

    return true;
  }

  public getAvailability(dailyLimit: number, now = Date.now()): UpstreamAvailabilitySnapshot {
    let availableCount = 0;
    let cooldownCount = 0;
    let blockedCount = 0;
    let nextAvailableAt: number | null = null;

    for (const state of this.states.values()) {
      this.refreshState(state, now);

      if (state.backoffUntil > now) {
        cooldownCount += 1;
        if (nextAvailableAt === null || state.backoffUntil < nextAvailableAt) {
          nextAvailableAt = state.backoffUntil;
        }
        continue;
      }

      if (state.blockedUntil > now || (dailyLimit >= 0 && state.requestsToday >= dailyLimit)) {
        blockedCount += 1;
        continue;
      }

      availableCount += 1;
    }

    return {
      availableNow: availableCount > 0,
      exhaustedByLimit: availableCount === 0 && this.isExhaustedByLimit(dailyLimit, now),
      availableCount,
      cooldownCount,
      blockedCount,
      nextAvailableInMs: nextAvailableAt === null ? null : Math.max(0, nextAvailableAt - now),
      nextAvailableAt: nextAvailableAt === null ? undefined : new Date(nextAvailableAt).toISOString()
    };
  }

  describeUnavailability(
    excluded: Set<string>,
    dailyLimit: number,
    now = Date.now()
  ): Array<{ upstream: string; reason: string }> {
    const details: Array<{ upstream: string; reason: string }> = [];

    for (const [url, state] of this.states) {
      this.refreshState(state, now);

      let reason = 'available';
      if (state.backoffUntil > now) {
        reason = formatBackoffDescription(state.backoffUntil, state.backoffReason);
      } else if (state.blockedUntil > now) {
        reason = `daily limit reached until ${new Date(state.blockedUntil).toISOString()}`;
      } else if (dailyLimit >= 0 && state.requestsToday >= dailyLimit) {
        reason = 'daily limit reached';
      } else if (excluded.has(url)) {
        reason = 'already attempted for this request';
      }

      details.push({ upstream: url, reason });
    }

    return details;
  }

  next(excluded: Set<string>, dailyLimit: number, clientKey?: string): string | null {
    const now = Date.now();
    const available: Array<{ url: string; weight: number }> = [];
    const availableSet = new Set<string>();

    for (const [url, state] of this.states) {
      this.refreshState(state, now);
      if (excluded.has(url)) {
        continue;
      }
      if (state.backoffUntil > now) {
        continue;
      }
      if (state.blockedUntil > now) {
        continue;
      }
      if (dailyLimit >= 0 && state.requestsToday >= dailyLimit) {
        this.markLimitReached(url, state, now, dailyLimit);
        continue;
      }

      const weight = this.computeWeight(state);
      available.push({ url, weight });
      availableSet.add(url);
    }

    if (available.length === 0) {
      return null;
    }

    const sticky = this.pickSticky(clientKey, availableSet, now);
    if (sticky) {
      return sticky;
    }

    if (available.length === 1) {
      this.setSticky(clientKey, available[0].url, now);
      return available[0].url;
    }

    const chosen = this.pickWeighted(available);
    this.setSticky(clientKey, chosen, now);
    return chosen;
  }

  markFailure(url: string, reason?: string): void {
    const state = this.states.get(url);
    if (!state) {
      return;
    }

    const now = Date.now();
    state.backoffAttempts += 1;
    const delayMs = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (state.backoffAttempts - 1));
    state.backoffUntil = now + delayMs;
    state.backoffReason = normaliseBackoffReason(reason);
    state.totalFailures += 1;
    state.lastFailureAt = now;
    state.ewmaSuccess = this.updateEwma(state.ewmaSuccess, 0);
    void this.save();
  }

  markSuccess(url: string, durationMs?: number): void {
    const state = this.states.get(url);
    if (!state) {
      return;
    }

    state.backoffAttempts = 0;
    state.backoffUntil = 0;
    state.backoffReason = undefined;
    state.lastSuccessAt = Date.now();
    if (durationMs !== undefined) {
      state.ewmaLatencyMs = this.updateEwma(state.ewmaLatencyMs, durationMs);
    }
    state.ewmaSuccess = this.updateEwma(state.ewmaSuccess, 1);
    void this.save();
  }

  describe(dailyLimit: number, now = Date.now()): UpstreamStatisticsEntry[] {
    const entries: UpstreamStatisticsEntry[] = [];

    for (const [url, state] of this.states) {
      this.refreshState(state, now);

      let status: UpstreamStatisticsEntry['status'] = 'available';
      let reason = 'available';

      if (state.backoffUntil > now) {
        status = 'cooldown';
        reason = formatBackoffDescription(state.backoffUntil, state.backoffReason);
      } else if (state.blockedUntil > now) {
        status = 'blocked';
        reason = `daily limit reached until ${new Date(state.blockedUntil).toISOString()}`;
      } else if (dailyLimit >= 0 && state.requestsToday >= dailyLimit) {
        status = 'blocked';
        reason = 'daily limit reached';
      }

      entries.push({
        upstream: url,
        status,
        reason,
        backoffReason: state.backoffReason,
        requestsToday: state.requestsToday,
        dayStart: new Date(state.dayStart).toISOString(),
        blockedUntil: state.blockedUntil > now ? new Date(state.blockedUntil).toISOString() : undefined,
        backoffUntil: state.backoffUntil > now ? new Date(state.backoffUntil).toISOString() : undefined,
        failedUntil: state.backoffUntil > now ? new Date(state.backoffUntil).toISOString() : undefined,
        nextRetry: state.backoffUntil > now ? new Date(state.backoffUntil).toISOString() : undefined,
        backoffAttempts: state.backoffAttempts || undefined,
        dailyLimit: dailyLimit >= 0 ? dailyLimit : undefined,
        ewmaLatencyMs: state.ewmaLatencyMs || undefined,
        ewmaSuccess: state.ewmaSuccess || undefined,
        weight: this.computeWeight(state),
        totalRequests: state.totalRequests,
        totalFailures: state.totalFailures,
        lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
        lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : undefined
      });
    }

    return entries.sort((a, b) => a.upstream.localeCompare(b.upstream));
  }
}

const poolCache = new WeakMap<AppConfig, UpstreamPool>();

const getPool = (config: AppConfig, redis?: Redis): UpstreamPool => {
  let pool = poolCache.get(config);
  if (!pool) {
    pool = new UpstreamPool(config.upstreamUrls, {
      redis,
      ewmaAlpha: config.upstreamEwmaAlpha,
      backoffBaseMs: config.upstreamBackoffBaseSeconds * 1000,
      backoffMaxMs: config.upstreamBackoffMaxSeconds * 1000,
      stickinessTtlMs: config.upstreamStickinessTtlSeconds * 1000,
      dailyLimit: config.upstreamDailyLimit,
      probeIntervalMs: config.upstreamProbeIntervalSeconds * 1000,
      probeJitterMs: config.upstreamProbeJitterSeconds * 1000,
      probeTimeoutMs: config.upstreamProbeTimeoutSeconds * 1000
    });
    poolCache.set(config, pool);
  } else if (redis) {
    pool.attachStorage(redis);
  }
  return pool;
};

export const getUpstreamPoolForTesting = (config: AppConfig, redis?: Redis) =>
  getPool(config, redis);

export const getUpstreamAvailabilitySnapshot = async (
  config: AppConfig,
  redis?: Redis
): Promise<UpstreamAvailabilitySnapshot> => {
  const pool = getPool(config, redis);
  await pool.ensureReady();
  return pool.getAvailability(config.upstreamDailyLimit);
};

const shouldMarkFailure = (error: unknown): boolean => {
  if (error instanceof Error && error.name === 'RequestError') {
    const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      return false;
    }
  }
  return true;
};

interface UpstreamCallOptions {
  redis?: Redis;
  clientKey?: string;
  logContext?: Record<string, unknown>;
  waitForAvailability?: boolean;
  onAvailabilityWait?: (details: {
    waitMs: number;
    nextAvailableInMs: number;
    nextAvailableAt?: string;
    attempts: number;
  }) => void;
}

const extractInterpreterQuery = (request: FastifyRequest): string | null => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const requestUrl = new URL(request.url, 'http://proxy.local');
    return requestUrl.searchParams.get('data') ?? requestUrl.searchParams.get('q');
  }

  if (typeof request.body === 'string') {
    try {
      const params = new URLSearchParams(request.body);
      return params.get('data') ?? params.get('q');
    } catch {
      return null;
    }
  }

  if (Buffer.isBuffer(request.body)) {
    try {
      const params = new URLSearchParams(request.body.toString('utf8'));
      return params.get('data') ?? params.get('q');
    } catch {
      return null;
    }
  }

  if (request.body && typeof request.body === 'object') {
    const body = request.body as Record<string, unknown>;
    const value = body.data ?? body.q;
    if (typeof value === 'string') {
      return value;
    }
  }

  return null;
};

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normaliseBackoffReason = (reason: string | undefined, maxLength = 160): string | undefined => {
  const compact = reason?.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}...`;
};

const formatBackoffDescription = (until: number, reason?: string): string => {
  const untilIso = new Date(until).toISOString();
  return reason ? `in backoff until ${untilIso} (${reason})` : `in backoff until ${untilIso}`;
};

const extractBackoffReason = (error: unknown): string | undefined => {
  const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
  if (typeof statusCode === 'number') {
    if (statusCode === 429) {
      return 'HTTP 429 Too Many Requests';
    }
    return `HTTP ${statusCode}`;
  }

  if (error instanceof Error) {
    return normaliseBackoffReason(error.message) ?? normaliseBackoffReason(error.name);
  }

  if (typeof error === 'string') {
    return normaliseBackoffReason(error);
  }

  return undefined;
};

const summariseUpstreamBody = (body: string, maxLength = 200): string => {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}...`;
};

const decodeXmlEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const normalised = entity.toLowerCase();
    switch (normalised) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (normalised.startsWith('#x')) {
          const parsed = Number.parseInt(normalised.slice(2), 16);
          return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
        }
        if (normalised.startsWith('#')) {
          const parsed = Number.parseInt(normalised.slice(1), 10);
          return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
        }
        return match;
    }
  });

const parseXmlAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match) {
    const [, key, , doubleQuoted, singleQuoted] = match;
    attributes[key] = decodeXmlEntities(doubleQuoted ?? singleQuoted ?? '');
    match = pattern.exec(source);
  }
  return attributes;
};

const parseXmlNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const extractMarkupMessage = (body: string): string | null => {
  const patterns = [
    /<remark\b[^>]*>([\s\S]*?)<\/remark>/i,
    /<error\b[^>]*>([\s\S]*?)<\/error>/i,
    /<message\b[^>]*>([\s\S]*?)<\/message>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    const candidate = match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (candidate) {
      return candidate;
    }
  }

  return null;
};

const isMarkupResponse = (body: string, contentTypeHeader: string | undefined): boolean => {
  const contentType = contentTypeHeader?.toLowerCase() ?? '';
  if (contentType.includes('xml') || contentType.includes('html')) {
    return true;
  }

  return body.trimStart().startsWith('<');
};

const parseOverpassXml = (body: string): OverpassResponse | null => {
  const rootMatch = body.match(/<osm\b([^>]*)>([\s\S]*)<\/osm>/i);
  if (!rootMatch) {
    return null;
  }

  const [, rootAttributesSource, innerBody] = rootMatch;
  const rootAttributes = parseXmlAttributes(rootAttributesSource);
  const elements: OverpassResponse['elements'] = [];
  const elementPattern = /<(node|way|relation)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let elementMatch: RegExpExecArray | null = elementPattern.exec(innerBody);

  while (elementMatch) {
    const [, type, attributeSource, childSource = ''] = elementMatch;
    const attributes = parseXmlAttributes(attributeSource);
    const id = parseXmlNumber(attributes.id);
    if (id === undefined) {
      elementMatch = elementPattern.exec(innerBody);
      continue;
    }

    const element: OverpassResponse['elements'][number] = {
      type: type as OverpassResponse['elements'][number]['type'],
      id
    };

    if (type === 'node') {
      const lat = parseXmlNumber(attributes.lat);
      const lon = parseXmlNumber(attributes.lon);
      if (lat !== undefined) {
        element.lat = lat;
      }
      if (lon !== undefined) {
        element.lon = lon;
      }
    }

    const tags: Record<string, string> = {};
    const tagPattern = /<tag\b([^>]*)\/>/gi;
    let tagMatch: RegExpExecArray | null = tagPattern.exec(childSource);
    while (tagMatch) {
      const tagAttributes = parseXmlAttributes(tagMatch[1] ?? '');
      const key = tagAttributes.k;
      const value = tagAttributes.v;
      if (key !== undefined && value !== undefined) {
        tags[key] = value;
      }
      tagMatch = tagPattern.exec(childSource);
    }
    if (Object.keys(tags).length > 0) {
      element.tags = tags;
    }

    if (type === 'way') {
      const nodes: number[] = [];
      const nodePattern = /<nd\b([^>]*)\/>/gi;
      let nodeMatch: RegExpExecArray | null = nodePattern.exec(childSource);
      while (nodeMatch) {
        const nodeAttributes = parseXmlAttributes(nodeMatch[1] ?? '');
        const ref = parseXmlNumber(nodeAttributes.ref);
        if (ref !== undefined) {
          nodes.push(ref);
        }
        nodeMatch = nodePattern.exec(childSource);
      }
      if (nodes.length > 0) {
        element.nodes = nodes;
      }
    }

    if (type === 'relation') {
      const members: NonNullable<OverpassResponse['elements'][number]['members']> = [];
      const memberPattern = /<member\b([^>]*)\/>/gi;
      let memberMatch: RegExpExecArray | null = memberPattern.exec(childSource);
      while (memberMatch) {
        const memberAttributes = parseXmlAttributes(memberMatch[1] ?? '');
        const memberType = memberAttributes.type;
        const ref = parseXmlNumber(memberAttributes.ref);
        if (
          ref !== undefined &&
          (memberType === 'node' || memberType === 'way' || memberType === 'relation')
        ) {
          members.push({
            type: memberType,
            ref,
            role: memberAttributes.role ?? ''
          });
        }
        memberMatch = memberPattern.exec(childSource);
      }
      if (members.length > 0) {
        element.members = members;
      }
    }

    elements.push(element);
    elementMatch = elementPattern.exec(innerBody);
  }

  const metaMatch = innerBody.match(/<meta\b([^>]*)\/>/i);
  const metaAttributes = metaMatch ? parseXmlAttributes(metaMatch[1] ?? '') : {};
  const response: OverpassResponse = {
    elements
  };
  const version = parseXmlNumber(rootAttributes.version);
  if (version !== undefined) {
    response.version = version;
  }
  if (rootAttributes.generator) {
    response.generator = rootAttributes.generator;
  }
  if (metaAttributes.osm_base || metaAttributes.areas) {
    response.osm3s = {
      ...(metaAttributes.osm_base ? { timestamp_osm_base: metaAttributes.osm_base } : {}),
      ...(metaAttributes.areas ? { timestamp_areas_base: metaAttributes.areas } : {})
    };
  }
  return response;
};

const parseUpstreamResponse = (
  body: string,
  upstreamUrl: string,
  contentTypeHeader?: string
): OverpassResponse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (isMarkupResponse(body, contentTypeHeader)) {
      const xmlResponse = parseOverpassXml(body);
      if (xmlResponse && !extractMarkupMessage(body)) {
        return xmlResponse;
      }

      const markupMessage = extractMarkupMessage(body) ?? summariseUpstreamBody(body);
      const suffix = markupMessage ? `: ${markupMessage}` : '';
      throw new Error(`Upstream returned markup instead of JSON from ${upstreamUrl}${suffix}`);
    }

    const preview = summariseUpstreamBody(body);
    const suffix = preview ? ` Body preview: ${preview}` : '';
    throw new Error(
      `Failed to parse upstream response from ${upstreamUrl}: ${(error as Error).message}${suffix}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as OverpassResponse).elements)) {
    const remark =
      typeof (parsed as { remark?: unknown }).remark === 'string'
        ? (parsed as { remark: string }).remark.trim()
        : '';
    const suffix = remark ? `: ${remark}` : '';
    throw new Error(`Upstream response missing elements array from ${upstreamUrl}${suffix}`);
  }

  return parsed as OverpassResponse;
};

const withUpstream = async <T>(
  config: AppConfig,
  optionsOrFn: UpstreamCallOptions | ((baseUrl: string) => Promise<T>),
  maybeFn?: (baseUrl: string) => Promise<T>
): Promise<T> => {
  const options: UpstreamCallOptions =
    typeof optionsOrFn === 'function' ? {} : optionsOrFn ?? {};
  const fn: (baseUrl: string) => Promise<T> =
    typeof optionsOrFn === 'function' ? optionsOrFn : (maybeFn as (baseUrl: string) => Promise<T>);

  if (!fn) {
    throw new Error('Upstream callback required');
  }

  const pool = getPool(config, options.redis);
  if (pool.size === 0) {
    throw new Error('No upstream URLs configured');
  }

  await pool.ensureReady();
  const attempted = new Set<string>();
  let lastError: unknown;
  const dailyLimit = config.upstreamDailyLimit;
  const clientKey = options.clientKey;
  const waitBudgetMs = Math.max(0, Math.floor(config.upstreamExhaustedWaitSeconds * 1000));
  const waitGraceMs = Math.max(0, Math.floor(config.upstreamExhaustedGraceSeconds * 1000));
  const waitDeadline = Date.now() + waitBudgetMs;
  const shouldWaitForAvailability = options.waitForAvailability ?? true;
  let waitAttempts = 0;

  while (true) {
    while (attempted.size < pool.size) {
      const upstream = pool.next(attempted, dailyLimit, clientKey);
      if (!upstream) {
        break;
      }

      const acquireResult = pool.tryAcquire(upstream, dailyLimit);
      if (acquireResult !== 'acquired') {
        attempted.add(upstream);
        if (acquireResult === 'limit') {
          lastError = new Error(`Upstream daily request limit reached for ${upstream}`);
        }
        continue;
      }

      const start = Date.now();
      try {
        const result = await fn(upstream);
        pool.markSuccess(upstream, Date.now() - start);
        return result;
      } catch (error) {
        attempted.add(upstream);
        if (!shouldMarkFailure(error)) {
          throw error;
        }

        lastError = error;
        pool.markFailure(upstream, extractBackoffReason(error));
        logger.error(
          {
            err: error,
            upstream,
            backoffSeconds: config.upstreamBackoffBaseSeconds,
            request: options.logContext ?? undefined
          },
          'upstream request failed'
        );
      }
    }

    const availability = pool.getAvailability(dailyLimit);
    if (availability.exhaustedByLimit) {
      break;
    }

    if (!shouldWaitForAvailability || lastError !== undefined) {
      break;
    }

    if (availability.availableNow) {
      attempted.clear();
      continue;
    }

    const nextAvailableInMs = availability.nextAvailableInMs;
    const remainingWaitMs = waitDeadline - Date.now();
    if (remainingWaitMs <= 0 || nextAvailableInMs === null) {
      break;
    }

    const waitMs = Math.min(remainingWaitMs, nextAvailableInMs + waitGraceMs);
    if (waitMs <= 0) {
      attempted.clear();
      continue;
    }

    waitAttempts += 1;
    options.onAvailabilityWait?.({
      waitMs,
      nextAvailableInMs,
      nextAvailableAt: availability.nextAvailableAt,
      attempts: waitAttempts
    });
    logger.warn(
      {
        waitMs,
        nextAvailableInMs,
        nextAvailableAt: availability.nextAvailableAt,
        attempts: waitAttempts,
        upstreams: pool.describeUnavailability(attempted, dailyLimit),
        request: options.logContext ?? undefined
      },
      'waiting for upstream availability'
    );
    await sleep(waitMs);
    attempted.clear();
  }

  if (pool.isExhaustedByLimit(dailyLimit)) {
    const lastErrorMessage = lastError instanceof Error ? lastError.message : lastError;
    logger.error(
      { upstreams: pool.describeUnavailability(attempted, dailyLimit), lastError: lastErrorMessage },
      'no upstream URLs available: daily limits reached'
    );
    throw new Error('Upstream daily request limit reached for all configured upstreams');
  }

  const lastErrorMessage = lastError instanceof Error ? lastError.message : lastError;
  logger.error(
    { upstreams: pool.describeUnavailability(attempted, dailyLimit), lastError: lastErrorMessage },
    'no upstream URLs available'
  );
  throw lastError ?? new Error('No upstream URLs available');
};

export const fetchTile = async (
  config: AppConfig,
  bbox: BoundingBox,
  amenity: string,
  options?: UpstreamCallOptions
): Promise<OverpassResponse> => {
  const query = buildTileQuery(bbox, amenity);
  const fetchTileOptions: UpstreamCallOptions = {
    ...(options ?? {}),
    logContext: {
      ...(options?.logContext ?? {}),
      request: {
        bbox,
        amenity,
        query
      }
    }
  };

  return await withUpstream(
    config,
    fetchTileOptions,
    async (upstreamUrl) => {
      logger.info({ bbox, amenity, upstreamUrl }, 'upstream fetch start');
      const response = await got.post(upstreamUrl, {
        body: new URLSearchParams({ data: query }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        timeout: { request: config.upstreamRequestTimeoutSeconds * 1000 },
        throwHttpErrors: true,
        retry: buildUpstreamRetryOptions(true)
      });
      logger.info({ bbox, amenity, upstreamUrl }, 'upstream fetch done');
      const contentTypeValue = response.headers?.['content-type'];
      const contentTypeHeader = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue;
      return parseUpstreamResponse(response.body, upstreamUrl, contentTypeHeader);
    }
  );
};

export const proxyTransparent = async (
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  options?: UpstreamCallOptions
): Promise<void> => {
  try {
    const proxyOptions: UpstreamCallOptions = { waitForAvailability: false, ...(options ?? {}) };

    await withUpstream(
      config,
      proxyOptions,
      async (baseUrl) => {
        const upstreamUrl = new URL(request.url, baseUrl);
        const originalMethod = request.method as Method;
        let method = originalMethod;
        let body: string | Buffer | undefined;
        let bodyReencoded = false;
        const start = Date.now();

        const interpreterPath = upstreamUrl.pathname.endsWith('/api/interpreter');
        const interpreterQuery = interpreterPath ? extractInterpreterQuery(request) : null;
        const requestedJsonResponse =
          interpreterPath && typeof interpreterQuery === 'string' && hasJsonOutput(interpreterQuery);
        const searchEntries = Array.from(upstreamUrl.searchParams.entries());
        const hasInterpreterQueryPayload = searchEntries.some(
          ([key]) => key === 'data' || key === 'q'
        );

        if (
          originalMethod === 'GET' &&
          interpreterPath &&
          searchEntries.length > 0 &&
          hasInterpreterQueryPayload
        ) {
          const form = new URLSearchParams();
          for (const [key, value] of searchEntries) {
            form.append(key, value);
          }
          body = form.toString();
          bodyReencoded = true;
          method = 'POST';
          upstreamUrl.search = '';
        } else if (request.method === 'GET' || request.method === 'HEAD') {
          body = undefined;
        } else if (typeof request.body === 'string') {
          body = request.body;
        } else if (Buffer.isBuffer(request.body)) {
          body = request.body;
        } else if (request.body && typeof request.body === 'object') {
          body = new URLSearchParams(request.body as Record<string, string>).toString();
          bodyReencoded = true;
        }

        const headers = stripHeader(
          {
            ...request.headers,
            host: undefined
          } as Record<string, string | string[] | undefined>,
          CLIENT_AUTH_HEADER
        );

        const ensureHeader = (name: string, value: string): void => {
          const existing =
            headers[name] ??
            headers[name.toLowerCase()] ??
            headers[name.toUpperCase()];
          if (existing === undefined) {
            headers[name.toLowerCase()] = value;
          }
        };
        if (bodyReencoded) {
          delete headers['content-length'];
          delete headers['Content-Length'];
          delete headers['content-type'];
          delete headers['Content-Type'];
          // Always send re-encoded bodies as form data to match the upstream expectation
          headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }

        if (interpreterPath) {
          ensureHeader('origin', config.upstreamOrigin);
          ensureHeader('pragma', 'no-cache');
          ensureHeader('priority', 'u=1, i');
          ensureHeader('referer', config.upstreamReferer);
          ensureHeader(
            'sec-ch-ua',
            '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"'
          );
          ensureHeader('sec-ch-ua-mobile', '?0');
          ensureHeader('sec-ch-ua-platform', '"Linux"');
          ensureHeader('sec-fetch-dest', 'empty');
          ensureHeader('sec-fetch-mode', 'cors');
          ensureHeader('sec-fetch-site', 'cross-site');
          ensureHeader(
            'user-agent',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
          );
        }

        const summarisePayload = (payload: string | Buffer | undefined) => {
          if (payload === undefined) {
            return { kind: 'empty' };
          }

          if (typeof payload === 'string') {
            return {
              kind: 'string',
              size: Buffer.byteLength(payload, 'utf8'),
              preview: payload.slice(0, 512)
            };
          }

          return {
            kind: 'buffer',
            size: payload.length,
            preview: payload.toString('utf8', 0, 512)
          };
        };

        const requestMeta = {
          method,
          originalMethod,
          url: request.url,
          upstreamUrl: upstreamUrl.toString(),
          remoteAddress: request.ip,
          bodyReencoded
        };

        const requestLogContext = {
          request: {
            ...requestMeta,
            headers: sanitiseHeadersForLogs(request.headers),
            body: summarisePayload(body)
          }
        };
        proxyOptions.logContext = {
          ...(options?.logContext ?? {}),
          ...requestLogContext
        };

        logger.info(requestMeta, 'transparent proxy forwarding request');

        if (logger.levelVal <= logger.levels.values.debug) {
          logger.debug(
            {
              ...requestMeta,
              headers: sanitiseHeadersForLogs(request.headers),
              body: summarisePayload(body)
            },
            'transparent proxy request details'
          );
        }

        const response = await got(upstreamUrl.toString(), {
          method,
          headers,
          body,
          throwHttpErrors: false,
          responseType: 'buffer',
          timeout: { request: config.upstreamRequestTimeoutSeconds * 1000 },
          retry: buildUpstreamRetryOptions(method === 'POST' && interpreterPath)
        });

        if (response.statusCode >= 500 || response.statusCode === 429) {
          logger.error(
            {
              ...requestMeta,
              statusCode: response.statusCode,
              request: requestLogContext.request
            },
            'transparent proxy upstream failure'
          );
          throw new Error(`Upstream responded with status ${response.statusCode}`);
        }

        const durationMs = Date.now() - start;

        if (logger.levelVal <= logger.levels.values.debug) {
          logger.debug(
            {
              ...requestMeta,
              statusCode: response.statusCode,
              headers: response.headers,
              responseSize: response.rawBody.length
            },
            'transparent proxy response details'
          );
        }

        logger.info(
          {
            ...requestMeta,
            statusCode: response.statusCode,
            durationMs
          },
          'transparent proxy request completed'
        );

        const contentTypeValue = response.headers?.['content-type'];
        const contentTypeHeader = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue;
        if (requestedJsonResponse && response.statusCode >= 200 && response.statusCode < 300) {
          const parsed = parseUpstreamResponse(
            response.rawBody.toString('utf8'),
            upstreamUrl.toString(),
            contentTypeHeader
          );
          reply.status(response.statusCode);
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string' && key.toLowerCase() !== 'content-type') {
              reply.header(key, value);
            }
          }
          reply.header('content-type', 'application/json');
          reply.send(parsed);
          return;
        }

        reply.status(response.statusCode);
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') {
            reply.header(key, value);
          }
        }

        reply.send(response.rawBody);
      }
    );
  } catch (error) {
    logger.error({ err: error }, 'transparent proxy upstream error');
    if (!reply.sent) {
      reply.code(502);
      reply.send({ error: 'Upstream error' });
    }
  }
};

export const createUpstreamMetricsProvider = async (
  config: AppConfig,
  redis?: Redis
): Promise<UpstreamMetricsProvider> => {
  const pool = getPool(config, redis);
  await pool.ensureReady();
  return {
    describeUpstreams: () => pool.describe(config.upstreamDailyLimit)
  };
};
