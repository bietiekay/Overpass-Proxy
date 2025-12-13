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

  it('merges full child sets into parent geohashes before parsing', () => {
    const children = new Set(
      '0123456789bcdefghjkmnpqrstuvwxyz'.split('').map((symbol) => `u${symbol}`)
    );
    const merged = mergeGeohashes(children, 1);
    expect(merged.size).toBe(1);
    expect(Array.from(merged)[0]).toBe('u');
    const tiles = tilesForBoundingBox(boundsForHash('u'), 2);
    const mergedTiles = tiles.map((tile) => tile.hash);
    expect(new Set(mergedTiles).size).toBe(mergedTiles.length);
  });

  it('keeps requested precision for partial coverage smaller than a single geohash', () => {
    const bbox = { south: 37.7745, west: -122.4195, north: 37.7746, east: -122.4194 };
    const precision = 5;
    const tiles = tilesForBoundingBox(bbox, precision);
    const lengths = new Set(tiles.map((tile) => tile.hash.length));

    expect(lengths.size).toBe(1);
    expect(Array.from(lengths)[0]).toBe(precision);
  });
});
