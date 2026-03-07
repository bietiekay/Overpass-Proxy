import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import {
  buildTileQuery,
  fetchTile,
  createUpstreamMetricsProvider,
  proxyTransparent,
  getUpstreamPoolForTesting
} from '../../upstream.js';
import { logger } from '../../logger.js';
import { InMemoryRedis } from '../helpers/inMemoryRedis.js';

const { postMock, gotMock, RequestErrorMock } = vi.hoisted(() => {
  const post = vi.fn();
  const got = vi.fn();
  got.post = post;
  class RequestErrorMock extends Error {
    response?: { statusCode: number };

    constructor(statusCode: number) {
      super(`Response code ${statusCode}`);
      this.name = 'RequestError';
      this.response = { statusCode };
    }
  }

  return { postMock: post, gotMock: got, RequestErrorMock };
});

vi.mock('got', () => ({
  __esModule: true,
  default: gotMock,
  RequestError: RequestErrorMock
}));

const baseConfig: AppConfig = {
  port: 0,
  upstreamUrls: ['http://one.example/api/interpreter', 'http://two.example/api/interpreter'],
  redisUrl: 'redis://example',
  cacheTtlSeconds: 60,
  swrSeconds: 6,
  tilePrecision: 5,
  upstreamTilePrecision: 3,
  maxTilesPerRequest: 100,
  staleRefreshCoarsePrecision: 3,
  staleRefreshTargetTilesPerRequest: 64,
  nodeEnv: 'test',
  upstreamFailureCooldownSeconds: 60,
  upstreamBackoffBaseSeconds: 1,
  upstreamBackoffMaxSeconds: 10,
  upstreamExhaustedWaitSeconds: 0,
  upstreamExhaustedGraceSeconds: 0,
  upstreamEwmaAlpha: 0.5,
  upstreamStickinessTtlSeconds: 0,
  upstreamProbeIntervalSeconds: 0,
  upstreamProbeJitterSeconds: 0,
  upstreamProbeTimeoutSeconds: 2,
  upstreamRequestTimeoutSeconds: 30,
  upstreamRecoveryCoarsePrecision: 4,
  upstreamRecoveryTargetTilesPerRequest: 8,
  upstreamDailyLimit: -1,
  transparentOnly: false,
  trustProxy: false,
  upstreamOrigin: 'https://overpass-turbo.eu',
  upstreamReferer: 'https://overpass-turbo.eu/',
  serveStaleFromCache: true,
  cacheInvalidateSecret: null,
  clientAuthToken: null
};

const mockReply = () => {
  const headers: Record<string, string> = {};
  const reply: Partial<FastifyReply> & {
    headers: Record<string, string>;
    payload?: unknown;
    sent: boolean;
    statusCode?: number;
  } = {
    headers,
    sent: false,
    statusCode: 200,
    status: vi.fn((code: number) => {
      reply.statusCode = code;
      return reply as unknown as FastifyReply;
    }),
    code: vi.fn((code: number) => {
      reply.statusCode = code;
      return reply as unknown as FastifyReply;
    }),
    header: vi.fn((key: string, value: string) => {
      headers[key] = value;
      return reply as unknown as FastifyReply;
    }),
    send: vi.fn((payload: unknown) => {
      reply.sent = true;
      reply.payload = payload;
      return reply as unknown as FastifyReply;
    })
  };

  return reply;
};

const bbox = { south: 0, west: 0, north: 1, east: 1 };

