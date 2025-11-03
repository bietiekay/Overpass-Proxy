import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { AppConfig } from '../../config.js';
import { fetchTile } from '../../upstream.js';

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

describe('upstream failover', () => {
  const baseConfig: AppConfig = {
    port: 0,
    upstreamUrls: ['http://one.example/api/interpreter', 'http://two.example/api/interpreter'],
    redisUrl: 'redis://example',
    cacheTtlSeconds: 60,
    swrSeconds: 6,
    tilePrecision: 5,
    upstreamTilePrecision: 3,
    maxTilesPerRequest: 100,
    nodeEnv: 'test',
    upstreamFailureCooldownSeconds: 60,
    upstreamDailyLimit: -1
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
        expect.objectContaining({ headers: expect.any(Object) })
      );
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
    postMock.mockRejectedValue(new Error('fail-all'));

    try {
      const config: AppConfig = { ...baseConfig, upstreamUrls: [...baseConfig.upstreamUrls] };
      await expect(fetchTile(config, bbox, 'toilets')).rejects.toThrow('fail-all');
      expect(postMock).toHaveBeenCalledTimes(config.upstreamUrls.length);
    } finally {
      randomSpy.mockRestore();
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
});
