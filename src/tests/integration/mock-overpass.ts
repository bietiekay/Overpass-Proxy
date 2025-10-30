import formbody from '@fastify/formbody';
import Fastify, { type FastifyRequest } from 'fastify';

import type { BoundingBox } from '../../bbox.js';
import { extractAmenityValue, extractBoundingBox } from '../../bbox.js';

const buildResponse = (bbox: BoundingBox, amenity: string) => ({
  version: 0.6,
  generator: 'mock-overpass',
  osm3s: {
    timestamp_osm_base: new Date().toISOString()
  },
  elements: [
    {
      type: 'node',
      id: 1,
      lat: bbox.south,
      lon: bbox.west,
      tags: { amenity, mock: 'true' }
    },
    {
      type: 'node',
      id: 2,
      lat: bbox.north,
      lon: bbox.east,
      tags: { amenity, mock: 'true' }
    }
  ]
});

export const createMockOverpass = () => {
  const app = Fastify();
  void app.register(formbody);
  const hits: string[] = [];

  app.all('/api/interpreter', async (request, reply) => {
    const formBody = (request as FastifyRequest<{ Body: { data?: string } }>).body;
    const query =
      typeof request.body === 'string'
        ? request.body
        : typeof formBody?.data === 'string'
          ? formBody.data
          : '';
    // For compatibility tests, accept all queries and build a synthetic response if possible

    const bbox = extractBoundingBox(query);
    if (!bbox) {
      reply.type('application/json');
      reply.send({});
      return;
    }

    const amenity =
      extractAmenityValue(query) ??
      (typeof formBody?.amenity === 'string' && formBody.amenity.trim().length > 0
        ? formBody.amenity.trim()
        : 'toilets');

    hits.push(`${bbox.south},${bbox.west},${bbox.north},${bbox.east}:${amenity}`);
    reply.type('application/json');
    reply.send(buildResponse(bbox, amenity));
  });

  return {
    app,
    hits,
    start: async (port: number) => {
      await app.listen({ port, host: '0.0.0.0' });
    },
    stop: async () => {
      await app.close();
    }
  };
};

if (process.argv[1] && process.argv[1].endsWith('mock-overpass.ts')) {
  const server = createMockOverpass();
  const port = Number(process.env.PORT ?? 8081);
  server.start(port).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
