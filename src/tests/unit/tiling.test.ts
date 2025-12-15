import { describe, expect, it } from 'vitest';

import { boundsForHash, mergeGeohashes, tilesForBoundingBox } from '../../tiling.js';

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

  it('keeps the configured precision to avoid collapsing refreshed tiles', () => {
    const tiles = tilesForBoundingBox(boundsForHash('u'), 2);
    const precisions = new Set(tiles.map((tile) => tile.hash.length));
    expect(precisions).toEqual(new Set([2]));
    expect(tiles.length).toBeGreaterThan(1);
  });
});

describe('mergeGeohashes', () => {
  it('merges full child sets into parent geohashes before parsing', () => {
    const children = new Set(
      '0123456789bcdefghjkmnpqrstuvwxyz'.split('').map((symbol) => `u${symbol}`)
    );
    const merged = mergeGeohashes(children, 1);
    expect(merged.size).toBe(1);
    expect(Array.from(merged)[0]).toBe('u');
  });
});
