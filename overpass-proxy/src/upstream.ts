import type { FastifyReply, FastifyRequest } from 'fastify';
import got from 'got';
import type { Method } from 'got';

import type { BoundingBox } from './bbox.js';
import type { AppConfig } from './config.js';
import { logger } from './logger.js';
import type { OverpassResponse } from './store.js';

export const buildTileQuery = (bbox: BoundingBox): string => `[
  out:json][timeout:120];
(
  node["amenity"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["amenity"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["amenity"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body meta;
>;
out skel qt;`;

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
    let body: string | Buffer | undefined;
    let bodyReencoded = false;

    if (request.method === 'GET' || request.method === 'HEAD') {
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
    if (bodyReencoded) {
      delete headers['content-length'];
      delete headers['Content-Length'];
    }

    const response = await got(upstreamUrl.toString(), {
      method: request.method as Method,
      headers,
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
