import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import got, { RequestError } from 'got';
import type { Method } from 'got';

import type { BoundingBox } from './bbox.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { OverpassResponse } from './store.js';
import { startOfDayMs } from './time.js';
import type { UpstreamMetricsProvider, UpstreamStatisticsEntry } from './stats.js';

export const buildTileQuery = (bbox: BoundingBox, amenity: string): string => {
  const escapedAmenity = amenity.replace(/"/g, '\\"');
  return `[
  out:json][timeout:120];
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
const UPSTREAM_RETRY_STATUS_CODES = [408, 413, 429, 500, 502, 503, 504];
const UPSTREAM_RETRY_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED'
];
const UPSTREAM_RETRY_METHODS: Method[] = ['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'];

const buildUpstreamRetryOptions = (allowPost: boolean) => ({
  limit: UPSTREAM_RETRY_LIMIT,
  methods: allowPost ? [...UPSTREAM_RETRY_METHODS, 'POST'] : [...UPSTREAM_RETRY_METHODS],
  statusCodes: UPSTREAM_RETRY_STATUS_CODES,
  errorCodes: UPSTREAM_RETRY_ERROR_CODES
});

interface UpstreamState {
  backoffUntil: number;
  backoffAttempts: number;
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
            await this.probeUpstream(next);
          }
        })()
      );
    }
    await Promise.all(workers);
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
        state.ewmaLatencyMs = this.updateEwma(state.ewmaLatencyMs, duration);
        state.ewmaSuccess = this.updateEwma(state.ewmaSuccess, 1);
        state.lastSuccessAt = now;
        await this.save();
        return;
      }
    } catch (error) {
      logger.debug({ err: error, upstream: url }, 'probe failed');
    }

    // extend backoff a little on probe failure
    state.backoffAttempts = Math.max(1, state.backoffAttempts);
    state.backoffUntil = now + Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** state.backoffAttempts);
    state.totalFailures += 1;
    state.lastFailureAt = now;
    await this.save();
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
        reason = `in backoff until ${new Date(state.backoffUntil).toISOString()}`;
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

  markFailure(url: string): void {
    const state = this.states.get(url);
    if (!state) {
      return;
    }

    const now = Date.now();
    state.backoffAttempts += 1;
    const delayMs = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (state.backoffAttempts - 1));
    state.backoffUntil = now + delayMs;
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
        reason = `in backoff until ${new Date(state.backoffUntil).toISOString()}`;
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

const shouldMarkFailure = (error: unknown): boolean => {
  if (error instanceof RequestError) {
    const statusCode = error.response?.statusCode;
    if (statusCode !== undefined && statusCode < 500 && statusCode !== 429) {
      return false;
    }
    return true;
  }

  return true;
};

interface UpstreamCallOptions {
  redis?: Redis;
  clientKey?: string;
  logContext?: Record<string, unknown>;
}

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
      pool.markFailure(upstream);
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
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: { request: config.upstreamRequestTimeoutSeconds * 1000 },
        throwHttpErrors: true,
        retry: buildUpstreamRetryOptions(true)
      });
      logger.info({ bbox, amenity, upstreamUrl }, 'upstream fetch done');
      return JSON.parse(response.body) as OverpassResponse;
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
    const proxyOptions: UpstreamCallOptions = { ...(options ?? {}) };

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

        const headers = {
          ...request.headers,
          host: undefined
        } as Record<string, string | string[] | undefined>;

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
            headers: request.headers,
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
              headers: request.headers,
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
