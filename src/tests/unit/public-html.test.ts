import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workspacePath = process.cwd();

describe('public HTML tools', () => {
  it('send the optional client token header in operator tools', async () => {
    const [statisticsMap, cachePreheater, cacheInvalidator] = await Promise.all([
      readFile(resolve(workspacePath, 'public', 'statistics-map.html'), 'utf8'),
      readFile(resolve(workspacePath, 'public', 'cache-preheater.html'), 'utf8'),
      readFile(resolve(workspacePath, 'public', 'cache-invalidator.html'), 'utf8')
    ]);

    for (const html of [statisticsMap, cachePreheater, cacheInvalidator]) {
      expect(html).toContain('X-Overpass-Proxy-Token');
    }

    expect(statisticsMap).toContain('id="client-token"');
    expect(cachePreheater).toContain('id="clientToken"');
    expect(cacheInvalidator).toContain('id="client-token"');
  });
});
