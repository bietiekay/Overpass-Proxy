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

  reply.header('ETag', etag);

  if (incoming && incoming.split(',').map((value) => value.trim()).includes(etag)) {
    reply.code(304);
    reply.send();
    return true;
  }

  return false;
};
