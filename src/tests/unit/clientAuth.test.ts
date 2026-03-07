import { describe, expect, it } from 'vitest';

import {
  CLIENT_AUTH_HEADER,
  readClientAuthToken,
  readHeaderValue,
  sanitiseHeadersForLogs,
  stripHeader
} from '../../clientAuth.js';

describe('client auth helpers', () => {
  it('reads the client token header case-insensitively', () => {
    expect(readClientAuthToken({ [CLIENT_AUTH_HEADER]: 'secret-token' })).toBe('secret-token');
    expect(readClientAuthToken({ 'X-Overpass-Proxy-Token': 'other-token' })).toBe('other-token');
  });

  it('returns null for missing or blank client token headers', () => {
    expect(readClientAuthToken({})).toBeNull();
    expect(readClientAuthToken({ 'x-overpass-proxy-token': '   ' })).toBeNull();
  });

  it('returns the first non-empty value from array headers', () => {
    expect(
      readHeaderValue(
        { 'x-overpass-proxy-token': [' ', 'secret-token', 'another'] },
        CLIENT_AUTH_HEADER
      )
    ).toBe('secret-token');
  });

  it('masks sensitive headers when logging', () => {
    expect(
      sanitiseHeadersForLogs({
        authorization: 'Bearer abc',
        'X-Overpass-Proxy-Token': 'secret-token',
        accept: 'application/json'
      })
    ).toEqual({
      authorization: '[REDACTED]',
      'X-Overpass-Proxy-Token': '[REDACTED]',
      accept: 'application/json'
    });
  });

  it('strips the client token header before proxying upstream', () => {
    expect(
      stripHeader(
        {
          'X-Overpass-Proxy-Token': 'secret-token',
          authorization: 'Bearer abc',
          accept: 'application/json'
        },
        CLIENT_AUTH_HEADER
      )
    ).toEqual({
      authorization: 'Bearer abc',
      accept: 'application/json'
    });
  });
});
