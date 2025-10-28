import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { applyConditionalHeaders, generateEtag } from '../../headers.js';

const mockReply = (): Partial<FastifyReply> & { headers: Record<string, string>; sent: boolean } => {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    sent: false,
    code: vi.fn(function (this: FastifyReply, status: number) {
      this.statusCode = status;
      return this;
    }),
    header: vi.fn(function (this: FastifyReply, key: string, value: string) {
      headers[key] = value;
      return this;
    }),
    send: vi.fn(function (this: FastifyReply) {
      (this as { sent: boolean }).sent = true;
      return this;
    }),
    headers
  } as Partial<FastifyReply> & { headers: Record<string, string>; sent: boolean };
};

describe('generateEtag', () => {
  it('generates stable weak etag', () => {
    expect(generateEtag({ foo: 'bar' })).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(generateEtag({ foo: 'bar' })).toEqual(generateEtag({ foo: 'bar' }));
  });
});

describe('applyConditionalHeaders', () => {
  it('returns 304 when etag matches', () => {
    const reply = mockReply();
    const payload = { foo: 'bar' };
    const etag = generateEtag(payload);
    const handled = applyConditionalHeaders({ headers: { 'if-none-match': etag } } as unknown as FastifyReply, reply as FastifyReply, payload);
    expect(handled).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(304);
    expect(reply.send).toHaveBeenCalled();
  });

  it('continues when etag differs', () => {
    const reply = mockReply();
    const handled = applyConditionalHeaders({ headers: {} } as unknown as FastifyReply, reply as FastifyReply, { foo: 'bar' });
    expect(handled).toBe(false);
    expect(reply.code).not.toHaveBeenCalledWith(304);
  });
});
