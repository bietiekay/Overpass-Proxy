import type { FastifyReply, FastifyRequest } from 'fastify';
import got from 'got';

import type { BoundingBox } from './bbox.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { OverpassResponse } from './store.js';

export const buildTileQuery = (bbox: BoundingBox): string => `[
  out:json][timeout:120];
(
  node(${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way(${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation(${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body meta;
>;
> out skel qt;`;

export const fetchTile = async (config: AppConfig, bbox: BoundingBox): Promise<OverpassResponse> => {
  const query = buildTileQuery(bbox);
  const response = await got.post(config.upstreamUrl, {
    body: new URLSearchParams({ data: query }).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: { request: 120000 }
  });

  return JSON.parse(response.body) as OverpassResponse;
};

export const proxyTransparent = async (
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig
): Promise<void> => {
  try {
    const upstreamUrl = new URL(request.url, config.upstreamUrl);
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : Buffer.isBuffer(request.body)
            ? request.body
            : request.body && typeof request.body === 'object'
              ? new URLSearchParams(request.body as Record<string, string>).toString()
              : undefined;

    const response = await got(upstreamUrl.toString(), {
      method: request.method,
      headers: { ...request.headers, host: undefined },
      body,
      throwHttpErrors: false,
      responseType: 'buffer',
      timeout: { request: 120000 }
    });

    reply.status(response.statusCode);
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        reply.header(key, value);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.send(response.rawBody);
    return;
  } catch (error) {
    logger.error({ err: error }, 'transparent proxy upstream error');
    reply.code(502);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.send({ error: 'Upstream error' });
  }
};
