import { env } from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';

const originalTransparent = env.TRANSPARENT_ONLY;
const originalTrustProxy = env.TRUST_PROXY;
const originalOrigin = env.UPSTREAM_ORIGIN;
const originalReferer = env.UPSTREAM_REFERER;
const originalTimeout = env.UPSTREAM_REQUEST_TIMEOUT_SECONDS;
const originalClientAuthToken = env.CLIENT_AUTH_TOKEN;

describe('loadConfig transparentOnly flag', () => {
  beforeEach(() => {
    if (originalTransparent === undefined) {
      delete env.TRANSPARENT_ONLY;
    } else {
      env.TRANSPARENT_ONLY = originalTransparent;
    }
    if (originalTrustProxy === undefined) {
      delete env.TRUST_PROXY;
    } else {
      env.TRUST_PROXY = originalTrustProxy;
    }
    if (originalOrigin === undefined) {
      delete env.UPSTREAM_ORIGIN;
    } else {
      env.UPSTREAM_ORIGIN = originalOrigin;
    }
    if (originalReferer === undefined) {
      delete env.UPSTREAM_REFERER;
    } else {
      env.UPSTREAM_REFERER = originalReferer;
    }
    if (originalTimeout === undefined) {
      delete env.UPSTREAM_REQUEST_TIMEOUT_SECONDS;
    } else {
      env.UPSTREAM_REQUEST_TIMEOUT_SECONDS = originalTimeout;
    }
    if (originalClientAuthToken === undefined) {
      delete env.CLIENT_AUTH_TOKEN;
    } else {
      env.CLIENT_AUTH_TOKEN = originalClientAuthToken;
    }
  });

  afterEach(() => {
    if (originalTransparent === undefined) {
      delete env.TRANSPARENT_ONLY;
    } else {
      env.TRANSPARENT_ONLY = originalTransparent;
    }
    if (originalTrustProxy === undefined) {
      delete env.TRUST_PROXY;
    } else {
      env.TRUST_PROXY = originalTrustProxy;
    }
    if (originalOrigin === undefined) {
      delete env.UPSTREAM_ORIGIN;
    } else {
      env.UPSTREAM_ORIGIN = originalOrigin;
    }
    if (originalReferer === undefined) {
      delete env.UPSTREAM_REFERER;
    } else {
      env.UPSTREAM_REFERER = originalReferer;
    }
    if (originalTimeout === undefined) {
      delete env.UPSTREAM_REQUEST_TIMEOUT_SECONDS;
    } else {
      env.UPSTREAM_REQUEST_TIMEOUT_SECONDS = originalTimeout;
    }
    if (originalClientAuthToken === undefined) {
      delete env.CLIENT_AUTH_TOKEN;
    } else {
      env.CLIENT_AUTH_TOKEN = originalClientAuthToken;
    }
  });

  it('defaults to caching mode when env not set', () => {
    delete env.TRANSPARENT_ONLY;
    const config = loadConfig();
    expect(config.transparentOnly).toBe(false);
  });

  it('enables transparent mode for true-like values', () => {
    env.TRANSPARENT_ONLY = 'TRUE';
    const config = loadConfig();
    expect(config.transparentOnly).toBe(true);
  });

  it('treats false-like values as disabled', () => {
    env.TRANSPARENT_ONLY = '0';
    const config = loadConfig();
    expect(config.transparentOnly).toBe(false);
  });

  it('enables proxy trust for true-like values', () => {
    env.TRUST_PROXY = 'true';
    const config = loadConfig();
    expect(config.trustProxy).toBe(true);
  });

  it('disables proxy trust for false-like values', () => {
    env.TRUST_PROXY = 'no';
    const config = loadConfig();
    expect(config.trustProxy).toBe(false);
  });

  it('uses default origin and referer when unset', () => {
    delete env.UPSTREAM_ORIGIN;
    delete env.UPSTREAM_REFERER;
    const config = loadConfig();
    expect(config.upstreamOrigin).toBe('https://overpass-turbo.eu');
    expect(config.upstreamReferer).toBe('https://overpass-turbo.eu/');
    expect(config.upstreamRequestTimeoutSeconds).toBe(30);
  });

  it('reads origin and referer from env when provided', () => {
    env.UPSTREAM_ORIGIN = 'https://example.com';
    env.UPSTREAM_REFERER = 'https://example.com/';
    env.UPSTREAM_REQUEST_TIMEOUT_SECONDS = '15';
    const config = loadConfig();
    expect(config.upstreamOrigin).toBe('https://example.com');
    expect(config.upstreamReferer).toBe('https://example.com/');
    expect(config.upstreamRequestTimeoutSeconds).toBe(15);
  });

  it('keeps client auth disabled when env is unset', () => {
    delete env.CLIENT_AUTH_TOKEN;
    const config = loadConfig();
    expect(config.clientAuthToken).toBeNull();
  });

  it('keeps client auth disabled when env is blank', () => {
    env.CLIENT_AUTH_TOKEN = '   ';
    const config = loadConfig();
    expect(config.clientAuthToken).toBeNull();
  });

  it('reads and trims the client auth token', () => {
    env.CLIENT_AUTH_TOKEN = '  shared-secret  ';
    const config = loadConfig();
    expect(config.clientAuthToken).toBe('shared-secret');
  });
});
