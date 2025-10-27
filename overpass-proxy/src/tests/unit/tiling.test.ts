import { describe, expect, it } from 'vitest';

import { tilesForBoundingBox } from '../../tiling.js';

describe('tilesForBoundingBox', () => {
  it('returns tiles covering bbox', () => {
    const tiles = tilesForBoundingBox({ south: 52.5, west: 13.3, north: 52.6, east: 13.4 }, 7);
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((tile) => {
      expect(tile.hash).toMatch(/^[0123456789bcdefghjkmnpqrstuvwxyz]+$/);
    });
  });

  it('deduplicates overlapping tiles', () => {
    const tiles = tilesForBoundingBox({ south: 0, west: 0, north: 0.0001, east: 0.0001 }, 7);
    const hashes = tiles.map((tile) => tile.hash);
    expect(new Set(hashes).size).toEqual(hashes.length);
  });
});
