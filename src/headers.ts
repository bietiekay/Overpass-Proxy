/* eslint-disable @typescript-eslint/no-floating-promises */
import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

export const generateEtag = (payload: unknown): string => {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const digest = createHash('sha1').update(data).digest('hex');
  return `W/"${digest}"`;
};

export const applyConditionalHeaders = (
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): boolean => {
  const etag = generateEtag(payload);
  const incoming = request.headers['if-none-match'];

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  reply.header('ETag', etag);

    if (incoming && incoming.split(',').map((value) => value.trim()).includes(etag)) {
      reply.code(304);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      reply.send();
      return true;
    }

  return false;
};
