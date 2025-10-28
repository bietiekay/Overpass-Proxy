import { describe, expect, it } from 'vitest';

import { planTileFetches } from '../../fetchPlan.js';
import type { BoundingBox } from '../../bbox.js';
import { tilesForBoundingBox } from '../../tiling.js';

const bbox: BoundingBox = { south: 0, west: 0, north: 5, east: 5 };
const tilePrecision = 5;
const coarsePrecision = 3;

describe('planTileFetches', () => {
  it('returns a single group for a single tile', () => {
    const allTiles = tilesForBoundingBox(bbox, tilePrecision);
    const first = allTiles[0];
    expect(first).toBeDefined();

    const groups = planTileFetches([first], { coarsePrecision, finePrecision: tilePrecision, targetTilesPerRequest: 16 });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tiles).toHaveLength(1);
    expect(groups[0]?.tiles[0]).toBe(first);
    expect(groups[0]?.bounds).toEqual(first.bounds);
  });

  it('merges nearby tiles within the same coarse prefix', () => {
    const allTiles = tilesForBoundingBox(bbox, tilePrecision);
    const grouped = allTiles.reduce<Record<string, typeof allTiles>>((acc, tile) => {
      const prefix = tile.hash.slice(0, coarsePrecision);
      acc[prefix] = acc[prefix] ? [...acc[prefix], tile] : [tile];
      return acc;
    }, {});

    const multiPrefix = Object.values(grouped).find((tiles) => tiles.length >= 2);
    expect(multiPrefix).toBeDefined();
    const [base, samePrefix] = multiPrefix!;

    const groups = planTileFetches([base, samePrefix], {
      coarsePrecision,
      finePrecision: tilePrecision,
      targetTilesPerRequest: 16
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tiles.map((tile) => tile.hash).sort()).toEqual([base.hash, samePrefix.hash].sort());
    expect(groups[0]?.bounds.south).toBeLessThanOrEqual(Math.max(base.bounds.south, samePrefix.bounds.south));
    expect(groups[0]?.bounds.north).toBeGreaterThanOrEqual(Math.min(base.bounds.north, samePrefix.bounds.north));
  });

  it('keeps tiles from different coarse prefixes separate', () => {
    const allTiles = tilesForBoundingBox(bbox, tilePrecision);
    const first = allTiles[0];
    const differentPrefix = allTiles.find((tile) => tile.hash.slice(0, coarsePrecision) !== first.hash.slice(0, coarsePrecision));
    expect(first).toBeDefined();
    expect(differentPrefix).toBeDefined();

    const groups = planTileFetches([first, differentPrefix!], {
      coarsePrecision,
      finePrecision: tilePrecision,
      targetTilesPerRequest: 16
    });

    expect(groups).toHaveLength(2);
    const hashes = groups.flatMap((group) => group.tiles.map((tile) => tile.hash));
    expect(hashes.sort()).toEqual([first.hash, differentPrefix!.hash].sort());
  });
});