beforeEach(() => {
  postMock.mockReset();
  gotMock.mockReset();
  gotMock.post = postMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upstream failover', () => {
  it('builds tile queries with canonical Overpass settings syntax', () => {
    expect(buildTileQuery(bbox, 'toilets')).toMatch(/^\[out:json\]\[timeout:120\];/);
  });

  it('avoids retrying rate-limited responses and uses backoff delay', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      postMock.mockResolvedValue({ body: JSON.stringify({ elements: [] }) });

      await fetchTile(config, bbox, 'toilets');

      const [, options] = postMock.mock.calls[0];
      const retry = options.retry;
      expect(retry.statusCodes).not.toContain(429);

      const delay = retry.calculateDelay({
        attemptCount: 1,
        computedValue: 1,
        error: new RequestErrorMock(503)
      });
      const noDelay = retry.calculateDelay({
        attemptCount: 1,
        computedValue: 1,
        error: new RequestErrorMock(429)
      });

      expect(delay).toBeGreaterThan(0);
      expect(noDelay).toBe(0);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('propagates client errors without marking upstream as failed', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      const error = new RequestErrorMock(400);
      postMock.mockRejectedValueOnce(error);

      await expect(fetchTile(config, bbox, 'toilets')).rejects.toBe(error);

      postMock.mockClear();
      postMock.mockResolvedValueOnce({ body: JSON.stringify({ elements: ['ok'] }) });

      const result = await fetchTile(config, bbox, 'toilets');
      expect(result).toEqual({ elements: ['ok'] });
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock).toHaveBeenCalledWith(
        'http://one.example/api/interpreter',
        expect.any(Object)
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('parses responses from the first upstream', async () => {
    postMock.mockResolvedValue({ body: JSON.stringify({ elements: [] }) });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      const result = await fetchTile(config, bbox, 'toilets');

      expect(result).toEqual({ elements: [] });
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock).toHaveBeenCalledWith(
        'http://one.example/api/interpreter',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          })
        })
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('parses upstream XML responses into the JSON response model', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      postMock.mockResolvedValueOnce({
        body: `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="Overpass API">
  <note>The data included in this document is from www.openstreetmap.org.</note>
  <meta osm_base="2026-03-06T20:00:00Z" areas="2026-03-06T19:30:00Z" />
  <node id="1" lat="52.5" lon="13.4">
    <tag k="amenity" v="toilets" />
    <tag k="name" v="Cafe &amp; Bar" />
  </node>
  <way id="2">
    <nd ref="1" />
    <tag k="amenity" v="toilets" />
  </way>
  <relation id="3">
    <member type="way" ref="2" role="outer" />
    <tag k="amenity" v="toilets" />
  </relation>
</osm>`,
        headers: { 'content-type': 'text/xml; charset=utf-8' }
      });

      const result = await fetchTile(config, bbox, 'toilets');
      expect(result).toEqual({
        version: 0.6,
        generator: 'Overpass API',
        osm3s: {
          timestamp_osm_base: '2026-03-06T20:00:00Z',
          timestamp_areas_base: '2026-03-06T19:30:00Z'
        },
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 52.5,
            lon: 13.4,
            tags: { amenity: 'toilets', name: 'Cafe & Bar' }
          },
          {
            type: 'way',
            id: 2,
            nodes: [1],
            tags: { amenity: 'toilets' }
          },
          {
            type: 'relation',
            id: 3,
            members: [{ type: 'way', ref: 2, role: 'outer' }],
            tags: { amenity: 'toilets' }
          }
        ]
      });
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock).toHaveBeenCalledWith(
        'http://one.example/api/interpreter',
        expect.any(Object)
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('accepts empty upstream XML responses as valid empty results', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      postMock.mockResolvedValueOnce({
        body: `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="Overpass API">
  <note>The data included in this document is from www.openstreetmap.org.</note>
  <meta osm_base="2026-03-06T20:00:00Z" />
</osm>`,
        headers: { 'content-type': 'application/xml' }
      });

      await expect(fetchTile(config, bbox, 'toilets')).resolves.toEqual({
        version: 0.6,
        generator: 'Overpass API',
        osm3s: {
          timestamp_osm_base: '2026-03-06T20:00:00Z'
        },
        elements: []
      });
      expect(postMock).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('retries another upstream and respects cooldowns after failure', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      postMock
        .mockRejectedValueOnce(new Error('fail-one'))
        .mockResolvedValueOnce({ body: JSON.stringify({ elements: ['b'] }) });

      const result = await fetchTile(config, bbox, 'toilets');
      expect(result).toEqual({ elements: ['b'] });
      expect(postMock).toHaveBeenNthCalledWith(
        1,
        'http://one.example/api/interpreter',
        expect.any(Object)
      );
      expect(postMock).toHaveBeenNthCalledWith(
        2,
        'http://two.example/api/interpreter',
        expect.any(Object)
      );

      postMock.mockClear();
      postMock.mockResolvedValue({ body: JSON.stringify({ elements: ['c'] }) });

      const secondResult = await fetchTile(config, bbox, 'toilets');
      expect(secondResult).toEqual({ elements: ['c'] });
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock).toHaveBeenCalledWith(
        'http://two.example/api/interpreter',
        expect.any(Object)
      );

      vi.advanceTimersByTime(60000);
      postMock.mockClear();
      postMock.mockResolvedValue({ body: JSON.stringify({ elements: ['d'] }) });

      const thirdResult = await fetchTile(config, bbox, 'toilets');
      expect(thirdResult).toEqual({ elements: ['d'] });
      expect(postMock.mock.calls.map((call) => call[0])).toContain(
        'http://one.example/api/interpreter'
      );
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('throws when all upstreams fail', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const loggerErrorSpy = vi.spyOn(logger, 'error');
    postMock.mockRejectedValue(new Error('fail-all'));

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      await expect(fetchTile(config, bbox, 'toilets')).rejects.toThrow('fail-all');
      expect(postMock).toHaveBeenCalledTimes(config.upstreamUrls.length);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(3);

      const messages = loggerErrorSpy.mock.calls.map(([, message]) => message);
      expect(messages.filter((message) => message?.includes('upstream request failed'))).toHaveLength(
        config.upstreamUrls.length
      );

      const [payload, message] = loggerErrorSpy.mock.calls.at(-1) ?? [];
      expect(message).toContain('no upstream URLs available');
      expect(payload.lastError).toBe('fail-all');
      expect(payload.upstreams).toHaveLength(config.upstreamUrls.length);
      for (const entry of payload.upstreams) {
        expect(entry.reason).toContain('backoff');
        expect(entry.reason).toContain('fail-all');
      }
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('surfaces a helpful error when every upstream returns markup', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      postMock.mockResolvedValue({
        body: '<?xml version="1.0" encoding="UTF-8"?><osm><remark>runtime error: query failed</remark></osm>',
        headers: { 'content-type': 'application/xml' }
      });

      await expect(fetchTile(config, bbox, 'toilets')).rejects.toThrow(
        'Upstream returned markup instead of JSON from http://two.example/api/interpreter: runtime error: query failed'
      );
      expect(postMock).toHaveBeenCalledTimes(config.upstreamUrls.length);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('waits for a cooled-down upstream to become available again', async () => {
    vi.useFakeTimers();

    try {
      const config: AppConfig = {
        ...baseConfig,
        upstreamUrls: ['http://one.example/api/interpreter'],
        upstreamBackoffBaseSeconds: 1,
        upstreamBackoffMaxSeconds: 1,
        upstreamExhaustedWaitSeconds: 2,
        upstreamExhaustedGraceSeconds: 0
      };
      const pool = getUpstreamPoolForTesting(config);
      await (pool as unknown as { ensureReady: () => Promise<void> }).ensureReady();
      (pool as unknown as { markFailure: (url: string) => void }).markFailure(
        'http://one.example/api/interpreter'
      );

      postMock.mockResolvedValue({ body: JSON.stringify({ elements: ['after-wait'] }) });

      const pending = fetchTile(config, bbox, 'toilets');
      expect(postMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      await expect(pending).resolves.toEqual({ elements: ['after-wait'] });
      expect(postMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting once the request-side wait budget is exhausted', async () => {
    vi.useFakeTimers();

    try {
      const config: AppConfig = {
        ...baseConfig,
        upstreamUrls: ['http://one.example/api/interpreter'],
        upstreamBackoffBaseSeconds: 5,
        upstreamBackoffMaxSeconds: 5,
        upstreamExhaustedWaitSeconds: 1,
        upstreamExhaustedGraceSeconds: 0
      };
      const pool = getUpstreamPoolForTesting(config);
      await (pool as unknown as { ensureReady: () => Promise<void> }).ensureReady();
      (pool as unknown as { markFailure: (url: string) => void }).markFailure(
        'http://one.example/api/interpreter'
      );

      const pending = fetchTile(config, bbox, 'toilets');
      const rejection = expect(pending).rejects.toThrow('No upstream URLs available');
      await vi.advanceTimersByTimeAsync(1100);
      await rejection;
      expect(postMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces daily request limits per upstream', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date('2024-01-01T10:00:00Z'));
      const config: AppConfig = {
        ...baseConfig,
        upstreamUrls: ['http://limit.example/api/interpreter'],
        upstreamDailyLimit: 2
      };

      postMock.mockResolvedValue({ body: JSON.stringify({ elements: [] }) });

      await fetchTile(config, bbox, 'toilets');
      await fetchTile(config, bbox, 'toilets');

      await expect(fetchTile(config, bbox, 'toilets')).rejects.toThrow(/daily request limit/i);
      expect(postMock).toHaveBeenCalledTimes(2);

      postMock.mockClear();

      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      await expect(fetchTile(config, bbox, 'toilets')).rejects.toThrow(/daily request limit/i);
      expect(postMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60 * 60 * 1000 + 1000);
      postMock.mockResolvedValue({ body: JSON.stringify({ elements: ['after'] }) });
      const result = await fetchTile(config, bbox, 'toilets');
      expect(result).toEqual({ elements: ['after'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies client stickiness when enabled', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.99);
    postMock.mockResolvedValue({ body: JSON.stringify({ elements: [] }) });

    const config: AppConfig = {
      ...baseConfig,
      upstreamStickinessTtlSeconds: 120
    };

    await fetchTile(config, bbox, 'toilets', { clientKey: 'client-a' });
    postMock.mockClear();
    postMock.mockResolvedValue({ body: JSON.stringify({ elements: ['again'] }) });
    await fetchTile(config, bbox, 'toilets', { clientKey: 'client-a' });

    const urls = postMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['http://one.example/api/interpreter']);
    randomSpy.mockRestore();
  });

  it('backs off exponentially after repeated failures', async () => {
    vi.useFakeTimers();
    const redis = new InMemoryRedis();
    const config: AppConfig = {
      ...baseConfig,
      upstreamUrls: ['http://one.example/api/interpreter'],
      upstreamBackoffBaseSeconds: 1,
      upstreamBackoffMaxSeconds: 8,
      upstreamStickinessTtlSeconds: 0
    };

    postMock.mockRejectedValueOnce(new Error('fail-one'));
    await expect(fetchTile(config, bbox, 'toilets', { redis })).rejects.toThrow('fail-one');
    const provider = await createUpstreamMetricsProvider(config, redis);
    const first = provider.describeUpstreams()[0];
    expect(first.status).toBe('cooldown');
    const firstRetry = new Date(first.backoffUntil ?? '').getTime();

    vi.advanceTimersByTime(1100);
    postMock.mockRejectedValueOnce(new Error('fail-two'));
    await expect(fetchTile(config, bbox, 'toilets', { redis })).rejects.toThrow('fail-two');
    const second = provider.describeUpstreams()[0];
    const secondRetry = new Date(second.backoffUntil ?? '').getTime();
    expect(secondRetry).toBeGreaterThan(firstRetry);
    vi.useRealTimers();
  });

  it('persists upstream state to redis for statistics', async () => {
    vi.useFakeTimers();
    const redis = new InMemoryRedis();
    const config: AppConfig = {
      ...baseConfig,
      upstreamUrls: ['http://persist.example/api'],
      upstreamBackoffBaseSeconds: 1,
      upstreamStickinessTtlSeconds: 0
    };

    postMock.mockRejectedValueOnce(new Error('persist-failure'));
    await expect(fetchTile(config, bbox, 'toilets', { redis })).rejects.toThrow('persist-failure');

    const provider = await createUpstreamMetricsProvider(config, redis);
    expect(provider.describeUpstreams()[0].status).toBe('cooldown');
    expect(provider.describeUpstreams()[0].backoffReason).toBe('persist-failure');

    const configClone: AppConfig = { ...config };
    const restoredProvider = await createUpstreamMetricsProvider(configClone, redis);
    const restored = restoredProvider.describeUpstreams()[0];
    expect(restored.status).toBe('cooldown');
    expect(restored.backoffUntil).toBeDefined();
    expect(restored.backoffReason).toBe('persist-failure');
    vi.useRealTimers();
  });

  it('times out stalled probes to avoid blocking the probe loop', async () => {
    vi.useFakeTimers();
    try {
      const config: AppConfig = {
        ...baseConfig,
        upstreamUrls: ['http://probe.example/api'],
        upstreamProbeIntervalSeconds: 0,
        upstreamProbeTimeoutSeconds: 1,
        upstreamStickinessTtlSeconds: 0
      };

      const pool = getUpstreamPoolForTesting(config);
      await (pool as unknown as { ensureReady: () => Promise<void> }).ensureReady();
      const poolWithFailure = pool as unknown as {
        markFailure: (url: string) => void;
        probeOnce: () => Promise<void>;
        probeUpstream: (url: string) => Promise<void>;
      };

      poolWithFailure.markFailure('http://probe.example/api');
      const probeSpy = vi
        .spyOn(poolWithFailure, 'probeUpstream')
        .mockImplementation(() => new Promise(() => {}));

      const probePromise = poolWithFailure.probeOnce();
      await vi.advanceTimersByTimeAsync(1100);
      await expect(probePromise).resolves.toBeUndefined();
      expect(probeSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('proxyTransparent', () => {
  it('re-encodes interpreter GET requests as form POST with client headers', async () => {
    const rawBody = Buffer.from(JSON.stringify({ elements: [] }));
    gotMock.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      rawBody
    });

    const request = {
      method: 'GET',
      url: '/api/interpreter?data=[out:json];node(1,1,2,2);out;',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json'
      },
      ip: '127.0.0.1'
    };

    const reply = mockReply();

    await proxyTransparent(request as unknown as FastifyRequest, reply as FastifyReply, {
      ...baseConfig,
      upstreamUrls: ['http://one.example/api/interpreter']
    });

    expect(gotMock).toHaveBeenCalledTimes(1);
    const [, options] = gotMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.body.toString()).toContain('data=');
    expect(options.headers['content-type']).toBe(
      'application/x-www-form-urlencoded; charset=UTF-8'
    );
    expect(options.headers['accept']).toBe('*/*');
    expect(options.headers['accept-language']).toBe('en-US,en;q=0.9');
    expect(reply.statusCode).toBe(200);
    expect(reply.sent).toBe(true);
    expect(reply.payload).toEqual({ elements: [] });
  });

  it('normalises interpreter XML responses to JSON when the client requested out:json', async () => {
    gotMock.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', etag: '"upstream-etag"' },
      rawBody: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="Overpass API">
  <meta osm_base="2026-03-06T20:00:00Z" />
  <node id="1" lat="52.5" lon="13.4">
    <tag k="amenity" v="toilets" />
  </node>
</osm>`)
    });

    const request = {
      method: 'GET',
      url: '/api/interpreter?data=[out:json];node(1,1,2,2);out;',
      headers: {
        accept: 'application/json'
      },
      ip: '127.0.0.1'
    };

    const reply = mockReply();

    await proxyTransparent(request as unknown as FastifyRequest, reply as FastifyReply, {
      ...baseConfig,
      upstreamUrls: ['http://one.example/api/interpreter']
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.headers.etag).toBe('"upstream-etag"');
    expect(reply.payload).toEqual({
      version: 0.6,
      generator: 'Overpass API',
      osm3s: {
        timestamp_osm_base: '2026-03-06T20:00:00Z'
      },
      elements: [{ type: 'node', id: 1, lat: 52.5, lon: 13.4, tags: { amenity: 'toilets' } }]
    });
  });

  it('adds missing interpreter browser headers when absent', async () => {
    const rawBody = Buffer.from(JSON.stringify({ elements: [] }));
    gotMock.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      rawBody
    });

    const request = {
      method: 'POST',
      url: '/api/interpreter',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: 'data=[out:json];node(1,1,2,2);out;',
      ip: '127.0.0.1'
    };

    const reply = mockReply();

    await proxyTransparent(request as unknown as FastifyRequest, reply as FastifyReply, {
      ...baseConfig,
      upstreamUrls: ['http://one.example/api/interpreter']
    });

    const [, options] = gotMock.mock.calls[0];
    expect(options.headers['origin']).toBe('https://overpass-turbo.eu');
    expect(options.headers['referer']).toBe('https://overpass-turbo.eu/');
    expect(options.headers['user-agent']).toMatch(/Mozilla\/5\.0/);
    expect(options.headers['sec-ch-ua']).toContain('Chromium');
    expect(options.headers['sec-fetch-mode']).toBe('cors');
    expect(options.headers['priority']).toBe('u=1, i');
    expect(reply.payload).toEqual({ elements: [] });
  });

  it('does not forward the client auth header upstream', async () => {
    const rawBody = Buffer.from(JSON.stringify({ elements: [] }));
    gotMock.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      rawBody
    });

    const request = {
      method: 'GET',
      url: '/api/status',
      headers: {
        'x-overpass-proxy-token': 'shared-secret',
        authorization: 'Bearer token123',
        accept: 'application/json'
      },
      ip: '127.0.0.1'
    };

    const reply = mockReply();

    await proxyTransparent(request as unknown as FastifyRequest, reply as FastifyReply, {
      ...baseConfig,
      upstreamUrls: ['http://one.example/api/status']
    });

    const [, options] = gotMock.mock.calls[0];
    expect(options.headers['x-overpass-proxy-token']).toBeUndefined();
    expect(options.headers.authorization).toBe('Bearer token123');
    expect(options.headers.accept).toBe('application/json');
  });
});
