import { env } from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';

const originalTransparent = env.TRANSPARENT_ONLY;
const originalTrustProxy = env.TRUST_PROXY;

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
});
